/**
 * Die REINE Ableitung des **Funktions-Zustands** je Standort und der
 * **Teilnahme** je Anlage (UEMS AP-01 IP-1; Regeln im AP-01-Konzept §4.2–§4.7,
 * Entscheide E6 = C, E7, E8, E9, Auflösungen W3, W5, W7).
 *
 * Der Funktions-Zustand ist ein OBJEKT-Zustand aus Fakten, kein
 * Absichts-Schalter (W3): er entsteht bei jedem Lesen neu aus Bestandsfakten
 * (Betriebsmodell an, Freigaben, Scharfschaltung, Ruhe-Eintrag) und der
 * Prüfliste. „liefert Daten" und „steuert" kommen aus `uemsZustand.ts` — hier
 * wird nichts davon nachgebaut.
 *
 * Der Zwilling im Server ist `services/api .../uems/FunktionZustandAbleitung`;
 * beide fahren dieselben Vektoren
 * (`docs/contracts/v2/funktion-zustand-vectors.json`).
 * **Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.**
 *
 * ⚠ **Noch ruft niemand an.** Keine Fläche ist umgestellt; dieses Modul ist der
 * Vertrag, gegen den die Endpunkte (IP-3) und Flächen (IP-8/IP-11) gebaut werden.
 *
 * ## Die Rangfolge
 *
 * ```
 *   kein_objekt < archiviert < entwurf < eingerichtet < angehalten < aktiv
 * ```
 *
 * Der Standort trägt den HÖCHSTEN Zustand seiner Teilnahmen (W7). angehalten
 * schlägt eingerichtet — „angehalten, solange keine Anlage aktiv teilnimmt"
 * (A4); archiviert liegt unter entwurf — eine neue Aufnahme nach dem Beenden ist
 * eine neue Einrichtung.
 *
 * ## Die Naht zu „steuert"
 *
 * Die Beobachtung wird mit `steuert()` gebildet, aber mit
 * `ruheEintrag = (Zustand angehalten)` — nie mit dem rohen Ruhe-Eintrag. Vor dem
 * Start trägt jede Anlage die Ruhe R0 ohne Ende; der Kunde soll dort „noch nicht
 * gestartet" lesen, nicht „angehalten".
 */
import {
  VORGABE_ZEITZONE,
  aggregatLiefertDaten,
  aufzaehlung,
  liefertDaten,
  liefertDatenAnlage,
  steuert,
  zeitpunktText,
  type AnlageErgebnis,
  type BoxZustand,
  type LiefertDatenZustand,
  type SteuertErgebnis,
} from './uemsZustand';

// ───────────────────────────────────────────────────────────────── Vokabular

export type FunktionCode = 'messen' | 'steuern';

/** Die zwei Funktionen, je mit ihrem Kundenwort. */
export const FUNKTIONEN: Record<FunktionCode, string> = {
  messen: 'Messen & Auswerten',
  steuern: 'Steuern & Optimieren',
};

/** Das E8-Vokabular plus „kein Objekt" — AUFSTEIGEND nach Rang (die Reihenfolge IST die Regel). */
export const ZUSTAENDE = [
  'kein_objekt',
  'archiviert',
  'entwurf',
  'eingerichtet',
  'angehalten',
  'aktiv',
] as const;

export type FunktionZustand = (typeof ZUSTAENDE)[number];

/** Die Zeilen der Prüfliste vor dem Start, in der Reihenfolge von AP-01 §5.3 Schritt 5. */
export const PRUEFUNGEN = [
  'box',
  'freigabe',
  'verbindungstest',
  'grenze',
  'hauptzaehler',
  'betriebsweise',
] as const;

export type Pruefung = (typeof PRUEFUNGEN)[number];

/** Was der Kunde auslöst. */
export const AKTIONEN = [
  'aufnehmen',
  'einrichten',
  'starten',
  'anhalten',
  'fortsetzen',
  'beenden',
] as const;

export type Aktion = (typeof AKTIONEN)[number];

