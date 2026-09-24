/**
 * Die REINE Ableitung der RECHTE (UEMS AP-03 IP-1; Regeln im AP-03-Konzept
 * §4.1–§4.7, Entscheide E1, E4, E5, E6, E8, E9, E10, E13, E15 vom 10.09.2026).
 *
 * Aus der Rechte-Matrix (`docs/contracts/v2/rechte-matrix.json`, 48 Aktionen ×
 * 7 Rollen) und den Zuweisungen eines Benutzers wird ein Ja oder Nein mit Grund
 * in Kundensprache: `darf`, dazu `sichtbareStandorte`, `teilansicht`, `summe`,
 * `geltungsbereich`, `ocppStufe`, `unterstuetzung`, `gewaehren`, `handeingriff`
 * und `zuweisungAendern`. Keine Uhr: „jetzt" ist immer ein Eingang.
 *
 * Der Zwilling ist `services/api/.../uems/RechteAbleitung.java`; beide fahren
 * dieselben Vektoren (`docs/contracts/v2/rechte-vectors.json`). Wer die Regel
 * ändert, ändert BEIDE Seiten UND die Vektor-Datei.
 *
 * ⚠ NOCH RUFT NIEMAND AN. Kein `/me` (IP-4), keine Fläche (IP-12 macht
 * `rollen.ts` zur einen Rechte-Quelle des Portals und ruft dann hierher). Das
 * Modul erzwingt nichts — die Durchsetzung liegt im API (Invariante 5).
 *
 * Geltungsbereich VOR Aktion (Invariante 4, W2): erst 404, wenn das Ziel außerhalb
 * liegt (die Existenz wird nie bestätigt), dann 403 mit `rolleNoetig`. Eine Anlage
 * wird über ihren Standort ZUM STICHTAG aufgelöst (Rechte prüfen die heutige
 * Zuweisung, Daten lesen den Stichtag).
 */
import { datum } from './uemsFunktion';
import { datumText, mitternacht, plusTage } from './uemsOrtsbaum';
import { aufzaehlung, VORGABE_ZEITZONE } from './uemsZustand';

// ─────────────────────────────────────────────────────────────── Vokabular

/**
 * Die Spalten der Matrix: die sieben der Konzept-Tabelle in ihrer Reihenfolge, dahinter
 * `einsicht` (Nachtrag AP-19 §4.11, IP-12 — nur lesen, unternehmensweit, befristbar).
 */
export const ROLLEN = [
  'kundenadministrator',
  'energiemanager',
  'bearbeiter',
  'bedienberechtigt',
  'leser',
  'unterstuetzer',
  'voltpilot_betrieb',
  'einsicht',
] as const;
export type Rolle = (typeof ROLLEN)[number];

/** Das Kundenwort je Rolle (AP-03 E1, `glossar.ts`). */
export const ROLLE_KUNDENWORT: Record<Rolle, string> = {
  kundenadministrator: 'Kundenadministrator',
  energiemanager: 'Energiemanager',
  bearbeiter: 'Bearbeiter',
  bedienberechtigt: 'Bedienberechtigt',
  leser: 'Leser',
  unterstuetzer: 'Unterstützer',
  voltpilot_betrieb: 'VoltPilot-Betrieb',
  einsicht: 'Einsicht',
};

/**
 * Die Reihenfolge, in der `rolleNoetig` die KLEINSTE Rolle sucht, die das Recht
 * hätte. Wo Leser es hat, haben es Bearbeiter und Bedienberechtigt auch. Einsicht
 * steht nicht darin: `rolleNoetig` nennt weiter die Rollen von vorher (AP-19 IP-12, NW-5).
 */
export const ROLLE_NOETIG_REIHENFOLGE: readonly Rolle[] = [
  'leser',
  'bearbeiter',
  'bedienberechtigt',
  'energiemanager',
  'kundenadministrator',
  'voltpilot_betrieb',
];

/** Die Zellen-Codes der Konzept-Legende. */
export type Zelle = 'U' | 'S' | 'E' | '-' | 'P' | 'A' | 'Ei' | 'B';

/** Der Umfang einer Unterstützung (E9), AUFSTEIGEND — die Reihenfolge ist die Regel. */
export const UMFAENGE = ['ansehen', 'einrichten', 'einrichten_und_bedienen'] as const;
export type Umfang = (typeof UMFAENGE)[number];

export const UMFANG_KUNDENWORT: Record<Umfang, string> = {
  ansehen: 'Ansehen',
  einrichten: 'Einrichten',
  einrichten_und_bedienen: 'Einrichten und Bedienen',
};

/** Benutzer des Kundenbereichs, Partner-Konto (Installateur, E7) oder VoltPilot-Konto. */
export const KONTEN = ['benutzer', 'partner', 'plattform'] as const;
export type Konto = (typeof KONTEN)[number];

/** Der Zustand des Kontos (§4.8): nur ein aktives Konto hat Rechte. */
export const KONTO_ZUSTAENDE = ['angelegt', 'aktiv', 'gesperrt', 'entfernt'] as const;
export type KontoZustand = (typeof KONTO_ZUSTAENDE)[number];

/** Die Art einer Unterstützung (§4.6, E8). */
export const ARTEN = ['installateur', 'voltpilot', 'notfall'] as const;
export type Art = (typeof ARTEN)[number];

/** Die OCPP-Stufen aus `OcppActionPolicy`, AUFSTEIGEND — künftig aus der Zuweisung (E13). */
export const OCPP_STUFEN = ['keine', 'CUSTOMER', 'SITE_ADMIN', 'PLATFORM'] as const;
export type OcppStufe = (typeof OCPP_STUFEN)[number];

/** Der Zustand einer Unterstützung (§4.8) — sie wird beendet, nie angehalten. */
export const UNTERSTUETZUNG_ZUSTAENDE = ['entwurf', 'eingerichtet', 'aktiv', 'archiviert'] as const;
export type UnterstuetzungsZustand = (typeof UNTERSTUETZUNG_ZUSTAENDE)[number];

/**
 * Was an den Rechten einer Person geändert wird (§4.7, §5.2) — dazu seit AP-03 IP-8 die zwei
 * Protokollwörter der Unterstützung: `verlaengern` (neues Enddatum, §4.6) und `ablaufen`
 * (Ende durch Zeitablauf, A4). Über sie urteilt `zuweisungAendern` nicht.
 */
