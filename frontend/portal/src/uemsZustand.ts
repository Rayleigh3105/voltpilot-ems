/**
 * Die REINE Ableitung der zwei BEOBACHTETEN Zustände des
 * Unternehmens-Energiemanagements: **liefert Daten** und **steuert**
 * (UEMS AP-00 §4.3, Prosa in `docs/fachmodell/zustaende.md`).
 *
 * Beide werden NIE von Hand gesetzt — sie entstehen bei jedem Lesen neu aus
 * Fakten. Der Zwilling im Server ist
 * `services/api .../uems/ZustandAbleitung`; beide fahren dieselben Vektoren
 * (`docs/contracts/v2/uems-zustand-vectors.json`).
 * **Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.**
 *
 * ⚠ **Noch ruft niemand an.** Keine Fläche ist umgestellt: `api.ts`
 * (`ONLINE_WINDOW_MS`, `deviceLiveStatus`) und die Komponentenkarte
 * (`komponenten.ts deviceState`) behalten ihr hartes 5-Minuten-Fenster und ihre
 * heutigen Wörter. Dieses Modul ist der Vertrag, gegen den die Umstellung
 * später gebaut wird.
 *
 * ## Familie 1 — liefert Daten
 *
 * ```
 *   toleranzS = min( max( 3 × kadenzS , 300 ) , 86400 )
 * ```
 *
 * Faktor 3 auf die erwartete Häufigkeit (AP-07 E9; die Kadenz ist ein
 * zeitgültiger Fakt der Quellenbindung, kein fester Deckel), MINDESTENS 5
 * Minuten (das heutige Fenster bleibt der Boden — eine 10-s-Reihe hätte sonst
 * 30 s Toleranz und ihr Abzeichen blinkte im Sekundentakt) und HÖCHSTENS 1 Tag
 * (AP-00 §4.3, Übergänge). Die Kante gehört zu „liefert" (`<=`, wie
 * `deviceLiveStatus` heute).
 *
 * ⚠ Der Fall, den man falsch erwartet: bei 60 s Kadenz und 190 s Alter wäre
 * 3 × Kadenz = 180 s überschritten — es gilt trotzdem „Liefert Daten", weil das
 * Mindestfenster größer ist.
 *
 * Die **Lücke** ist eine ANDERE Aussage (AP-07 E9/IP-9): ab 2 × Kadenz ohne
 * guten Wert ist eine Lücke der Reihe offen — ohne Boden und ohne Deckel, denn
 * sie zählt fehlende WERTE, sie zeigt kein Abzeichen. Eine Reihe darf „Liefert
 * Daten" tragen und trotzdem eine offene Lücke haben.
 *
 * ## Familie 2 — steuert
 *
 * „steuert" = Freigabe erteilt UND ein Betriebsmodell oder eine Regel läuft UND
 * die Box bestätigt die Ausführung. Fehlt eines, steht GENAU EIN Grund aus dem
 * geschlossenen Vokabular da — nie zwei, nie ein geratener. Die Reihenfolge
 * führt von der eigenen Entscheidung des Kunden nach außen zur Maschine:
 * angehalten → nicht freigegeben → Funktion nicht gestartet → kein
 * Betriebsmodell → Box meldet sich nicht → Box bestätigt nicht.
 */

/** Vielfaches der Kadenz, das ein guter Wert gilt (AP-07 E9). */
export const TOLERANZ_FAKTOR = 3;

/** Der Boden der Toleranz in Sekunden — das heutige 5-Minuten-Fenster. */
export const TOLERANZ_MINDESTENS_S = 300;

/** Der Deckel der Toleranz in Sekunden — ein Tag (AP-00 §4.3, Übergänge). */
export const TOLERANZ_HOECHSTENS_S = 86400;

/** Ab diesem Vielfachen der Kadenz ohne guten Wert ist eine Lücke offen. */
export const LUECKE_FAKTOR = 2;

/** Die Zeitzone, in der ein Kundensatz seine Uhrzeit nennt, wenn keine am Standort steht. */
export const VORGABE_ZEITZONE = 'Europe/Berlin';

/** Das geschlossene Vokabular der Familie „liefert Daten". */
export type LiefertDatenZustand =
  | 'liefert'
  | 'liefert_nicht_seit'
  | 'wartet_auf_erste_daten'
  | 'keine_datenquelle';