/** Warum ein Übergang abgelehnt wird — je Grund GENAU EIN Kundensatz. */
export const GRUND_TEXT = {
  nicht_aufgenommen: 'Nimmt noch nicht an Steuern & Optimieren teil',
  bereits_aufgenommen: 'Nimmt bereits an Steuern & Optimieren teil',
  /** Sein Satz wird um „ — es fehlt: …" ergänzt. */
  pruefliste_offen: 'Noch nicht möglich',
  noch_nicht_gestartet: 'Steuerung noch nicht gestartet',
  laeuft_bereits: 'Steuerung läuft bereits',
  ist_angehalten: 'Steuerung angehalten — fortsetzen statt neu starten',
  bereits_angehalten: 'Steuerung bereits angehalten',
  beendet: 'Steuerung beendet — ein Neubeginn ist eine neue Einrichtung',
  bereits_angelegt: 'Messen & Auswerten ist hier bereits angelegt',
  standort_archiviert: 'Der Standort ist archiviert',
  startet_automatisch: 'Messen & Auswerten startet mit der Einrichtung von selbst',
  nicht_als_ganzes:
    'Messen & Auswerten wird nicht als Ganzes angehalten — angehalten wird je Messstelle',
  nur_mit_dem_standort: 'Messen & Auswerten endet mit dem Archivieren des Standorts',
} as const;

export type UebergangGrund = keyof typeof GRUND_TEXT;

const RANG: Record<FunktionZustand, number> = Object.fromEntries(
  ZUSTAENDE.map((z, i) => [z, i]),
) as Record<FunktionZustand, number>;

// ─────────────────────────────────────────────────────────── Teilnahme je Anlage

/** `ende: null` = ohne Enddatum: die Ruhe R0 vor dem Start oder das Anhalten (E7). */
export interface RuheEintrag {
  seit: string;
  /** Mit Ende ist es ein Handeingriff (S7), kein Anhalten. */
  ende: string | null;
}

/** Der Hauptzähler der Anlage mit seinem Kennzeichen und seinem Zustand „liefert Daten". */
export interface Hauptzaehler {
  kennzeichen: string;
  zustand: LiefertDatenZustand;
  seit: string | null;
}

/** Eine steuerbare Komponente der Anlage. */
export interface Komponente {
  name: string;
  /** verbraucher braucht eine Steuerart; speicher (Wechselrichter/Speicher) ein Betriebsmodell. */
  art: 'verbraucher' | 'speicher';
  /** Die Freigabe-Zeile; beim Wechselrichter Zertifizierung UND Scharfschaltung (VoltPilot). */
  freigegeben: boolean;
  verbindungstestBestanden: boolean;
  /** Die Steuerart eines Verbrauchers; null = keine gewählt. */
  steuerart: string | null;
}

/** Was die Box gerade ausführt — nur für die Beobachtung „steuert". */
export interface Ausfuehrung {
  laeuft: boolean;
  laeuftArt: 'betriebsmodell' | 'regel' | null;
  laeuftName: string | null;
  boxBestaetigt: boolean;
}

/** Die Fakten EINER Anlage zu „Steuern & Optimieren". */
export interface TeilnahmeEingang {
  anlage: string;
  /** Ob die Teilnahme existiert („Anlage aufnehmen" ist geschehen). */
  aufgenommen: boolean;
  /** Wann die Prüfliste grün wurde; nur für den Satz, null = unbekannt. */
  eingerichtetAm: string | null;
  /** „Steuerung starten"; null = nie gestartet. */
  gestartetAm: string | null;
  /** Aus dem Bestand abgeleitet (W5). */
  uebernommen: boolean;
  ruheEintrag: RuheEintrag | null;
  /** „Steuerung beenden"; null = nicht beendet. */
  beendetAm: string | null;
  boxen: BoxZustand[];
  /** null, wenn keiner zugeordnet ist. */
  hauptzaehler: Hauptzaehler | null;
  komponenten: Komponente[];
  /** Die Betriebsmodell-WAHL für den Speicher; null = keine. */
  betriebsmodell: string | null;
  grenzePlausibel: boolean;
  /** null = die Beobachtung ist nicht gefragt. */
  ausfuehrung: Ausfuehrung | null;
  jetzt: string;
  zeitzone?: string;
}

/** Eine Zeile der Prüfliste; `bestanden: null` heißt „nicht prüfbar", nie „bestanden". */
export interface PruefZeile {
  pruefung: Pruefung;
  bestanden: boolean | null;
}

export interface TeilnahmeErgebnis {
  zustand: FunktionZustand;
  seit: string | null;
  /** Nur in entwurf, eingerichtet und angehalten — dort entscheidet sie über Start und Fortsetzen. */
  pruefliste: PruefZeile[];
  /** Je roter Zeile, WAS fehlt (W3), mit dem Namen des Objekts. */
  fehlt: string[];
  text: string;
  /** Die Beobachtung aus `steuert()`; null ohne `ausfuehrung`. */
  steuert: SteuertErgebnis | null;
}