export const AENDERUNGEN = [
  'zuweisen',
  'entziehen',
  'sperren',
  'entfernen',
  'verlaengern',
  'ablaufen',
  'erste_anmeldung',
  'startpasswort_neu',
] as const;
export type AenderungsArt = (typeof AENDERUNGEN)[number];

/** Das Grund-Vokabular mit seinem HTTP-Status — die Fehlerkörper des API (§6.2). */
export const GRUENDE = {
  erlaubt: 200,
  recht_fehlt: 403,
  ausserhalb_geltungsbereich: 404,
  zugriff_beendet: 404,
  konto_nicht_aktiv: 401,
  eigene_zuweisung: 409,
  letzter_kundenadministrator: 409,
  standort_fehlt: 422,
  hoechstens_12_monate: 422,
  grund_fehlt: 422,
  zweite_person_noetig: 403,
} as const;
export type Grund = keyof typeof GRUENDE;

/** Die längste Unterstützung in Kalendermonaten (E6). */
export const HOECHSTENS_MONATE = 12;
/** Die Vorgabe-Dauer im Gewähren-Dialog (E6). */
export const VORGABE_TAGE = 30;
/** Die Erinnerung vor dem Ende einer Unterstützung (E6). */
export const ERINNERUNG_TAGE = 7;
/** Die Dauer eines Notfall-Zugriffs (E8). */
export const NOTFALL_STUNDEN = 24;

/**
 * Die Kundensätze als Vorlagen (`{…}` wird eingesetzt) — dieselben stehen im
 * Block `texte` der Vektor-Datei; beide Zwillinge prüfen sie dagegen.
 */
export const TEXTE = {
  recht_fehlt: 'Dafür fehlt Ihnen das Recht.',
  weg_ein_kundenadministrator: 'Ihr Kundenadministrator: {namen}.',
  weg_kundenadministratoren: 'Ihre Kundenadministratoren: {namen}.',
  weg_voltpilot: 'Das übernimmt VoltPilot.',
  ausserhalb_geltungsbereich: 'Diese Seite gibt es für Sie nicht.',
  zugriff_beendet: 'Ihr Zugriff auf {standort} wurde beendet.',
  unterstuetzung_beendet: 'Ihre Unterstützung für {kundenbereich} ist beendet.',
  kein_standort: 'Ihnen ist derzeit kein Standort zugewiesen.',
  kein_standort_ein_weg: 'Ihr Kundenadministrator {namen} kann das ändern.',
  kein_standort_wege: 'Ihre Kundenadministratoren {namen} können das ändern.',
  wirkt_ab: 'Wirkt ab {datum}',
  teilansicht: 'Teilansicht: {n} von {m} Standorten',
  teilansicht_export: 'Teilansicht: {namen} ({n} von {m} Standorten)',
  standortuebergreifend: 'umfasst Standorte außerhalb Ihres Zugriffs',
  banner_installateur: '{anzeigename} (Installateur) hat Zugriff auf {standorte} bis {ende} — {umfang}',
  banner_voltpilot: 'VoltPilot-Support hat Zugriff auf {standorte} bis {ende} — {umfang}',
  banner_notfall: 'VoltPilot-Support hat Notfall-Zugriff auf {standorte} bis {ende} — Grund: {grund}',
  banner_unterstuetzer: 'Sie arbeiten im Kundenbereich {kundenbereich} · {standorte} · bis {ende}',
  urheber_installateur: '{anzeigename} (Unterstützung)',
  urheber_voltpilot: 'VoltPilot-Support (Unterstützung)',
  urheber_notfall: 'VoltPilot (Notfall-Zugriff)',
  endete_zeitablauf: 'Endete am {datum} durch Zeitablauf',
  beendet: 'Beendet am {datum}',
  beendet_von: 'Beendet am {datum} durch {name}',
  gesetzt_von: 'gesetzt von {urheber}',
  bedienrecht_beendet: 'gesetzt von {urheber} (Bedienrecht beendet am {zeitpunkt})',
  hoechstens_12_monate:
    'Eine Unterstützung ist höchstens 12 Monate gültig. Sie können sie jederzeit verlängern.',
  standort_fehlt: 'Wählen Sie mindestens einen Standort.',
  grund_fehlt: 'Für einen Notfall-Zugriff ist ein Grund Pflicht.',
  letzter_kundenadministrator:
    '{kundenbereich} braucht mindestens einen Kundenadministrator. Ernennen Sie zuerst eine weitere Person.',
  zweite_person: 'Freigabe durch eine zweite Person.',
} as const;

function text(schluessel: keyof typeof TEXTE, werte: Record<string, string> = {}): string {
  let s: string = TEXTE[schluessel];
  for (const [k, v] of Object.entries(werte)) s = s.replace(`{${k}}`, v);
  return s;
}

// ─────────────────────────────────────────────────────────────────── Matrix

/** Eine Zeile der Matrix: Kennung, Wortlaut und je Rolle der Zellen-Code. */
export interface Aktion {
  kennung: string;
  kundenwort: string;
  zellen: Record<Rolle, Zelle>;
}

/** Die Rechte-Matrix als Daten, nach Kennung. */
export type Matrix = ReadonlyMap<string, Aktion>;

/** Liest `rechte-matrix.json` (schon geparst) — rein, ohne Datei-Zugriff. */
export function matrixAus(datei: { aktionen: Aktion[] }): Matrix {
  const m = new Map<string, Aktion>();
  for (const a of datei.aktionen) {
    if (ROLLEN.some((r) => a.zellen[r] === undefined)) {
      throw new Error(`Zeile ohne alle Rollen: ${a.kennung}`);
    }
    m.set(a.kennung, { kennung: a.kennung, kundenwort: a.kundenwort, zellen: { ...a.zellen } });
  }
  return m;
}

function aktionAus(m: Matrix, kennung: string): Aktion {
  const a = m.get(kennung);
  if (a === undefined) throw new Error(`unbekannte Aktion: ${kennung}`);
  return a;
}

// ───────────────────────────────────────────────────────────────── Eingänge

