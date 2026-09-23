/**
 * UEMS AP-17 IP-20 (U1–U6, E7 = A, E8 = A): das reine Bild des Reiters „Vergleich mit Bezugsbasis“ an der Kennzahl.
 * Es liest nur den Leser `GET /api/v1/kennzahlen/{id}/vergleich` (Vertrag `bezugsbasis.md` §16, OpenAPI
 * `BezugsbasisVergleich*`). **Hier wird nichts gerechnet und kein Urteil formuliert:** erwartet, Δ, Band, Urteil,
 * Grund, Kennzeichen und die Sätze kommen vom Leser; das Portal rundet nur zur Anzeige (M5, `runden` aus
 * `bezugsbasis.ts`) und setzt die Zahlen ins deutsche Format. Die rohe Zeile (Operation `roh`) trägt nie ein Urteil-Wort
 * (U1, VG3) — nur „mehr“/„weniger“ und „ohne Urteil“.
 */
import { runden } from './bezugsbasis';
import type { Bezugsbasis } from './api';
import { kannBezugsbasis } from './bezugsbasisAnlegen';
import { tagDeutsch } from './bezugsbasisUebersicht';
import methodenKatalog from './bezugsbasis/bezugsbasis-methoden.json';
import { UEMS_BEREINIGT, UEMS_BEZUGSBASIS, UEMS_BEZUGSBASIS_URTEILE, UEMS_ERWARTET, UEMS_REFERENZPERIODE } from './glossar';

// ------------------------------------------------------------------ Antwort des Lesers (OpenAPI BezugsbasisVergleich*)

export type VergleichUrteil = 'besser' | 'schlechter' | 'im_rahmen' | 'ohne_urteil' | 'nicht_anwendbar';
export type VergleichGrund =
  | 'basis_fehlt' | 'basis_beendet' | 'zu_wenig_perioden' | 'variable_fehlt' | 'variable_ausserhalb'
  | 'variablen_abhaengig' | 'keine_werte' | 'periode_nicht_zu_ende';
export type VergleichRichtung = 'mehr' | 'weniger' | 'gleich';

export interface BezugsbasisVergleichFassung {
  fassung: number;
  methode: 'verhaeltnis' | 'regression_eine_variable' | 'regression_zwei_variablen' | 'gradtage';
  referenzperiode: string;
  datenlage: 'vollstaendig' | 'vorlaeufig';
  gilt_ab: string;
  gilt_bis: string | null;
}

export interface BezugsbasisVergleichBedingung {
  position: 1 | 2;
  quelle: 'bezugsgroesse' | 'kennzahl';
  kennzeichen: string | null;
  name: string;
  wert: string | null;
  einheit: string;
  fassung: number | null;
  version: number | null;
  zustand: string | null;
}

export interface BezugsbasisVergleichMonat {
  periode: string;
  beschriftung: string;
  roh: {
    gemessen: string | null;
    vorher: string | null;
    delta_prozent: string | null;
    richtung: VergleichRichtung | null;
    variable_delta_prozent: string | null;
    urteil: 'ohne_urteil';
  };
  bereinigt: {
    fassung: BezugsbasisVergleichFassung | null;
    gemessen: { wert: string | null; einheit: string; version: number | null; zustand: string | null };
    bedingung: BezugsbasisVergleichBedingung[];
    erwartet: string | null;
    delta_prozent: string | null;
    band_prozent: string | null;
    richtung: VergleichRichtung | null;
    urteil: VergleichUrteil;
    grund: VergleichGrund | null;
    kennzeichen: string[];
  };
  satz: string;
}

export interface BezugsbasisVergleichZeitraum {
  fassung: number | null;
  gemessen: string | null;
  erwartet: string | null;
  delta_prozent: string | null;
  band_prozent: string | null;
  richtung: VergleichRichtung | null;
  urteil: VergleichUrteil;
  grund: VergleichGrund | null;
  monate: string | null;
  kennzeichen: string[];
  satz: string;
}

export interface BezugsbasisVergleich {
  kennzahl: { id: string; kennzeichen: string; name: string; einheit: string | null; einheit_anzeige: string | null };
  bezugsbasis: { id: string; kennzeichen: string; beendet_zum: string | null; beendet_grund: string | null } | null;
  von: string;
  bis: string;
  zeitzone: string;
  monate: BezugsbasisVergleichMonat[];
  zeitraum: BezugsbasisVergleichZeitraum;
  staende: { nummer: number; am: string }[];
  stand_satz: string;
  satz: string | null;
}

/** Die Wahl des Reiters; ohne `von`/`bis` nimmt der Leser die zwölf abgeschlossenen Monate vor dem laufenden. */
export interface BezugsbasisVergleichWahl {
  basis?: string;
  von?: string;
  bis?: string;
}