/** Die Teilnahme einer Anlage — was sie gerade ist und was die Standort-Ableitung braucht. */
export function teilnahme(e: TeilnahmeEingang): TeilnahmeErgebnis {
  const zone = e.zeitzone ?? VORGABE_ZEITZONE;
  let zustand: FunktionZustand | null;
  if (!e.aufgenommen) zustand = 'kein_objekt';
  else if (e.beendetAm !== null) zustand = 'archiviert';
  else if (e.gestartetAm !== null) {
    zustand = e.ruheEintrag !== null && e.ruheEintrag.ende === null ? 'angehalten' : 'aktiv';
  } else zustand = null; // entscheidet die Prüfliste

  let pruefliste: PruefZeile[] = [];
  let fehlt: string[] = [];
  if (zustand === null || zustand === 'angehalten') {
    ({ pruefliste, fehlt } = pruefe(e, zone));
    if (zustand === null) {
      zustand =
        fehlt.length === 0 && pruefliste.every((z) => z.bestanden === true)
          ? 'eingerichtet'
          : 'entwurf';
    }
  }

  const seit =
    zustand === 'eingerichtet'
      ? e.eingerichtetAm
      : zustand === 'aktiv'
        ? e.gestartetAm
        : zustand === 'angehalten'
          ? e.ruheEintrag!.seit
          : zustand === 'archiviert'
            ? e.beendetAm
            : null;

  let text: string;
  switch (zustand) {
    case 'kein_objekt':
      text = 'Diese Anlage misst nur';
      break;
    case 'entwurf':
      text = fehltSatz('Noch nicht eingerichtet', fehlt);
      break;
    case 'eingerichtet':
      text = eingerichtetSatz(seit, zone);
      break;
    case 'aktiv':
      text =
        (seit === null ? 'Gestartet' : `Gestartet am ${datum(seit, zone)}`) +
        (e.uebernommen ? ' (übernommen)' : '');
      break;
    case 'angehalten':
      text = mitDatum('Angehalten seit ', 'Angehalten', seit, zone);
      break;
    case 'archiviert':
      text = mitDatum('Steuerung beendet am ', 'Steuerung beendet', seit, zone);
      break;
  }
  return { zustand, seit, pruefliste, fehlt, text, steuert: beobachtung(e, zustand) };
}

/**
 * Die sechs Zeilen der Prüfliste. Box und Hauptzähler kommen aus EINEM Aufruf
 * von `liefertDatenAnlage`: eine stumme Box erklärt den stillen Zähler, dessen
 * Zeile ist dann nicht prüfbar. Test und Betriebsweise hängen an den
 * freigegebenen Komponenten; ohne Freigabe sind sie nicht prüfbar.
 */
function pruefe(e: TeilnahmeEingang, zone: string): { pruefliste: PruefZeile[]; fehlt: string[] } {
  const zeilen: PruefZeile[] = [];
  const fehlt: string[] = [];
  const messung = liefertDatenAnlage({
    boxen: e.boxen,
    hauptzaehler:
      e.hauptzaehler === null ? null : { zustand: e.hauptzaehler.zustand, seit: e.hauptzaehler.seit },
    jetzt: e.jetzt,
    zeitzone: zone,
  });
  const boxFehlt = messung.grund === 'keine_box' || messung.grund === 'box_meldet_sich_nicht';

  zeilen.push({ pruefung: 'box', bestanden: !boxFehlt });
  if (messung.grund === 'keine_box') fehlt.push(`Box ${e.anlage}`);
  else if (messung.grund === 'box_meldet_sich_nicht') {
    for (const b of e.boxen) if (!b.verbunden) fehlt.push(`Verbindung ${b.name}`);
  }

  const freigegeben = e.komponenten.filter((k) => k.freigegeben);
  const freigabe = freigegeben.length > 0;
  zeilen.push({ pruefung: 'freigabe', bestanden: freigabe });
  if (!freigabe) fehlt.push(`Steuer-Freigabe ${e.anlage}`);

  if (!freigabe) zeilen.push({ pruefung: 'verbindungstest', bestanden: null });
  else {
    let alle = true;
    for (const k of freigegeben) {
      if (!k.verbindungstestBestanden) {
        alle = false;
        fehlt.push(`Verbindungstest ${k.name}`);
      }
    }
    zeilen.push({ pruefung: 'verbindungstest', bestanden: alle });
  }

  zeilen.push({ pruefung: 'grenze', bestanden: e.grenzePlausibel });
  if (!e.grenzePlausibel) fehlt.push(`plausible Grenze ${e.anlage}`);

  if (boxFehlt) zeilen.push({ pruefung: 'hauptzaehler', bestanden: null });
  else {
    zeilen.push({ pruefung: 'hauptzaehler', bestanden: messung.liefert });
    if (!messung.liefert) fehlt.push(hauptzaehlerFehlt(e, messung, zone));
  }

  if (!freigabe) zeilen.push({ pruefung: 'betriebsweise', bestanden: null });
  else {
    let gewaehlt = true;
    let speicher = false;
    for (const k of freigegeben) {
      if (k.art === 'speicher') speicher = true;
      else if (k.steuerart === null || k.steuerart.trim() === '') {
        gewaehlt = false;
        fehlt.push(`Steuerart ${k.name}`);
      }
    }
    if (speicher && (e.betriebsmodell === null || e.betriebsmodell.trim() === '')) {
      gewaehlt = false;
      fehlt.push(`Betriebsmodell ${e.anlage}`);
    }
    zeilen.push({ pruefung: 'betriebsweise', bestanden: gewaehlt });
  }
  return { pruefliste: zeilen, fehlt };
}