/**
 * Rolle × Geltungsbereich × Gültigkeit (§4.1). `standorte === null` heißt
 * Unternehmen (alle Standorte, auch künftige); sonst die ausdrückliche Liste
 * (E5). Zeit: ab `gueltigAb` (Zeitpunkt) bis `gueltigBis` und bis `beendetAm`
 * (ausschließend). `gueltigBis` ist das ENDDATUM einer Unterstützung — ein
 * Kalendertag, einschließlich (siehe `bisZeitpunkt`); nur der Notfall-Zugriff
 * trägt dort einen Zeitpunkt.
 */
export interface Zuweisung {
  rolle: Rolle;
  standorte: string[] | null;
  umfang: Umfang | null;
  art: Art | null;
  gueltigAb: string;
  gueltigBis: string | null;
  beendetAm: string | null;
}

export interface Benutzer {
  kennung: string;
  name: string;
  konto: Konto;
  zustand: KontoZustand;
  zuweisungen: Zuweisung[];
}

export interface Standort {
  kennzeichen: string;
  name: string;
}

export interface Person {
  kennung: string;
  name: string;
}

/** Der Kundenbereich zur Anfragezeit — seine Kundenadministratoren nennt jeder Grund als Weg. */
export interface Kundenbereich {
  name: string;
  standorte: Standort[];
  kundenadministratoren: Person[];
}

/**
 * Die Zuordnung einer Anlage zu einem Standort, tagesgenau (AP-02 E9, wie der
 * Ortsbaum-Vertrag): `gueltigAb` ist ein Tag (JJJJ-MM-TT), `gueltigBis` der LETZTE
 * gültige Tag, einschließlich (`null` = offen).
 */
export interface AnlageStandort {
  standort: string;
  gueltigAb: string;
  gueltigBis: string | null;
}

export interface Anlage {
  kennzeichen: string;
  zuordnungen: AnlageStandort[];
}

/** Das Unternehmen (alles `null`), ein Standort oder eine Anlage zu einem Stichtag (`null` = jetzt). */
export interface Ziel {
  standort: string | null;
  anlage: Anlage | null;
  stichtag: string | null;
}

const ms = (iso: string): number => Date.parse(iso);

const istTag = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Das Ende einer Gültigkeit als Zeitpunkt (ausschließend). Ein Enddatum
 * (JJJJ-MM-TT) ist ein Kalendertag und gilt EINSCHLIESSLICH: „bis 15.12.2026"
 * endet am 16.12.2026 um 00:00 in der Zeitzone des Kundenbereichs (AP-03 A4, wie
 * jede tagesgenaue Gültigkeit — AP-02 E9). Nur der Notfall-Zugriff (E8) trägt
 * einen Zeitpunkt: genau 24 h, halboffen.
 */
export function bisZeitpunkt(gueltigBis: string | null, zeitzone: string = VORGABE_ZEITZONE): string | null {
  if (gueltigBis === null) return null;
  return istTag(gueltigBis) ? mitternacht(plusTage(gueltigBis, 1), zeitzone).iso : gueltigBis;
}

function unternehmensweit(z: Zuweisung): boolean {
  return z.standorte === null;
}

function deckt(z: Zuweisung, standort: string): boolean {
  return z.standorte === null || z.standorte.includes(standort);
}

/** Wirksam ab „gültig ab“, bis zum Ende des Enddatums und vor dem Beenden. */
export function wirksam(z: Zuweisung, jetzt: string): boolean {
  const t = ms(jetzt);
  const bis = bisZeitpunkt(z.gueltigBis);
  return t >= ms(z.gueltigAb) && (bis === null || t < ms(bis)) && (z.beendetAm === null || t < ms(z.beendetAm));
}

function vorbei(z: Zuweisung, jetzt: string): boolean {
  const t = ms(jetzt);
  const bis = bisZeitpunkt(z.gueltigBis);
  return (bis !== null && t >= ms(bis)) || (z.beendetAm !== null && t >= ms(z.beendetAm));
}

function kuenftig(z: Zuweisung, jetzt: string): boolean {
  return ms(jetzt) < ms(z.gueltigAb) && (z.beendetAm === null || ms(z.beendetAm) > ms(z.gueltigAb));
}

/** Das tatsächliche Ende: das frühere von Enddatum und Beenden. */
function ende(z: Zuweisung): string | null {
  const bis = bisZeitpunkt(z.gueltigBis);
  if (z.beendetAm !== null && (bis === null || ms(z.beendetAm) < ms(bis))) {
    return z.beendetAm;
  }
  return bis;
}

/** Der Standort einer Anlage zum Stichtag — `null`, wenn sie dann keinem gehört. */
export function standortAm(a: Anlage, stichtag: string): string | null {
  // Der Stichtag gilt an seinem Kalendertag in der Zeitzone des Kundenbereichs.
  const [j, mo, t] = ortszeit(stichtag, VORGABE_ZEITZONE);
  const tag = `${j}-${zwei(mo)}-${zwei(t)}`;
  const z = a.zuordnungen.find((x) => x.gueltigAb <= tag && (x.gueltigBis === null || tag <= x.gueltigBis));
  return z === undefined ? null : z.standort;
}

function standortName(k: Kundenbereich, kennzeichen: string): string {
  return k.standorte.find((s) => s.kennzeichen === kennzeichen)?.name ?? kennzeichen;
}

// ───────────────────────────────────────────────────────────────────── darf

export interface DarfErgebnis {
  darf: boolean;
  /** „nicht 404/401". */
  sichtbar: boolean;
  http: number;
  grund: Grund;
  standort: string | null;
  /** Die Rolle, die das Recht gibt (Spaltenreihenfolge). */
  rolle: Rolle | null;
  rolleNoetig: Rolle | null;
  umfangNoetig: Umfang | null;
  text: string | null;
}

const ERLAUBT = (standort: string | null, rolle: Rolle | null): DarfErgebnis => ({
  darf: true,
  sichtbar: true,
  http: 200,
  grund: 'erlaubt',
  standort,
  rolle,
  rolleNoetig: null,
  umfangNoetig: null,
  text: null,
});