/** Warum eine Anlage keine Daten liefert — in der Reihenfolge, in der die Gründe gelten. */
export type AnlageGrund =
  | 'keine_box'
  | 'box_meldet_sich_nicht'
  | 'kein_hauptzaehler'
  | 'keine_datenquelle'
  | 'wartet_auf_erste_daten'
  | 'hauptzaehler_liefert_nicht';

/** Warum nicht gesteuert wird — genau einer, in der Reihenfolge oben. */
export type SteuertGrund =
  | 'angehalten'
  | 'nicht_freigegeben'
  | 'funktion_nicht_gestartet'
  | 'kein_betriebsmodell'
  | 'box_meldet_sich_nicht'
  | 'box_bestaetigt_nicht';

/** Der Satz, den der Kunde zu jedem Grund liest. */
export const STEUERT_GRUND_TEXT: Record<SteuertGrund, string> = {
  angehalten: 'Steuert nicht — angehalten',
  nicht_freigegeben: 'Steuert nicht — nicht freigegeben',
  funktion_nicht_gestartet: 'Steuert nicht — noch nicht gestartet',
  kein_betriebsmodell: 'Steuert nicht — kein Betriebsmodell gewählt',
  box_meldet_sich_nicht: 'Steuert nicht — Box meldet sich nicht',
  box_bestaetigt_nicht: 'Steuert nicht — Box bestätigt die Ausführung nicht',
};

/** Was ein Aggregat zählt. */
export type EinheitCode = 'messstelle' | 'anlage' | 'komponente' | 'box';

/**
 * Ein- und Mehrzahl der gezählten Dinge. Dieselbe Tabelle steht im Zwilling und
 * in der Vektor-Datei (`einheiten`); die Tests prüfen das, statt es zu glauben.
 */
export const EINHEITEN: Record<EinheitCode, { singular: string; plural: string }> = {
  messstelle: { singular: 'Messstelle', plural: 'Messstellen' },
  anlage: { singular: 'Anlage', plural: 'Anlagen' },
  komponente: { singular: 'Komponente', plural: 'Komponenten' },
  box: { singular: 'Box', plural: 'Boxen' },
};

// ───────────────────────────────────────────────────────────────── liefert Daten

/** Was über EINE Reihe bekannt ist. */
export interface LiefertDatenEingang {
  /** Ob überhaupt eine Datenquelle gebunden ist. */
  quelleVorhanden: boolean;
  /** Eingangszeit des letzten Wertes mit Qualität „gut"; null, wenn nie einer ankam. */
  letzterGuterWert: string | null;
  /**
   * Ob je ein Wert ankam — auch ein schlechter. Ändert das Ergebnis NICHT:
   * gezählt werden nur GUTE Werte (E9), also bleibt es bis zum ersten guten
   * Wert bei „Wartet auf erste Daten". Ein eigenes Wort dafür zu erfinden wäre
   * ein geratener Zustand.
   */
  jeEinWert: boolean;
  /** Die erwartete Häufigkeit in Sekunden. */
  kadenzS: number;
  /** Der Zeitpunkt der Frage. */
  jetzt: string;
  /** Die Zeitzone des Standorts für den Kundensatz. */
  zeitzone?: string;
}

export interface LiefertDatenErgebnis {
  zustand: LiefertDatenZustand;
  /** Nur bei `liefert_nicht_seit` gesetzt — ein Text ohne Zeitpunkt wäre eine halbe Aussage. */
  seit: string | null;
  /** Das tatsächlich angewandte Fenster, zur Nachvollziehbarkeit mitgeführt. */
  toleranzS: number;
  /** Ob die REIHE gerade eine Lücke hat; darf zugleich mit „liefert" wahr sein. */
  lueckeOffen: boolean;
  text: string;
}

/** Das Fenster, in dem ein guter Wert zählt. */
export function toleranzS(kadenzS: number): number {
  return Math.min(Math.max(TOLERANZ_FAKTOR * kadenzS, TOLERANZ_MINDESTENS_S), TOLERANZ_HOECHSTENS_S);
}