/** Was am Hauptzähler fehlt — mit dem Wort des Zustandsvokabulars. */
function hauptzaehlerFehlt(e: TeilnahmeEingang, messung: AnlageErgebnis, zone: string): string {
  if (messung.grund === 'kein_hauptzaehler') return `Hauptzähler ${e.anlage}`;
  const kz = `Hauptzähler ${e.hauptzaehler!.kennzeichen}`;
  if (messung.grund === 'keine_datenquelle') return `Datenquelle ${kz}`;
  if (messung.grund === 'wartet_auf_erste_daten') return `erste Daten ${kz}`;
  return messung.seit === null
    ? `Daten ${kz}`
    : `Daten ${kz} seit ${zeitpunktText(messung.seit, e.jetzt, zone)}`;
}

/**
 * Die Beobachtung „steuert" — aus dem Zustandsvokabular, mit dem ZUSTAND statt
 * dem rohen Ruhe-Eintrag: vor dem Start ist die Ruhe R0 kein Anhalten.
 */
function beobachtung(e: TeilnahmeEingang, zustand: FunktionZustand): SteuertErgebnis | null {
  const a = e.ausfuehrung;
  if (a === null) return null;
  return steuert({
    freigabeErteilt: e.komponenten.some((k) => k.freigegeben),
    funktionGestartet: zustand === 'aktiv' || zustand === 'angehalten',
    laeuft: a.laeuft,
    laeuftArt: a.laeuftArt,
    laeuftName: a.laeuftName,
    boxVerbunden: e.boxen.length > 0 && e.boxen.every((b) => b.verbunden),
    boxBestaetigt: a.boxBestaetigt,
    ruheEintrag: zustand === 'angehalten',
  });
}

// ───────────────────────────────────────────────────────── Standort (Steuern)

/** Eine abgeleitete Teilnahme, so wie sie Standort und Übergänge brauchen. */
export interface TeilnahmeStand {
  anlage: string;
  zustand: FunktionZustand;
  seit: string | null;
  fehlt: string[];
}

export interface StandortErgebnis {
  zustand: FunktionZustand;
  seit: string | null;
  text: string;
}

/**
 * „Steuern & Optimieren" am Standort = der HÖCHSTE Zustand seiner Teilnahmen
 * (E6 = C, W7); kein Objekt, wenn keine. `seit`: aktiv/eingerichtet der früheste
 * (die erste Anlage), angehalten/archiviert der späteste (erst mit der letzten
 * ist der Standort dort).
 */