/** Außerhalb: die Existenz wird nie bestätigt — auch der Standort steht nicht im Ergebnis. */
const AUSSERHALB = (): DarfErgebnis => ({
  darf: false,
  sichtbar: false,
  http: 404,
  grund: 'ausserhalb_geltungsbereich',
  standort: null,
  rolle: null,
  rolleNoetig: null,
  umfangNoetig: null,
  text: TEXTE.ausserhalb_geltungsbereich,
});

const BEENDET = (standort: string | null, satz: string): DarfErgebnis => ({
  darf: false,
  sichtbar: false,
  http: 404,
  grund: 'zugriff_beendet',
  standort,
  rolle: null,
  rolleNoetig: null,
  umfangNoetig: null,
  text: satz,
});

function umfangFuer(c: Zelle): Umfang | null {
  return c === 'A' ? 'ansehen' : c === 'Ei' ? 'einrichten' : c === 'B' ? 'einrichten_und_bedienen' : null;
}

/**
 * Gibt die Zelle dieser Zuweisung das Recht am Ziel? U = unternehmensweit,
 * S = je zugewiesenem Standort, A/Ei/B = Unterstützung mit mindestens diesem
 * Umfang am Standort.
 */
function gewaehrt(c: Zelle, z: Zuweisung, standort: string | null): boolean {
  switch (c) {
    case 'U':
      return unternehmensweit(z);
    case 'S':
      return standort !== null && z.standorte !== null && z.standorte.includes(standort);
    case 'A':
    case 'Ei':
    case 'B': {
      const noetig = umfangFuer(c) as Umfang;
      return (
        z.rolle === 'unterstuetzer' &&
        standort !== null &&
        z.standorte !== null &&
        z.standorte.includes(standort) &&
        z.umfang !== null &&
        UMFAENGE.indexOf(z.umfang) >= UMFAENGE.indexOf(noetig)
      );
    }
    default:
      return false;
  }
}

/** „Ihr Kundenadministrator: Jonas Wendlinger." — ohne bekannten Namen kein Weg-Satz. */
function wegZumKundenadministrator(k: Kundenbereich): string | null {
  const namen = k.kundenadministratoren.map((p) => p.name);
  if (namen.length === 0) return null;
  return text(namen.length === 1 ? 'weg_ein_kundenadministrator' : 'weg_kundenadministratoren', {
    namen: aufzaehlung(namen),
  });
}

/** 404, wenn das Ziel außerhalb des Geltungsbereichs liegt; sonst `null`. */
function geltungsbereichPruefen(
  b: Benutzer,
  k: Kundenbereich,
  ziel: Ziel,
  standort: string | null,
  wirksame: Zuweisung[],
  dritter: boolean,
  jetzt: string,
): DarfErgebnis | null {
  if (ziel.standort === null && ziel.anlage === null) {
    // Das Unternehmen: für einen Benutzer des Kundenbereichs immer im Geltungsbereich;
    // Partner und VoltPilot erreichen den Kundenbereich nur über eine Unterstützung.
    if (!dritter || wirksame.length > 0) return null;
    return b.zuweisungen.some((z) => vorbei(z, jetzt))
      ? BEENDET(null, text('unterstuetzung_beendet', { kundenbereich: k.name }))
      : AUSSERHALB();
  }
  if (standort === null) {
    // Eine Anlage ohne Standort zum Stichtag sehen nur unternehmensweite Rollen (IP-5).
    return wirksame.some(unternehmensweit) ? null : AUSSERHALB();
  }
  if (!k.standorte.some((s) => s.kennzeichen === standort)) return AUSSERHALB();
  if (wirksame.some((z) => deckt(z, standort))) return null;
  if (!b.zuweisungen.some((z) => vorbei(z, jetzt) && deckt(z, standort))) return AUSSERHALB();
  const satz =
    dritter && wirksame.length === 0
      ? text('unterstuetzung_beendet', { kundenbereich: k.name })
      : text('zugriff_beendet', { standort: standortName(k, standort) });
  return BEENDET(standort, satz);
}

/** darf(benutzer, aktion, ziel) zum Zeitpunkt `jetzt` — Geltungsbereich vor Aktion. */
export function darf(
  m: Matrix,
  b: Benutzer,
  k: Kundenbereich,
  aktion: string,
  ziel: Ziel,
  jetzt: string,
): DarfErgebnis {
  const a = aktionAus(m, aktion);
  if (b.zustand !== 'aktiv') {
    return { ...AUSSERHALB(), http: 401, grund: 'konto_nicht_aktiv', text: null };
  }
  if (ROLLEN.every((r) => a.zellen[r] === 'E')) return ERLAUBT(null, null);
  const standort =
    ziel.anlage !== null ? standortAm(ziel.anlage, ziel.stichtag ?? jetzt) : ziel.standort;
  if (b.konto === 'plattform' && a.zellen.voltpilot_betrieb === 'P') {
    return ERLAUBT(standort, 'voltpilot_betrieb');
  }
  const wirksame = b.zuweisungen.filter((z) => wirksam(z, jetzt));
  const dritter = b.konto !== 'benutzer';

  const aussen = geltungsbereichPruefen(b, k, ziel, standort, wirksame, dritter, jetzt);
  if (aussen !== null) return aussen;

  for (const r of ROLLEN) {
    for (const z of wirksame) {
      if (z.rolle === r && gewaehrt(a.zellen[r], z, standort)) return ERLAUBT(standort, r);
    }
  }
  let noetig: Rolle | null = null;
  let umfangNoetig: Umfang | null = null;
  if (dritter) {
    umfangNoetig = standort === null ? null : umfangFuer(a.zellen.unterstuetzer);
  } else {
    noetig =
      ROLLE_NOETIG_REIHENFOLGE.find((r) => {
        const c = a.zellen[r];
        return r === 'voltpilot_betrieb' ? c === 'P' : c === 'U' || (c === 'S' && standort !== null);
      }) ?? null;
  }
  const weg = noetig === 'voltpilot_betrieb' ? TEXTE.weg_voltpilot : wegZumKundenadministrator(k);
  return {
    darf: false,
    sichtbar: true,
    http: 403,
    grund: 'recht_fehlt',
    standort,
    rolle: null,
    rolleNoetig: noetig,
    umfangNoetig,
    text: TEXTE.recht_fehlt + (weg === null ? '' : ` ${weg}`),
  };
}