/** Was der Vergleich von einer Basis der Kennzahl braucht — aus derselben Liste wie der Reiter „Bezugsbasis“ (IP-9). */
export type BezugsbasisDerKennzahl = Pick<Bezugsbasis, 'id' | 'kennzeichen' | 'beendet_zum'>;

// ------------------------------------------------------------------ Wörter der Fläche

export const VERGLEICH_REITER = `Vergleich mit ${UEMS_BEZUGSBASIS}`;
/** Der erste Reiter der Kennzahl-Seite und die Regel B2 — eine Quelle mit IP-9 (`bezugsbasisAnlegen.ts`). */
export { REITER_KENNZAHL } from './bezugsbasisAnlegen';
/** B2: eine Bezugsbasis — und damit ein Vergleich — gibt es nur an Quotient und Zusammenfassung, nie an einem Anteil. */
export const kannVergleich = kannBezugsbasis;
export const VERGLEICH_ROH = 'Roh';
export const VERGLEICH_BEREINIGT = UEMS_BEREINIGT;
export const VERGLEICH_OHNE_URTEIL = 'ohne Urteil';
export const VERGLEICH_ZEITRAUM = 'Zeitraum';
export const VERGLEICH_VON = 'Von Monat';
export const VERGLEICH_BIS = 'Bis Monat';
export const VERGLEICH_BASIS_WAHL = UEMS_BEZUGSBASIS;
export const VERGLEICH_SPALTEN = {
  monat: 'Monat',
  gemessen: 'gemessen',
  vormonat: 'zum Vormonat',
  bedingung: 'Bedingung',
  erwartet: UEMS_ERWARTET,
  delta: 'Δ',
  urteil: 'Urteil (Band)',
  kennzeichen: 'Kennzeichen',
} as const;
export const VERGLEICH_LADEFEHLER = 'Der Vergleich konnte nicht geladen werden.';
export const VERGLEICH_ZUM_REITER_BEZUGSBASIS = `Die ${UEMS_BEZUGSBASIS} legen Sie im Reiter „${UEMS_BEZUGSBASIS}“ fest.`;
export const VERGLEICH_ZEITRAUM_UNGUELTIG = 'Der erste Monat muss vor dem letzten liegen.';

const METHODE_WORT: Record<string, string> = Object.fromEntries(
  (methodenKatalog as { methoden: { kennung: string; kundenwort: string }[] }).methoden.map((m) => [m.kennung, m.kundenwort]),
);

// ------------------------------------------------------------------ Zahlen (nur Anzeige, M5)

/** Dezimaltext → deutsch: Dezimalkomma, Tausender mit Leerzeichen, echtes Minus (§5.8). */
export function deZahl(t: string): string {
  const minus = t.startsWith('-');
  const [vorn, hinten = ''] = (minus ? t.slice(1) : t).split('.');
  return `${minus ? '−' : ''}${vorn.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${hinten ? `,${hinten}` : ''}`;
}

/** Eine Zahl ohne Nullen am Ende (wie `zahl` im Leser): „250000.000“ → „250 000“. */
export const zahlKurz = (t: string) => deZahl(t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t);

/** Menge in ganzen Einheiten (M5): „78 000 kWh“; ohne Wert „—“. */
export const menge = (wert: string | null, einheit: string) => (wert === null ? '—' : `${deZahl(runden(wert, 0))} ${einheit}`);

/** Ein Prozentwert ohne Vorzeichen, eine Stelle: „12,9 %“. */
const prozentBetrag = (delta: string) => `${deZahl(runden(delta.replace(/^-/, ''), 1))} %`;

/** Band ohne Null am Ende: „2.0“ → „± 2 %“, „4.6“ → „± 4,6 %“. */
export function band(prozent: string | null): string | null {
  if (prozent === null) return null;
  const t = runden(prozent, 1).replace(/\.0$/, '');
  return `± ${deZahl(t)} %`;
}

/** Δ mit dem Richtungswort des Lesers: „12,9 % mehr“ · „3,5 % weniger“ · „0,0 % gleich“ wird „gleich“. */
export function deltaText(delta: string | null, richtung: VergleichRichtung | null): string | null {
  if (delta === null) return null;
  if (richtung === 'gleich' || richtung === null) return prozentBetrag(delta);
  return `${prozentBetrag(delta)} ${richtung}`;
}

// ------------------------------------------------------------------ Das Bild

export interface RohBild {
  gemessen: string;
  /** „8,8 % weniger als im Vormonat“ — ohne Urteil-Wort (U1, VG3); ohne Vormonat `null`. */
  veraenderung: string | null;
  /** „Produktionsmenge: 21,9 % weniger“ — die Veränderung der Bedingung, ebenfalls ohne Urteil. */
  bedingung: string | null;
  ohneUrteil: string;
}