export function standort(teilnahmen: TeilnahmeStand[], zeitzone?: string): StandortErgebnis {
  const zone = zeitzone ?? VORGABE_ZEITZONE;
  let hoechster: FunktionZustand = 'kein_objekt';
  for (const t of teilnahmen) if (RANG[t.zustand] > RANG[hoechster]) hoechster = t.zustand;
  if (hoechster === 'kein_objekt') {
    return { zustand: 'kein_objekt', seit: null, text: `${FUNKTIONEN.steuern} — noch nicht eingerichtet` };
  }
  const fruehester = hoechster === 'aktiv' || hoechster === 'eingerichtet';
  let seit: string | null = null;
  const anlagen: string[] = [];
  const fehlt: string[] = [];
  for (const t of teilnahmen) {
    if (t.zustand !== hoechster) continue;
    anlagen.push(t.anlage);
    fehlt.push(...t.fehlt);
    if (
      t.seit !== null &&
      (seit === null ||
        (fruehester ? Date.parse(t.seit) < Date.parse(seit) : Date.parse(t.seit) > Date.parse(seit)))
    ) {
      seit = t.seit;
    }
  }
  if (hoechster === 'entwurf') seit = null;
  let text: string;
  switch (hoechster) {
    case 'entwurf':
      text = fehltSatz('Noch nicht eingerichtet', fehlt);
      break;
    case 'eingerichtet':
      text = eingerichtetSatz(seit, zone);
      break;
    case 'aktiv':
      text = `Läuft mit ${aufzaehlung(anlagen)}`;
      break;
    case 'angehalten':
      text = mitDatum('Angehalten seit ', 'Angehalten', seit, zone);
      break;
    case 'archiviert':
      text = mitDatum('Steuerung beendet am ', 'Steuerung beendet', seit, zone);
      break;
  }
  return { zustand: hoechster, seit, text };
}

// ─────────────────────────────────────────────────────────── Messen & Auswerten

/** Eine Messstelle des Standorts. */
export interface Messstelle {
  kennzeichen: string;
  /** Manuell abgelesen (AP-09) — zählt als „mit Daten", hat keine Reihe. */
  manuell: boolean;
  quelleVorhanden: boolean;
  letzterGuterWert: string | null;
  jeEinWert: boolean;
  kadenzS: number;
}

/** Eine Anlage des Standorts MIT Netzanschluss und die Zahl ihrer Hauptzähler. */
export interface MessenAnlage {
  name: string;
  hauptzaehlerAnzahl: number;
}

export interface MessenEingang {
  standort: string;
  /** Ob „Einrichten" gedrückt wurde (die Funktion existiert). */
  angelegt: boolean;
  /** Name + Adresse + Zeitzone (AP-02). */
  standortEingerichtet: boolean;
  /** Das Archivieren des Standorts (AP-02); null = nicht archiviert. */
  standortArchiviertAm: string | null;
  /** Wann Messen eingerichtet wurde; einmal gesetzt, bleibt es aktiv. */
  eingerichtetAm: string | null;
  boxen: BoxZustand[];
  /** Die gemessenen Messstellen der Prüfliste (was fehlt, was blockiert). */
  messstellen: Messstelle[];
  /**
   * AP-13 IP-7 (E13 = A): je Zeile des Messstellen-Registers am Standort, wie das Register sie zählt
   * (`MessstelleRegisterService.aggregatZustand`) — allein daraus entsteht die Datenlage.
   */
  registerZeilen: LiefertDatenZustand[];
  anlagen: MessenAnlage[];
  jetzt: string;
  zeitzone?: string;
}

export interface MessenErgebnis {
  zustand: FunktionZustand;
  seit: string | null;
  fehlt: string[];
  text: string;
  /** „x von y Messstellen liefern Daten" (+ manuell abgelesene); null ohne Funktion. */
  datenlage: string | null;
}

/**
 * „Messen & Auswerten" am Standort. Kennt nur kein_objekt · entwurf · aktiv ·
 * archiviert: „eingerichtet" geht sofort in „aktiv" über, angehalten wird es
 * nicht als Ganzes (§4.2/§4.3).
 */