// ─────────────────────────────────────────────────── Vier-Augen (AP-08 E8)

/**
 * Darf `b` diese Korrektur freigeben oder zurücknehmen? (AP-08 E8, IP-15 — Familie
 * `vieraugen`.) Erst `darf` — was dort nicht erlaubt ist, bleibt, wie es ist. Dann: der
 * Bearbeiter gibt nur bei Vier-Augen aus frei und nimmt nur bei aus und nur die eigene zurück
 * (sonst 403 `recht_fehlt`, `rolleNoetig` Energiemanager); bei an gibt nie der Ersteller frei —
 * auch mit Recht (403 `zweite_person_noetig`).
 *
 * @param ersteller Kennung der Person, die die Korrektur angelegt hat; `null` = Vorschlag des Systems
 * @param vierAugen die Einstellung des Unternehmens zum Zeitpunkt DIESER Entscheidung
 */
export function korrekturEntscheiden(
  m: Matrix,
  b: Benutzer,
  k: Kundenbereich,
  aktion: 'korrektur.freigeben' | 'korrektur.zuruecknehmen',
  ziel: Ziel,
  jetzt: string,
  ersteller: string | null,
  vierAugen: boolean,
): DarfErgebnis {
  const freigeben = aktion === 'korrektur.freigeben';
  if (!freigeben && aktion !== 'korrektur.zuruecknehmen') {
    throw new Error(`keine Entscheidung über eine Korrektur: ${aktion}`);
  }
  const d = darf(m, b, k, aktion, ziel, jetzt);
  if (!d.darf) return d;
  const eigene = ersteller !== null && ersteller === b.kennung;
  if (d.rolle === 'bearbeiter' && (vierAugen || (!freigeben && !eigene))) {
    const weg = wegZumKundenadministrator(k);
    return {
      ...d,
      darf: false,
      http: 403,
      grund: 'recht_fehlt',
      rolle: null,
      rolleNoetig: 'energiemanager',
      text: TEXTE.recht_fehlt + (weg === null ? '' : ` ${weg}`),
    };
  }
  if (freigeben && vierAugen && eigene) {
    // Der Weg nennt nie den Ersteller selbst.
    const weg = wegZumKundenadministrator({
      ...k,
      kundenadministratoren: k.kundenadministratoren.filter((p) => p.kennung !== b.kennung),
    });
    return {
      ...d,
      darf: false,
      http: 403,
      grund: 'zweite_person_noetig',
      rolle: null,
      text: TEXTE.zweite_person + (weg === null ? '' : ` ${weg}`),
    };
  }
  return d;
}

// ────────────────────────────────────────────────────── sichtbare Standorte

export interface StandortSicht {
  kennzeichen: string;
  name: string;
  rollen: Rolle[];
  umfang: Umfang | null;
}

/** Ein Standort, dessen Zuweisung erst später wirkt (§4.8 „eingerichtet"). */
export interface Kuenftig {
  standort: string;
  ab: string;
  text: string;
}

export interface SichtErgebnis {
  standorte: StandortSicht[];
  unternehmensweit: boolean;
  kuenftig: Kuenftig[];
  text: string | null;
  teilansicht: TeilansichtErgebnis;
}

/** sichtbareStandorte(benutzer) zum Zeitpunkt `jetzt` — die Menge, über die alles läuft. */
export function sichtbareStandorte(
  b: Benutzer,
  k: Kundenbereich,
  jetzt: string,
  zeitzone: string = VORGABE_ZEITZONE,
): SichtErgebnis {
  const gesamt = k.standorte.length;
  if (b.zustand !== 'aktiv') {
    return { standorte: [], unternehmensweit: false, kuenftig: [], text: null, teilansicht: teilansicht([], gesamt, false) };
  }
  const wirksame = b.zuweisungen.filter((z) => wirksam(z, jetzt));
  const uw = wirksame.some(unternehmensweit);
  const sichtbar: StandortSicht[] = [];
  const spaeter: Kuenftig[] = [];
  for (const s of k.standorte) {
    const hier = wirksame.filter((z) => deckt(z, s.kennzeichen));
    const rollen = ROLLEN.filter((r) => hier.some((z) => z.rolle === r));
    if (rollen.length > 0) {
      const umfaenge = hier.flatMap((z) => (z.umfang === null ? [] : [z.umfang]));
      const umfang =
        umfaenge.length === 0
          ? null
          : umfaenge.reduce((x, y) => (UMFAENGE.indexOf(y) > UMFAENGE.indexOf(x) ? y : x));
      sichtbar.push({ kennzeichen: s.kennzeichen, name: s.name, rollen, umfang });
      continue;
    }
    // Dritte sehen den Kundenbereich erst mit einer wirksamen Unterstützung (§4.6).
    if (b.konto !== 'benutzer') continue;
    const ab = b.zuweisungen
      .filter((z) => kuenftig(z, jetzt) && deckt(z, s.kennzeichen))
      .map((z) => z.gueltigAb)
      .sort((x, y) => ms(x) - ms(y))[0];
    if (ab !== undefined) {
      spaeter.push({ standort: s.kennzeichen, ab, text: text('wirkt_ab', { datum: datum(ab, zeitzone) }) });
    }
  }
  let satz: string | null = null;
  if (sichtbar.length === 0 && b.konto === 'benutzer') {
    satz = TEXTE.kein_standort;
    const namen = k.kundenadministratoren.map((p) => p.name);
    if (namen.length > 0) {
      satz += ` ${text(namen.length === 1 ? 'kein_standort_ein_weg' : 'kein_standort_wege', {
        namen: aufzaehlung(namen),
      })}`;
    }
  }
  return {
    standorte: sichtbar,
    unternehmensweit: uw,
    kuenftig: spaeter,
    text: satz,
    teilansicht: teilansicht(
      sichtbar.map((s) => s.name),
      gesamt,
      uw,
    ),
  };
}

// ─────────────────────────────────────────────────────────────── Teilansicht

/**
 * Die Teilansicht-Regel (E10): die Unternehmensebene gibt es ab zwei
 * zugänglichen Standorten; mit weniger als allen ist sie eine Teilansicht.
 * Unternehmensweite Objekte sehen nur unternehmensweite Rollen (R-A1).
 */