export type BereinigtBild =
  | {
      art: 'zahl';
      gemessen: string;
      bedingung: string;
      erwartet: string;
      delta: string | null;
      /** Das Urteil-Wort aus `glossar.ts` — oder „ohne Urteil“ bei unvollständigen Werten (G2). */
      urteil: string;
      band: string | null;
      urteilKlasse: VergleichUrteil;
      kennzeichen: string[];
    }
  | { art: 'grund'; grund: VergleichGrund | null; kennzeichen: string[] };

export interface MonatBild {
  periode: string;
  beschriftung: string;
  roh: RohBild;
  bereinigt: BereinigtBild;
  /** „Version 2“ des gespeicherten Zählers, wenn der Leser eine liefert. */
  version: string | null;
  /** Der Kundensatz des Lesers (§10/§16), unverändert. */
  satz: string;
}

export interface ZeitraumBild {
  titel: string;
  gemessen: string;
  erwartet: string;
  delta: string | null;
  urteil: string;
  band: string | null;
  urteilKlasse: VergleichUrteil;
  /** „3 von 4 Monaten“ — nur, wenn der Zeitraum `ohne_urteil` ist (U5). */
  monate: string | null;
  kennzeichen: string[];
  satz: string;
}

export type VergleichBild =
  | { art: 'leer'; satz: string; hinweis: string; standSatz: string }
  | {
      art: 'vergleich';
      basisZeile: string;
      zeitraum: ZeitraumBild;
      monate: MonatBild[];
      standSatz: string;
    };

/** Das Urteil-Wort — nur aus `glossar.ts`; `ohne_urteil` heißt „ohne Urteil“. */
export const urteilWort = (u: VergleichUrteil) => (u === 'ohne_urteil' ? VERGLEICH_OHNE_URTEIL : UEMS_BEZUGSBASIS_URTEILE[u]);

/** „bei 250 000 kg“ · zwei Einflussgrößen „bei 250 000 kg und 480 Kd“; ohne Wert „Produktionsmenge ohne Wert“. */
export function bedingungText(bedingung: BezugsbasisVergleichBedingung[]): string {
  const teile = [...bedingung]
    .sort((a, b) => a.position - b.position)
    .map((b) => (b.wert === null ? `${b.name} ohne Wert` : `${zahlKurz(b.wert)} ${b.einheit}`));
  return teile.length > 0 ? `bei ${teile.join(' und ')}` : '—';
}

function rohBild(m: BezugsbasisVergleichMonat): RohBild {
  const variable = m.bereinigt.bedingung.find((b) => b.position === 1)?.name ?? null;
  const veraenderung = deltaText(m.roh.delta_prozent, m.roh.richtung);
  const variableDelta = m.roh.variable_delta_prozent;
  const variableRichtung: VergleichRichtung | null =
    variableDelta === null ? null : /^-/.test(variableDelta) ? 'weniger' : /^0(\.0+)?$/.test(variableDelta) ? 'gleich' : 'mehr';
  return {
    gemessen: menge(m.roh.gemessen, m.bereinigt.gemessen.einheit),
    veraenderung: veraenderung === null ? null : m.roh.richtung === 'gleich' ? 'gleich wie im Vormonat' : `${veraenderung} als im Vormonat`,
    bedingung: variable && variableDelta !== null ? `${variable}: ${deltaText(variableDelta, variableRichtung)}` : null,
    ohneUrteil: VERGLEICH_OHNE_URTEIL,
  };
}

function bereinigtBild(m: BezugsbasisVergleichMonat): BereinigtBild {
  const b = m.bereinigt;
  if (b.urteil === 'nicht_anwendbar' || b.erwartet === null) return { art: 'grund', grund: b.grund, kennzeichen: b.kennzeichen };
  return {
    art: 'zahl',
    gemessen: menge(b.gemessen.wert, b.gemessen.einheit),
    bedingung: bedingungText(b.bedingung),
    erwartet: menge(b.erwartet, b.gemessen.einheit),
    delta: deltaText(b.delta_prozent, b.richtung),
    urteil: urteilWort(b.urteil),
    band: band(b.band_prozent),
    urteilKlasse: b.urteil,
    kennzeichen: b.kennzeichen,
  };
}

/** „2026-11/2027-10“ → „November 2026 bis Oktober 2027“ (Monatsnamen aus den Beschriftungen des Lesers wären zu dünn). */
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monatWort = (jjjjmm: string) => `${MONATE[Number(jjjjmm.slice(5, 7)) - 1]} ${jjjjmm.slice(0, 4)}`;
export function referenzperiodeText(rp: string): string {
  const [von, bis] = rp.split('/');
  return !bis || von === bis ? monatWort(von) : `${monatWort(von)} bis ${monatWort(bis)}`;
}