export function messen(e: MessenEingang): MessenErgebnis {
  const zone = e.zeitzone ?? VORGABE_ZEITZONE;
  if (!e.angelegt) {
    return {
      zustand: 'kein_objekt',
      seit: null,
      fehlt: [],
      text: `${FUNKTIONEN.messen} — noch nicht eingerichtet`,
      datenlage: null,
    };
  }
  if (e.standortArchiviertAm !== null) {
    return {
      zustand: 'archiviert',
      seit: e.standortArchiviertAm,
      fehlt: [],
      text: `Archiviert am ${datum(e.standortArchiviertAm, zone)}`,
      datenlage: null,
    };
  }
  const messstellenFehlen: string[] = [];
  let manuell = 0;
  let mitDaten = false;
  for (const m of e.messstellen) {
    if (m.manuell) {
      manuell += 1;
      mitDaten = true;
      continue;
    }
    const r = liefertDaten({
      quelleVorhanden: m.quelleVorhanden,
      letzterGuterWert: m.letzterGuterWert,
      jeEinWert: m.jeEinWert,
      kadenzS: m.kadenzS,
      jetzt: e.jetzt,
      zeitzone: zone,
    });
    if (r.zustand === 'liefert') mitDaten = true;
    else if (r.zustand === 'wartet_auf_erste_daten') messstellenFehlen.push(`erste Daten ${m.kennzeichen}`);
    else if (r.zustand === 'liefert_nicht_seit') {
      messstellenFehlen.push(`Daten ${m.kennzeichen} seit ${zeitpunktText(r.seit!, e.jetzt, zone)}`);
    }
    // keine_datenquelle: AP-04 E8 — eingerichtet und aktiv, nie eine 0; blockiert nicht.
  }
  const datenlageText = datenlage(e.registerZeilen, manuell);

  if (e.eingerichtetAm !== null) {
    return {
      zustand: 'aktiv',
      seit: e.eingerichtetAm,
      fehlt: [],
      text: `Eingerichtet am ${datum(e.eingerichtetAm, zone)}`,
      datenlage: datenlageText,
    };
  }
  const fehlt: string[] = [];
  if (!e.standortEingerichtet) fehlt.push(`Standort-Angaben ${e.standort}`);
  for (const b of e.boxen) if (!b.verbunden) fehlt.push(`Verbindung ${b.name}`);
  if (!mitDaten && messstellenFehlen.length === 0) fehlt.push('Messstelle mit Daten');
  fehlt.push(...messstellenFehlen);
  for (const a of e.anlagen) {
    if (a.hauptzaehlerAnzahl === 0) fehlt.push(`Hauptzähler ${a.name}`);
    else if (a.hauptzaehlerAnzahl > 1) fehlt.push(`eindeutiger Hauptzähler ${a.name}`);
  }
  if (fehlt.length === 0) return { zustand: 'aktiv', seit: null, fehlt: [], text: 'Eingerichtet', datenlage: datenlageText };
  return {
    zustand: 'entwurf',
    seit: null,
    fehlt,
    text: fehltSatz('Noch nicht eingerichtet', fehlt),
    datenlage: datenlageText,
  };
}

/**
 * Die Datenlage-Zeile von „Messen & Auswerten" (AP-13 IP-7, E13 = A): „x von y Messstellen liefern Daten" über die
 * Zeilen des Messstellen-Registers am Standort — dieselbe Zählung wie das Register und der Baustein „Messstellen"
 * der Übersicht: berechnete zählen mit, „keine Datenquelle" steht im Nenner — dazu manuell abgelesene als Zusatz.
 * Bis IP-7 zählte die Zeile nur die gemessenen, nicht archivierten Messstellen (W6).
 */
export function datenlage(registerZeilen: readonly LiefertDatenZustand[], manuell: number): string {
  if (registerZeilen.length === 0 && manuell > 0) return `${manuell} manuell abgelesen`;
  return aggregatLiefertDaten([...registerZeilen], 'messstelle').text + (manuell > 0 ? ` · ${manuell} manuell abgelesen` : '');
}

// ────────────────────────────────────────────────────────────────── Übergänge

export interface UebergangErgebnis {
  erlaubt: boolean;
  grund: UebergangGrund | null;
  /** Der Zustand danach — bei Ablehnung der unveränderte; bei Standort-Aktionen der des STANDORTS. */
  nachher: FunktionZustand;
  /** Die Anlagen, deren Teilnahme sich ändert. */
  betroffen: string[];
  /** Der Grund in Kundensprache; null, wenn erlaubt. */
  text: string | null;
}

/** Warum eine nie gestartete, beendete oder fehlende Teilnahme nicht gesteuert werden kann. */
function ohneStart(z: FunktionZustand): UebergangGrund {
  if (z === 'kein_objekt') return 'nicht_aufgenommen';
  if (z === 'archiviert') return 'beendet';
  return 'noch_nicht_gestartet';
}

function abgelehnt(grund: UebergangGrund, nachher: FunktionZustand, fehlt: string[]): UebergangErgebnis {
  const text = grund === 'pruefliste_offen' ? fehltSatz(GRUND_TEXT[grund], fehlt) : GRUND_TEXT[grund];
  return { erlaubt: false, grund, nachher, betroffen: [], text };
}