export interface TeilansichtErgebnis {
  sichtbar: number;
  gesamt: number;
  unternehmensebene: boolean;
  teilansicht: boolean;
  kopfzeile: string | null;
  exportKopfzeile: string | null;
  unternehmensweiteObjekte: boolean;
}

/** teilansicht(n, m) — `namen` sind die n sichtbaren Standorte in Anzeige-Reihenfolge. */
export function teilansicht(namen: string[], gesamt: number, uw: boolean): TeilansichtErgebnis {
  const n = namen.length;
  const ebene = n >= 2;
  const teil = ebene && n < gesamt;
  const zahlen = { n: String(n), m: String(gesamt) };
  return {
    sichtbar: n,
    gesamt,
    unternehmensebene: ebene,
    teilansicht: teil,
    kopfzeile: teil ? text('teilansicht', zahlen) : null,
    exportKopfzeile: teil ? text('teilansicht_export', { namen: namen.join(', '), ...zahlen }) : null,
    unternehmensweiteObjekte: uw,
  };
}

/** Ein Wert je Messstelle mit ihrem Standort — `kwh === null` heißt „nicht gemessen". */
export interface Wert {
  messstelle: string;
  standort: string;
  kwh: number | null;
}

export interface SummeErgebnis {
  kwh: number | null;
  messstellen: string[];
  teilansicht: { sichtbar: number; gesamt: number };
}

/**
 * Summiert NUR über die sichtbaren Standorte (R-A2). Fehlt ein Eingang, fehlt
 * die Summe ganz — nie eine Teilsumme, nie „Rest" (R-A3, null ≠ 0).
 */
export function summe(werte: Wert[], sichtbar: string[], gesamt: number): SummeErgebnis {
  const drin = werte.filter((w) => sichtbar.includes(w.standort));
  const luecke = drin.some((w) => w.kwh === null);
  const kwh = luecke || drin.length === 0 ? null : drin.reduce((s, w) => s + (w.kwh as number), 0);
  return { kwh, messstellen: drin.map((w) => w.messstelle), teilansicht: { sichtbar: sichtbar.length, gesamt } };
}

/** Der Geltungsbereich eines Objekts: das Unternehmen oder eine Liste von Standorten. */
export interface Geltungsbereich {
  unternehmen: boolean;
  standorte: string[];
}

/**
 * R-A1/R-A5/R-A6: sichtbar, wenn VOLLSTÄNDIG im Zugriff; ein Unternehmens-Objekt
 * nur für unternehmensweite Rollen. Ein Objekt über sichtbare UND fremde
 * Standorte fehlt mit dem Hinweis — ohne Namen, ohne Wert, nie teilgerechnet.
 */
export function geltungsbereich(
  g: Geltungsbereich,
  sichtbar: string[],
  uw: boolean,
): { sichtbar: boolean; hinweis: string | null } {
  if (uw) return { sichtbar: true, hinweis: null };
  if (g.unternehmen) return { sichtbar: false, hinweis: null };
  const drin = g.standorte.filter((s) => sichtbar.includes(s)).length;
  if (drin === g.standorte.length) return { sichtbar: true, hinweis: null };
  return { sichtbar: false, hinweis: drin > 0 ? TEXTE.standortuebergreifend : null };
}

// ─────────────────────────────────────────────────────────────── OCPP-Stufe

export interface OcppErgebnis {
  stufe: OcppStufe;
  sichtbar: boolean;
  rolle: Rolle | null;
}

/**
 * Die OCPP-Stufe an einem Standort AUS DER ZUWEISUNG (E13, Wortlaut): CUSTOMER =
 * Bedienberechtigt/Unterstützer-Bedienen, SITE_ADMIN = Kundenadministrator/
 * Bedienberechtigt je E4, PLATFORM = VoltPilot. Energiemanager, Bearbeiter und
 * Leser haben keine Stufe (Achsentrennung).
 */
export function ocppStufe(b: Benutzer, k: Kundenbereich, standort: string, jetzt: string): OcppErgebnis {
  const keine = (sichtbar: boolean): OcppErgebnis => ({ stufe: 'keine', sichtbar, rolle: null });
  if (b.zustand !== 'aktiv') return keine(false);
  if (b.konto === 'plattform') return { stufe: 'PLATFORM', sichtbar: true, rolle: 'voltpilot_betrieb' };
  const hier = b.zuweisungen.filter((z) => wirksam(z, jetzt) && deckt(z, standort));
  if (!k.standorte.some((s) => s.kennzeichen === standort) || hier.length === 0) return keine(false);
  for (const r of ['kundenadministrator', 'bedienberechtigt'] as const) {
    if (hier.some((z) => z.rolle === r)) return { stufe: 'SITE_ADMIN', sichtbar: true, rolle: r };
  }
  if (hier.some((z) => z.rolle === 'unterstuetzer' && z.umfang === 'einrichten_und_bedienen')) {
    return { stufe: 'CUSTOMER', sichtbar: true, rolle: 'unterstuetzer' };
  }
  return keine(true);
}

// ─────────────────────────────────────────────────────────── Unterstützung

/** Das Partner- oder VoltPilot-Konto hinter einer Unterstützung. */
export interface Unterstuetzer {
  name: string;
  organisation: string;
  anzeigename: string;
}

/** Eine gewährte (oder nur erbetene: `gewaehrtAm === null`) Unterstützung (§4.6). */
export interface Unterstuetzung {
  art: Art;
  umfang: Umfang;
  standorte: string[];
  gewaehrtAm: string | null;
  gueltigAb: string;
  gueltigBis: string | null;
  beendetAm: string | null;
  beendetVon: string | null;
  unterstuetzer: Unterstuetzer | null;
  grund: string | null;
}

export interface UnterstuetzungErgebnis {
  zustand: UnterstuetzungsZustand;
  endet: string | null;
  beendetDurch: 'zeitablauf' | 'kundenadministrator' | null;
  bannerKunde: string | null;
  bannerUnterstuetzer: string | null;
  urheber: string;
  erinnerung: boolean;
  text: string | null;
}