/** Der Zustand EINER Reihe (Messstelle, Datenquelle, Komponente, Box). */
export function liefertDaten(e: LiefertDatenEingang): LiefertDatenErgebnis {
  const toleranz = toleranzS(e.kadenzS);
  if (!e.quelleVorhanden) {
    return {
      zustand: 'keine_datenquelle',
      seit: null,
      toleranzS: toleranz,
      lueckeOffen: false,
      text: 'Keine Datenquelle',
    };
  }
  if (e.letzterGuterWert === null) {
    return {
      zustand: 'wartet_auf_erste_daten',
      seit: null,
      toleranzS: toleranz,
      lueckeOffen: false,
      text: 'Wartet auf erste Daten',
    };
  }
  const alterS = (Date.parse(e.jetzt) - Date.parse(e.letzterGuterWert)) / 1000;
  const lueckeOffen = alterS > LUECKE_FAKTOR * e.kadenzS;
  if (alterS <= toleranz) {
    return {
      zustand: 'liefert',
      seit: null,
      toleranzS: toleranz,
      lueckeOffen,
      text: 'Liefert Daten',
    };
  }
  return {
    zustand: 'liefert_nicht_seit',
    seit: e.letzterGuterWert,
    toleranzS: toleranz,
    lueckeOffen,
    text: `Liefert keine Daten seit ${zeitpunktText(e.letzterGuterWert, e.jetzt, e.zeitzone)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────── Anlage

/** Eine Box und ob ihr Herzschlag in ihrer Kadenz ankommt. */
export interface BoxZustand {
  /** Der Name, den der Kunde liest — eine Ursache darf nur behaupten, wer sie benennen kann. */
  name: string;
  verbunden: boolean;
}

/** Ein bereits abgeleiteter Reihen-Zustand, so wie ihn ein Objekt darüber weiterreicht. */
export interface Quellzustand {
  zustand: LiefertDatenZustand;
  seit: string | null;
}

export interface AnlageEingang {
  boxen: BoxZustand[];
  /** null, wenn kein Hauptzähler gebunden ist. */
  hauptzaehler: Quellzustand | null;
  jetzt: string;
  zeitzone?: string;
}

export interface AnlageErgebnis {
  liefert: boolean;
  grund: AnlageGrund | null;
  seit: string | null;
  text: string;
}

/**
 * Die Regel der Objekt-Tabelle: eine Anlage liefert Daten, wenn ALLE ihre Boxen
 * verbunden sind UND der Hauptzähler liefert.
 *
 * Reihenfolge der Gründe: keine Box → stumme Box → kein Hauptzähler → der
 * Zustand des Hauptzählers. Eine stumme Box erklärt den stillen Zähler; den
 * engeren Grund zuerst zu nennen, wäre geraten.
 */
export function liefertDatenAnlage(e: AnlageEingang): AnlageErgebnis {
  if (e.boxen.length === 0) {
    return {
      liefert: false,
      grund: 'keine_box',
      seit: null,
      text: 'Liefert keine Daten — keine Box angemeldet',
    };
  }
  const stumm = e.boxen.filter((b) => !b.verbunden).map((b) => b.name);
  if (stumm.length > 0) {
    const verb = stumm.length === 1 ? 'meldet sich nicht' : 'melden sich nicht';
    return {
      liefert: false,
      grund: 'box_meldet_sich_nicht',
      seit: null,
      text: `Liefert keine Daten — ${aufzaehlung(stumm)} ${verb}`,
    };
  }
  const hz = e.hauptzaehler;
  if (hz === null) {
    return {
      liefert: false,
      grund: 'kein_hauptzaehler',
      seit: null,
      text: 'Liefert keine Daten — kein Hauptzähler',
    };
  }
  switch (hz.zustand) {
    case 'keine_datenquelle':
      return { liefert: false, grund: 'keine_datenquelle', seit: null, text: 'Keine Datenquelle' };
    case 'wartet_auf_erste_daten':
      return {
        liefert: false,
        grund: 'wartet_auf_erste_daten',
        seit: null,
        text: 'Wartet auf erste Daten',
      };
    case 'liefert_nicht_seit':
      return {
        liefert: false,
        grund: 'hauptzaehler_liefert_nicht',
        seit: hz.seit,
        // Ohne Zeitpunkt bleibt der Satz kurz, statt „jetzt" zu behaupten.
        text:
          hz.seit === null
            ? 'Liefert keine Daten'
            : `Liefert keine Daten seit ${zeitpunktText(hz.seit, e.jetzt, e.zeitzone)}`,
      };
    default:
      return { liefert: true, grund: null, seit: null, text: 'Liefert Daten' };
  }
}

// ───────────────────────────────────────────────────────────────────── Aggregat

/** „x von y" für Standort und Unternehmen. */
export interface AggregatErgebnis {
  /** Wie viele liefern beziehungsweise steuern. */
  erfuellt: number;
  gesamt: number;
  text: string;
}

/**
 * „14 von 14 Messstellen liefern Daten". Nur `liefert` zählt im Zähler; „keine
 * Datenquelle" steht im Nenner, nie im Zähler — sie ist kein Liefern und auch
 * kein Ausfall.
 */
export function aggregatLiefertDaten(
  einzel: LiefertDatenZustand[],
  einheit: EinheitCode,
): AggregatErgebnis {
  const e = EINHEITEN[einheit];
  const gesamt = einzel.length;
  const liefernd = einzel.filter((z) => z === 'liefert').length;
  if (gesamt === 0) return { erfuellt: 0, gesamt: 0, text: `Noch keine ${e.plural}` };
  const nomen = gesamt === 1 ? e.singular : e.plural;
  const verb = liefernd === 1 ? 'liefert' : 'liefern';
  return {
    erfuellt: liefernd,
    gesamt,
    text: `${liefernd} von ${gesamt} ${nomen} ${verb} Daten`,
  };
}

/** „1 von 2 Anlagen steuert". */
export function aggregatSteuert(einzel: boolean[], einheit: EinheitCode): AggregatErgebnis {
  const e = EINHEITEN[einheit];
  const gesamt = einzel.length;
  const steuernd = einzel.filter(Boolean).length;
  if (gesamt === 0) return { erfuellt: 0, gesamt: 0, text: `Noch keine ${e.plural}` };
  const nomen = gesamt === 1 ? e.singular : e.plural;
  const verb = steuernd === 1 ? 'steuert' : 'steuern';
  return { erfuellt: steuernd, gesamt, text: `${steuernd} von ${gesamt} ${nomen} ${verb}` };
}

// ─────────────────────────────────────────────────── berechnete Messstelle

/** Ein Eingang einer berechneten Messstelle, mit dem Kennzeichen, das der Kunde kennt. */
export interface BerechnetEingang {
  kennzeichen: string;
  zustand: LiefertDatenZustand;
  seit: string | null;
}

export interface BerechnetErgebnis {
  vollstaendig: boolean;
  fehlend: string[];
  seit: string | null;
  text: string;
}

/**
 * „Vollständig" nur, wenn ALLE Eingänge liefern; sonst „Unvollständig seit
 * 14:00 Uhr (fehlt: MS-12)" mit dem FRÜHESTEN Zeitpunkt der fehlenden Eingänge
 * — seit da ist die Rechnung unvollständig, nicht erst seit dem zweiten
 * Ausfall. Hat keiner der fehlenden Eingänge einen Zeitpunkt, steht auch keiner
 * im Satz: ein erfundenes „seit" wäre eine Behauptung.
 */
export function berechnet(
  eingaenge: BerechnetEingang[],
  jetzt: string,
  zeitzone?: string,
): BerechnetErgebnis {
  const fehlendeEingaenge = eingaenge.filter((e) => e.zustand !== 'liefert');
  if (fehlendeEingaenge.length === 0) {
    return { vollstaendig: true, fehlend: [], seit: null, text: 'Vollständig' };
  }
  const fehlend = fehlendeEingaenge.map((e) => e.kennzeichen);
  let seit: string | null = null;
  for (const e of fehlendeEingaenge) {
    if (e.seit !== null && (seit === null || Date.parse(e.seit) < Date.parse(seit))) {
      seit = e.seit;
    }
  }
  const kopf = seit === null ? 'Unvollständig' : `Unvollständig seit ${zeitpunktText(seit, jetzt, zeitzone)}`;
  return { vollstaendig: false, fehlend, seit, text: `${kopf} (fehlt: ${fehlend.join(', ')})` };
}

// ────────────────────────────────────────────────────────────────────── steuert

export interface SteuertEingang {
  /** Ob „Steuern freigeben" erteilt ist. Ohne Freigabe ist alles Weitere nicht gefragt. */
  freigabeErteilt: boolean;
  /** Ob die Funktion des Standorts ausdrücklich gestartet wurde (AP-01 E6/E8). */
  funktionGestartet: boolean;
  /** Ob gerade ein Betriebsmodell oder eine Regel läuft. */
  laeuft: boolean;
  laeuftArt: 'betriebsmodell' | 'regel' | null;
  /** Sein Name; null heißt „kein Name bekannt" — dann steht auch keiner im Satz. */
  laeuftName: string | null;
  /** Ob der Herzschlag der zuständigen Box ankommt (AP-06 E3/E5). */
  boxVerbunden: boolean;
  /** Ob die Box die AUSFÜHRUNG bestätigt. Antwort ist nicht Wirkung. */
  boxBestaetigt: boolean;
  /** Ruhe-Eintrag ohne Enddatum (AP-01 E7/E8) — der Kunde hat selbst angehalten. */
  ruheEintrag: boolean;
}

export interface SteuertErgebnis {
  steuert: boolean;
  grund: SteuertGrund | null;
  text: string;
}

/** Die EINE Reihenfolge der Gründe; null heißt „es steuert". */
function grundFuer(e: SteuertEingang): SteuertGrund | null {
  if (e.ruheEintrag) return 'angehalten';
  if (!e.freigabeErteilt) return 'nicht_freigegeben';
  if (!e.funktionGestartet) return 'funktion_nicht_gestartet';
  if (!e.laeuft) return 'kein_betriebsmodell';
  if (!e.boxVerbunden) return 'box_meldet_sich_nicht';
  if (!e.boxBestaetigt) return 'box_bestaetigt_nicht';
  return null;
}

/** Steuert dieses Objekt gerade — und wenn nicht, aus genau welchem Grund? */
export function steuert(e: SteuertEingang): SteuertErgebnis {
  const grund = grundFuer(e);
  if (grund !== null) return { steuert: false, grund, text: STEUERT_GRUND_TEXT[grund] };
  let text = 'Wird von VoltPilot gesteuert';
  if (e.laeuftName !== null && e.laeuftName.trim() !== '') {
    text += e.laeuftArt === 'regel' ? ` · Regel „${e.laeuftName}“` : ` · ${e.laeuftName}`;
  }
  return { steuert: true, grund: null, text };
}

// ───────────────────────────────────────────────────────────────────────── Text

/** Datum und Uhrzeit eines Zeitpunkts in der Zeitzone des Standorts. */
function teile(iso: string, zone: string): { tag: string; stunde: string; minute: string } {
  // 'sv-SE' liefert die ISO-Schreibweise "2026-09-10 14:00:00"; das ist die
  // schon im Portal benutzte Art, eine Zeitzone anzuwenden (`anlage.ts`).
  const s = new Date(iso).toLocaleString('sv-SE', { timeZone: zone });
  const m = /(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})/.exec(s);
  if (m === null) throw new Error(`unlesbarer Zeitpunkt: ${iso}`);
  return { tag: `${m[3]}.${m[2]}.${m[1]}`, stunde: m[4], minute: m[5] };
}

/**
 * „14:00 Uhr" — und sobald der Zeitpunkt nicht mehr am heutigen Tag des
 * Standorts liegt, „09.09.2026 23:50 Uhr". Sekunden sind Lärm; die Zeitzone ist
 * die des Standorts, nie ein fester Versatz (Sommer- und Winterzeit).
 */
export function zeitpunktText(seit: string, jetzt: string, zeitzone?: string): string {
  const zone = zeitzone ?? VORGABE_ZEITZONE;
  const s = teile(seit, zone);
  const j = teile(jetzt, zone);
  const uhr = `${s.stunde}:${s.minute} Uhr`;
  return s.tag === j.tag ? uhr : `${s.tag} ${uhr}`;
}

/**
 * „a" · „a und b" · „a, b und c" — eine deutsche Aufzählung. Exportiert, damit
 * `uemsFunktion.ts` dieselbe benutzt.
 */
export function aufzaehlung(worte: string[]): string {
  if (worte.length === 1) return worte[0];
  return `${worte.slice(0, -1).join(', ')} und ${worte[worte.length - 1]}`;
}