/**
 * Ein Übergang der Teilnahme EINER Anlage. `t` ist aus FRISCHEN Fakten
 * abgeleitet — Start und Fortsetzen prüfen die Liste erneut (R1/R2, E9).
 */
export function uebergangAnlage(aktion: Aktion, t: TeilnahmeStand): UebergangErgebnis {
  const z = t.zustand;
  let grund: UebergangGrund | null;
  let ziel: FunktionZustand;
  switch (aktion) {
    case 'aufnehmen':
      grund = z === 'kein_objekt' || z === 'archiviert' ? null : 'bereits_aufgenommen';
      ziel = 'entwurf';
      break;
    case 'starten':
      grund =
        z === 'eingerichtet'
          ? null
          : z === 'entwurf'
            ? 'pruefliste_offen'
            : z === 'aktiv'
              ? 'laeuft_bereits'
              : z === 'angehalten'
                ? 'ist_angehalten'
                : ohneStart(z);
      ziel = 'aktiv';
      break;
    case 'anhalten':
      grund = z === 'aktiv' ? null : z === 'angehalten' ? 'bereits_angehalten' : ohneStart(z);
      ziel = 'angehalten';
      break;
    case 'fortsetzen':
      grund =
        z === 'angehalten'
          ? t.fehlt.length === 0
            ? null
            : 'pruefliste_offen'
          : z === 'aktiv'
            ? 'laeuft_bereits'
            : ohneStart(z);
      ziel = 'aktiv';
      break;
    case 'beenden':
      grund = z === 'aktiv' || z === 'angehalten' ? null : ohneStart(z);
      ziel = 'archiviert';
      break;
    case 'einrichten':
      throw new Error('„einrichten" gilt für Messen & Auswerten');
  }
  if (grund !== null) return abgelehnt(grund, z, t.fehlt);
  return { erlaubt: true, grund: null, nachher: ziel, betroffen: [t.anlage], text: null };
}

/**
 * Anhalten, Fortsetzen oder Beenden für den ganzen Standort: wirkt auf jede
 * Teilnahme, für die der Übergang der Anlage erlaubt wäre. Fortsetzen ist GANZ
 * ODER GAR NICHT — ist eine Prüfliste rot, wird keine fortgesetzt (IP-3: „in
 * derselben Transaktion"). Passt keine Teilnahme, gilt der Grund, den eine
 * Anlage im Zustand des Standorts bekäme.
 */
export function uebergangStandort(
  aktion: Aktion,
  teilnahmen: TeilnahmeStand[],
  zeitzone?: string,
): UebergangErgebnis {
  let ziel: FunktionZustand;
  let passt: (z: FunktionZustand) => boolean;
  if (aktion === 'anhalten') {
    ziel = 'angehalten';
    passt = (z) => z === 'aktiv';
  } else if (aktion === 'fortsetzen') {
    ziel = 'aktiv';
    passt = (z) => z === 'angehalten';
  } else if (aktion === 'beenden') {
    ziel = 'archiviert';
    passt = (z) => z === 'aktiv' || z === 'angehalten';
  } else {
    throw new Error('für den Standort gibt es nur anhalten, fortsetzen, beenden');
  }
  const vorher = standort(teilnahmen, zeitzone).zustand;
  const passend = teilnahmen.filter((t) => passt(t.zustand));
  if (passend.length === 0) {
    const grund = uebergangAnlage(aktion, { anlage: '', zustand: vorher, seit: null, fehlt: [] }).grund!;
    return abgelehnt(grund, vorher, []);
  }
  const fehlt = passend.flatMap((t) => t.fehlt);
  if (aktion === 'fortsetzen' && fehlt.length > 0) return abgelehnt('pruefliste_offen', vorher, fehlt);
  const danach = teilnahmen.map((t) =>
    passend.includes(t) ? { anlage: t.anlage, zustand: ziel, seit: null, fehlt: [] } : t,
  );
  return {
    erlaubt: true,
    grund: null,
    nachher: standort(danach, zeitzone).zustand,
    betroffen: passend.map((t) => t.anlage),
    text: null,
  };
}