/**
 * Zustand, Banner und Urheber einer Unterstützung zum Zeitpunkt `jetzt`
 * (§4.6–§4.8): nicht gewährt → entwurf · „gültig ab" in der Zukunft →
 * eingerichtet · gültig → aktiv (Banner, Erinnerung 7 Tage vor dem Ende) ·
 * beendet oder abgelaufen → archiviert.
 */
export function unterstuetzung(
  u: Unterstuetzung,
  k: Kundenbereich,
  jetzt: string,
  zeitzone: string = VORGABE_ZEITZONE,
): UnterstuetzungErgebnis {
  const anzeigename = u.unterstuetzer?.anzeigename ?? '';
  const urheber =
    u.art === 'installateur'
      ? text('urheber_installateur', { anzeigename })
      : u.art === 'voltpilot'
        ? TEXTE.urheber_voltpilot
        : TEXTE.urheber_notfall;
  const ablauf = bisZeitpunkt(u.gueltigBis, zeitzone);
  const vorzeitig = u.beendetAm !== null && (ablauf === null || ms(u.beendetAm) < ms(ablauf));
  const endet = vorzeitig ? u.beendetAm : ablauf;
  // In Kundensprache heißt das Ende einer Unterstützung ihr Enddatum („15.12.2026“);
  // nur der Notfall-Zugriff nennt seinen Zeitpunkt („19.11.2026 22:15“).
  const enddatum = u.gueltigBis !== null && istTag(u.gueltigBis) ? datumText(u.gueltigBis) : null;
  const ohneBanner = { bannerKunde: null, bannerUnterstuetzer: null, urheber, erinnerung: false };
  if (u.gewaehrtAm === null) {
    return { zustand: 'entwurf', endet, beendetDurch: null, ...ohneBanner, text: null };
  }
  if (endet !== null && ms(jetzt) >= ms(endet)) {
    const tag = !vorzeitig && enddatum !== null ? enddatum : datum(endet, zeitzone);
    const satz = !vorzeitig
      ? text('endete_zeitablauf', { datum: tag })
      : u.beendetVon === null
        ? text('beendet', { datum: tag })
        : text('beendet_von', { datum: tag, name: u.beendetVon });
    return {
      zustand: 'archiviert',
      endet,
      beendetDurch: vorzeitig ? 'kundenadministrator' : 'zeitablauf',
      ...ohneBanner,
      text: satz,
    };
  }
  if (ms(jetzt) < ms(u.gueltigAb)) {
    return {
      zustand: 'eingerichtet',
      endet,
      beendetDurch: null,
      ...ohneBanner,
      text: text('wirkt_ab', { datum: datum(u.gueltigAb, zeitzone) }),
    };
  }
  const standorte = aufzaehlung(u.standorte.map((s) => standortName(k, s)));
  const bis = endet === null ? '' : (enddatum ?? endeText(endet, zeitzone));
  const umfang = UMFANG_KUNDENWORT[u.umfang];
  const kunde =
    u.art === 'installateur'
      ? text('banner_installateur', { anzeigename, standorte, ende: bis, umfang })
      : u.art === 'voltpilot'
        ? text('banner_voltpilot', { standorte, ende: bis, umfang })
        : text('banner_notfall', { standorte, ende: bis, grund: u.grund ?? '' });
  const erinnerung =
    u.art !== 'notfall' && endet !== null && ms(endet) - ms(jetzt) <= ERINNERUNG_TAGE * 24 * 3600 * 1000;
  return {
    zustand: 'aktiv',
    endet,
    beendetDurch: null,
    bannerKunde: kunde,
    bannerUnterstuetzer: text('banner_unterstuetzer', { kundenbereich: k.name, standorte, ende: bis }),
    urheber,
    erinnerung,
    text: null,
  };
}

/** Ein Antrag im Gewähren-Dialog (bzw. der Notfall-Zugriff von VoltPilot). */
export interface Antrag {
  art: Art;
  umfang: Umfang | null;
  standorte: string[];
  gueltigAb: string;
  gueltigBis: string | null;
  grund: string | null;
}

export interface GewaehrenErgebnis {
  gueltig: boolean;
  http: number;
  grund: Grund;
  text: string | null;
  umfang: Umfang | null;
  endet: string | null;
}

/** Die Vorgabe je Art (E9): VoltPilot „Ansehen", Installateur „Einrichten und Bedienen". */
export function vorgabeUmfang(art: Art): Umfang {
  return art === 'installateur' ? 'einrichten_und_bedienen' : 'ansehen';
}

function abgelehnt(g: 'standort_fehlt' | 'hoechstens_12_monate' | 'grund_fehlt'): GewaehrenErgebnis {
  return { gueltig: false, http: GRUENDE[g], grund: g, text: TEXTE[g], umfang: null, endet: null };
}

/**
 * Prüft einen Antrag (E6/E8/E9, §5.9): mindestens ein Standort · Notfall mit
 * Grund und genau 24 h · sonst Enddatum Pflicht und höchstens 12 Kalendermonate
 * · ohne Umfang die Vorgabe je Art.
 */
export function gewaehren(a: Antrag, zeitzone: string = VORGABE_ZEITZONE): GewaehrenErgebnis {
  if (a.standorte.length === 0) return abgelehnt('standort_fehlt');
  const umfang = a.umfang ?? vorgabeUmfang(a.art);
  if (a.art === 'notfall') {
    if (a.grund === null || a.grund.trim() === '') return abgelehnt('grund_fehlt');
    const endet = new Date(ms(a.gueltigAb) + NOTFALL_STUNDEN * 3600 * 1000).toISOString();
    return { gueltig: true, http: 201, grund: 'erlaubt', text: null, umfang, endet };
  }
  if (a.gueltigBis === null || !hoechstensZwoelfMonate(a.gueltigAb, a.gueltigBis, zeitzone)) {
    return abgelehnt('hoechstens_12_monate');
  }
  return { gueltig: true, http: 201, grund: 'erlaubt', text: null, umfang, endet: bisZeitpunkt(a.gueltigBis, zeitzone) };
}