/**
 * Die Basis-Zeile des Reiters: Kennzeichen, Fassung und Methode der Fassung am letzten Tag von `bis` (P4 — dieselbe,
 * gegen die der Zeitraum steht), Referenzperiode, Vorbehalt; eine beendete Basis sagt das Ende.
 */
export function basisZeile(v: BezugsbasisVergleich): string {
  const basis = v.bezugsbasis!;
  const fassung = [...v.monate].reverse().find((m) => m.bereinigt.fassung !== null)?.bereinigt.fassung ?? null;
  const teile = [`${UEMS_BEZUGSBASIS} ${basis.kennzeichen}`];
  if (fassung) {
    teile.push(`Fassung ${fassung.fassung}`);
    teile.push(METHODE_WORT[fassung.methode] ?? fassung.methode);
    teile.push(`${UEMS_REFERENZPERIODE} ${referenzperiodeText(fassung.referenzperiode)}`);
    if (fassung.datenlage === 'vorlaeufig') teile.push('vorläufig');
  }
  if (basis.beendet_zum) teile.push(`beendet am ${tagDeutsch(basis.beendet_zum)}${basis.beendet_grund ? ` (${basis.beendet_grund})` : ''}`);
  return teile.join(' · ');
}

/** S5: der jüngste Stand („Stand Nr. 1 vom 12.01.2028“) oder der Satz des Lesers („ungesichert — noch kein Stand“). */
export function standSatz(v: Pick<BezugsbasisVergleich, 'staende' | 'stand_satz'>): string {
  if (v.staende.length === 0) return v.stand_satz;
  const juengster = v.staende.reduce((a, b) => (b.nummer > a.nummer ? b : a));
  return `Stand Nr. ${juengster.nummer} vom ${tagDeutsch(juengster.am)}`;
}

function zeitraumBild(v: BezugsbasisVergleich): ZeitraumBild {
  const z = v.zeitraum;
  const einheit = v.monate[0]?.bereinigt.gemessen.einheit ?? v.kennzahl.einheit_anzeige ?? v.kennzahl.einheit ?? '';
  return {
    titel: `${monatWort(v.von)} bis ${monatWort(v.bis)}`,
    gemessen: menge(z.gemessen, einheit),
    erwartet: menge(z.erwartet, einheit),
    delta: deltaText(z.delta_prozent, z.richtung),
    urteil: urteilWort(z.urteil),
    band: z.urteil === 'nicht_anwendbar' ? null : band(z.band_prozent),
    urteilKlasse: z.urteil,
    monate: z.urteil === 'ohne_urteil' && z.monate ? `${z.monate} Monaten` : null,
    kennzeichen: z.kennzeichen,
    satz: z.satz,
  };
}

/** Das Bild des Reiters; ohne Bezugsbasis nur der Leer-Satz des Lesers (R10: kein Vergleich, kein Urteil). */
export function vergleichBild(v: BezugsbasisVergleich): VergleichBild {
  if (v.bezugsbasis === null) {
    return { art: 'leer', satz: v.satz ?? v.monate[0]?.satz ?? '', hinweis: VERGLEICH_ZUM_REITER_BEZUGSBASIS, standSatz: standSatz(v) };
  }
  return {
    art: 'vergleich',
    basisZeile: basisZeile(v),
    zeitraum: zeitraumBild(v),
    monate: v.monate.map((m) => ({
      periode: m.periode,
      beschriftung: m.beschriftung,
      roh: rohBild(m),
      bereinigt: bereinigtBild(m),
      version: m.bereinigt.gemessen.version === null ? null : `Version ${m.bereinigt.gemessen.version}`,
      satz: m.satz,
    })),
    standSatz: standSatz(v),
  };
}

/** Eine gültige Monatswahl: beide JJJJ-MM, `von` nicht nach `bis`. */
export const zeitraumGueltig = (von: string, bis: string) =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(von) && /^\d{4}-(0[1-9]|1[0-2])$/.test(bis) && von <= bis;

/** Die wählbaren Monate: `anzahl` Monate bis `bis` einschließlich, der jüngste zuerst — nur Kalender, keine Zahl. */
export function monatsOptionen(bis: string, anzahl = 60): { value: string; label: string }[] {
  let jahr = Number(bis.slice(0, 4));
  let monat = Number(bis.slice(5, 7));
  const optionen: { value: string; label: string }[] = [];
  for (let i = 0; i < anzahl; i++) {
    const wert = `${jahr}-${String(monat).padStart(2, '0')}`;
    optionen.push({ value: wert, label: monatWort(wert) });
    monat -= 1;
    if (monat === 0) { monat = 12; jahr -= 1; }
  }
  return optionen;
}