/** Ein Übergang von „Messen & Auswerten" am Standort. */
export function uebergangMessen(aktion: Aktion, vorher: FunktionZustand): UebergangErgebnis {
  let grund: UebergangGrund | null;
  switch (aktion) {
    case 'einrichten':
      grund =
        vorher === 'kein_objekt' ? null : vorher === 'archiviert' ? 'standort_archiviert' : 'bereits_angelegt';
      break;
    case 'starten':
      grund = 'startet_automatisch';
      break;
    case 'anhalten':
    case 'fortsetzen':
      grund = 'nicht_als_ganzes';
      break;
    case 'beenden':
      grund = 'nur_mit_dem_standort';
      break;
    case 'aufnehmen':
      throw new Error('„aufnehmen" gilt für Steuern & Optimieren');
  }
  if (grund !== null) return abgelehnt(grund, vorher, []);
  return { erlaubt: true, grund: null, nachher: 'entwurf', betroffen: [], text: null };
}

// ──────────────────────────────────────────────────────────────── Bestand (W5)

/** Was der Bestand über eine Anlage weiß — vor dem Umstieg, ohne Teilnahme-Objekt. */
export interface BestandEingang {
  anlage: string;
  betriebsmodellAn: boolean;
  betriebsmodellSeit: string | null;
  /** Der scharfgeschaltete Speicher fährt ohne Betriebsmodell den Eigenverbrauchs-Fahrplan. */
  eigenverbrauchLaeuft: boolean;
  eigenverbrauchSeit: string | null;
  /** Eine freigegebene Komponente trägt eine wirksame Steuerart oder Regel. */
  steuerartOderRegelAktiv: boolean;
  steuerartSeit: string | null;
  /** Die Steuer-Scharfschaltung eines Wechselrichters (VoltPilot). */
  scharfschaltung: boolean;
}

export interface BestandErgebnis {
  zustand: FunktionZustand;
  gestartetAm: string | null;
  text: string;
}

/**
 * Der einmalige Umstieg (§4.3 „Bestand → Zustand", W5, A11): eine LAUFENDE
 * Betriebsweise → aktiv (übernommen), seit der frühesten; Scharfschaltung ohne
 * laufende Betriebsweise → eingerichtet; sonst kein Objekt. LESEND — nichts wird
 * geschaltet, kein Ruhe-Eintrag angelegt.
 */
export function bestand(e: BestandEingang, zeitzone?: string): BestandErgebnis {
  const zone = zeitzone ?? VORGABE_ZEITZONE;
  if (e.betriebsmodellAn || e.eigenverbrauchLaeuft || e.steuerartOderRegelAktiv) {
    const beginne = [
      e.betriebsmodellAn ? e.betriebsmodellSeit : null,
      e.eigenverbrauchLaeuft ? e.eigenverbrauchSeit : null,
      e.steuerartOderRegelAktiv ? e.steuerartSeit : null,
    ].filter((s): s is string => s !== null);
    let seit: string | null = null;
    for (const s of beginne) if (seit === null || Date.parse(s) < Date.parse(seit)) seit = s;
    const text = `${seit === null ? 'Gestartet' : `Gestartet am ${datum(seit, zone)}`} (übernommen)`;
    return { zustand: 'aktiv', gestartetAm: seit, text };
  }
  if (e.scharfschaltung) {
    return { zustand: 'eingerichtet', gestartetAm: null, text: eingerichtetSatz(null, zone) };
  }
  return { zustand: 'kein_objekt', gestartetAm: null, text: 'Diese Anlage misst nur' };
}

/** Der Standort beim Umstieg: der höchste Zustand seiner übernommenen Anlagen. */
export function bestandStandort(anlagen: BestandEingang[], zeitzone?: string): StandortErgebnis {
  return standort(
    anlagen.map((a) => {
      const b = bestand(a, zeitzone);
      return { anlage: a.anlage, zustand: b.zustand, seit: b.gestartetAm, fehlt: [] };
    }),
    zeitzone,
  );
}

// ─────────────────────────────────────────────────────────────────────── Text

/** „01.12.2026" — das Datum in der Zeitzone des Standorts, nie in UTC. */
export function datum(zeitpunkt: string, zeitzone?: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: zeitzone ?? VORGABE_ZEITZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(zeitpunkt));
}

function eingerichtetSatz(seit: string | null, zone: string): string {
  return `${mitDatum('Eingerichtet am ', 'Eingerichtet', seit, zone)} — Steuerung noch nicht gestartet`;
}

function mitDatum(mit: string, ohne: string, seit: string | null, zone: string): string {
  return seit === null ? ohne : mit + datum(seit, zone);
}

function fehltSatz(kopf: string, fehlt: string[]): string {
  return fehlt.length === 0 ? kopf : `${kopf} — es fehlt: ${aufzaehlung(fehlt)}`;
}