/** Enddatum ≤ der Tag von „ab“ + 12 Kalendermonate, am Standort (29.02. → 28.02.). */
function hoechstensZwoelfMonate(ab: string, enddatum: string, zone: string): boolean {
  const [j, mo, t] = ortszeit(ab, zone);
  const jahr = j + HOECHSTENS_MONATE / 12;
  const letzterTag = new Date(Date.UTC(jahr, mo, 0)).getUTCDate();
  return enddatum <= `${jahr}-${zwei(mo)}-${zwei(Math.min(t, letzterTag))}`;
}

// ─────────────────────────────────────────────────────────────────── Entzug

/** Ein gesetzter Handeingriff: wer ihn gesetzt hat, wo und bis wann. */
export interface Handeingriff {
  standort: string;
  bis: string;
  gesetztVon: string;
  setzer: Benutzer;
}

/**
 * E15: ein Entzug beendet keinen Handeingriff — er wirkt bis zu seinem Ablauf,
 * nur sein Etikett ändert sich („gesetzt von Murat Demirci (Bedienrecht beendet
 * am 14.11.2026 09:02)").
 */
export function handeingriff(
  m: Matrix,
  h: Handeingriff,
  k: Kundenbereich,
  jetzt: string,
  zeitzone: string = VORGABE_ZEITZONE,
): { wirkt: boolean; etikett: string } {
  const wirkt = ms(jetzt) < ms(h.bis);
  const a = aktionAus(m, 'handeingriff.setzen');
  const noch = darf(m, h.setzer, k, a.kennung, { standort: h.standort, anlage: null, stichtag: null }, jetzt);
  let beendet: string | null = null;
  if (!noch.darf) {
    for (const z of h.setzer.zuweisungen) {
      const e = ende(z);
      if (vorbei(z, jetzt) && gewaehrt(a.zellen[z.rolle], z, h.standort) && e !== null) {
        if (beendet === null || ms(e) > ms(beendet)) beendet = e;
      }
    }
  }
  const etikett =
    beendet === null
      ? text('gesetzt_von', { urheber: h.gesetztVon })
      : text('bedienrecht_beendet', { urheber: h.gesetztVon, zeitpunkt: datumZeit(beendet, zeitzone) });
  return { wirkt, etikett };
}

/** Eine Änderung an den Rechten einer Person (§4.7, §5.2, A8, A9). */
export interface Aenderung {
  art: AenderungsArt;
  rolle: Rolle | null;
  standorte: string[] | null;
}

export interface AenderungErgebnis {
  erlaubt: boolean;
  http: number;
  grund: Grund;
  rolleNoetig: Rolle | null;
  text: string | null;
}

/**
 * Darf `handelnder` diese Änderung an `betroffener` vornehmen? Erst das Recht
 * (zuweisen/entziehen = Rollen verwalten, sperren/entfernen = Benutzer
 * verwalten), dann: nie die eigenen Rechte (409), nie den letzten
 * Kundenadministrator (409), eine Rolle je Standort nie ohne Standort (422).
 */
export function zuweisungAendern(
  m: Matrix,
  handelnder: Benutzer,
  betroffener: Person,
  a: Aenderung,
  k: Kundenbereich,
  jetzt: string,
): AenderungErgebnis {
  const aktion = a.art === 'zuweisen' || a.art === 'entziehen' ? 'zuweisung.verwalten' : 'benutzer.verwalten';
  const d = darf(m, handelnder, k, aktion, { standort: null, anlage: null, stichtag: null }, jetzt);
  if (!d.darf) return { erlaubt: false, http: d.http, grund: d.grund, rolleNoetig: d.rolleNoetig, text: d.text };
  if (handelnder.kennung === betroffener.kennung) {
    return { erlaubt: false, http: 409, grund: 'eigene_zuweisung', rolleNoetig: null, text: null };
  }
  const nimmt =
    a.art === 'sperren' || a.art === 'entfernen' || (a.art === 'entziehen' && a.rolle === 'kundenadministrator');
  const istKundenadministrator = k.kundenadministratoren.some((p) => p.kennung === betroffener.kennung);
  if (nimmt && istKundenadministrator && k.kundenadministratoren.length <= 1) {
    return {
      erlaubt: false,
      http: 409,
      grund: 'letzter_kundenadministrator',
      rolleNoetig: null,
      text: text('letzter_kundenadministrator', { kundenbereich: k.name }),
    };
  }
  const jeStandort = a.rolle === 'bearbeiter' || a.rolle === 'bedienberechtigt' || a.rolle === 'leser';
  if (a.art === 'zuweisen' && jeStandort && (a.standorte === null || a.standorte.length === 0)) {
    return { erlaubt: false, http: 422, grund: 'standort_fehlt', rolleNoetig: null, text: TEXTE.standort_fehlt };
  }
  return { erlaubt: true, http: 200, grund: 'erlaubt', rolleNoetig: null, text: null };
}

// ───────────────────────────────────────────────────────────────────── Text

/** [Jahr, Monat, Tag, Stunde, Minute, Sekunde] in der Zeitzone des Kundenbereichs. */
function ortszeit(iso: string, zone: string): number[] {
  // 'sv-SE' liefert die ISO-Schreibweise "2026-12-15 00:00:00" — dieselbe Art, eine
  // Zeitzone anzuwenden, wie `uemsZustand.ts`.
  const s = new Date(iso).toLocaleString('sv-SE', { timeZone: zone });
  const m = /(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m === null) throw new Error(`unlesbarer Zeitpunkt: ${iso}`);
  return m.slice(1).map(Number);
}

const zwei = (n: number): string => String(n).padStart(2, '0');

/** „14.11.2026 09:02" — Datum und Uhrzeit in der Zeitzone des Kundenbereichs. */
export function datumZeit(iso: string, zeitzone: string = VORGABE_ZEITZONE): string {
  const [j, mo, t, h, mi] = ortszeit(iso, zeitzone);
  return `${zwei(t)}.${zwei(mo)}.${j} ${zwei(h)}:${zwei(mi)}`;
}

/** Ein Enddatum um Mitternacht heißt „15.12.2026", sonst mit Uhrzeit „19.11.2026 22:15". */
export function endeText(iso: string, zeitzone: string = VORGABE_ZEITZONE): string {
  const [, , , h, mi, s] = ortszeit(iso, zeitzone);
  return h === 0 && mi === 0 && s === 0 ? datum(iso, zeitzone) : datumZeit(iso, zeitzone);
}
