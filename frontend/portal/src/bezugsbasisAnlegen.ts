import type {
  Bezugsbasis,
  BezugsbasisFassung,
  BezugsbasisFassungKurz,
  BezugsbasisGrundlagePeriode,
  Kennzahl,
  VariablenVorschlagKandidat,
} from './api';
import katalog from './bezugsbasis/bezugsbasis-methoden.json';
import { UEMS_BEZUGSBASIS, UEMS_EINFLUSSGROESSE, UEMS_ENERGIELEISTUNGSKENNZAHL, UEMS_REFERENZPERIODE } from './glossar';
import { QUOTIENT, ZUSAMMENFASSUNG } from './uemsKennzahl';
import { datumText } from './uemsOrtsbaum';

/**
 * Die reinen Ableitungen des Reiters „Bezugsbasis“ an der Kennzahl (UEMS AP-17 IP-9, §5.1, §5.8, §6.3): der leere
 * Zustand, die Basis-Zeile, das Kennzeichen im Register, die Monate der Referenzperiode aus der Vorschau-Antwort und die
 * Wahl der Methode aus dem Katalog (IP-5, Portal-Kopie `bezugsbasis/bezugsbasis-methoden.json`). Die Komponenten
 * (`components/BezugsbasisReiter.tsx`, `components/BezugsbasisAssistent.tsx`) zeigen nur, was hier entschieden wird.
 *
 * Kundenwörter nur aus `glossar.ts` (SP1); die Sätze sind die von §5.8 (`bezugsbasis.md` §10).
 */

// ------------------------------------------------------------------------------------------------ Wörter

export const REITER_KENNZAHL = 'Kennzahl';
export const REITER_BEZUGSBASIS = UEMS_BEZUGSBASIS;
export const KNOPF_ANLEGEN = `${UEMS_BEZUGSBASIS} anlegen`;
export const LEER_SATZ =
  'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.';
export const LADEFEHLER = 'Die Bezugsbasis konnte nicht geladen werden.';
export const AKTION_FEHLER = 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';
export const TITEL_ASSISTENT = `${UEMS_BEZUGSBASIS} anlegen`;
export const SCHRITTE = [UEMS_REFERENZPERIODE, 'Methode', 'Einflussgrößen', 'Statische Faktoren', 'Vorschau'] as const;
export const FILTER_NUR = `nur ${UEMS_ENERGIELEISTUNGSKENNZAHL}en`;
export const KNOPF_ENTWURF = 'Als Entwurf speichern';
export const KNOPF_BEANTRAGEN = 'Zur Freigabe beantragen';
export const KNOPF_FREIGEBEN = 'Freigeben';
export const KNOPF_ABLEHNEN = 'Ablehnen';
export const KNOPF_WEITER_BEARBEITEN = 'Entwurf bearbeiten';
export const KNOPF_MONATE = 'Monate prüfen';
export const BEGRUENDUNG = 'Begründung';
export const VIERAUGEN_HINWEIS =
  'Gilt in Ihrem Unternehmen das Vier-Augen-Prinzip, bleibt die Fassung beantragt, bis eine zweite Person sie freigibt oder ablehnt.';
export const ENTWURF_HINWEIS =
  'Die Vorschau ist als Entwurf gespeichert. Gültig wird die Fassung erst mit der Freigabe durch eine Person mit Begründung.';
export const FAKTOREN_HINWEIS =
  'Angekreuzte statische Faktoren werden mit dem Entwurf gespeichert — als Kopie ihres Werts am ersten Tag der Fassung.';
export const VERHAELTNIS_EINE =
  'Das Verhältnis rechnet mit genau einer Einflussgröße: der Bezugsgröße der Kennzahl. Eine zweite braucht ein Modell mit zwei Einflussgrößen.';
export const KOMMT = 'kommt';

export const FREIGABE_WORT: Record<BezugsbasisFassungKurz['freigabe_status'], string> = {
  entwurf: 'Entwurf',
  beantragt: 'zur Freigabe beantragt',
  freigegeben: 'freigegeben',
  abgelehnt: 'abgelehnt',
};

export const MONAT_WORT = { vorhanden: 'vorhanden', vorlaeufig: 'vorläufig', fehlt: 'fehlt' } as const;
export type MonatZustand = keyof typeof MONAT_WORT;

// ------------------------------------------------------------------------------------------------ Monate

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** „2026-10“ → „Oktober 2026“. */
export function monatText(jm: string): string {
  const [y, m] = jm.split('-');
  return `${MONATE[Number(m) - 1]} ${y}`;
}

/** „2026-10/2026-10“ → „Oktober 2026“; „2026-11/2027-10“ → „November 2026 bis Oktober 2027“. */
export function referenzperiodeText(rp: string): string {
  const [von, bis] = rp.split('/');
  return von === bis ? monatText(von) : `${monatText(von)} bis ${monatText(bis)}`;
}

const plus = (jm: string, n: number): string => {
  const [y, m] = jm.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

/** Die Zahl der Monate einer Referenzperiode, beide eingeschlossen. */
export function monateZwischen(von: string, bis: string): number {
  const [y1, m1] = von.split('-').map(Number);
  const [y2, m2] = bis.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

/**
 * Die wählbaren Monate: nur abgeschlossene (P1/P3 — der laufende Monat ist nie Teil der Referenzperiode), die jüngsten
 * zuerst; `heute` ist ein Tag JJJJ-MM-TT in der Zeitzone der Kennzahl.
 */
export function waehlbareMonate(heute: string, anzahl = 36): string[] {
  const letzter = plus(heute.slice(0, 7), -1);
  return Array.from({ length: anzahl }, (_, i) => plus(letzter, -i));
}

/** Vorschlag (§5.1): die letzten zwölf vollen Monate. */
export function vorschlagPeriode(heute: string): { von: string; bis: string } {
  const bis = plus(heute.slice(0, 7), -1);
  return { von: plus(bis, -11), bis };
}

/** Die Prüfung der Wahl vor dem Senden — die Route prüft dasselbe (P1) und hat das letzte Wort. */
export function periodeFehler(von: string, bis: string): string | null {
  if (!von || !bis) return 'Bitte wählen Sie den ersten und den letzten Monat.';
  if (bis < von) return 'Der letzte Monat liegt vor dem ersten.';
  return null;
}

/** Je Monat der Vorschau-Antwort: vorhanden (endgültig), vorläufig (noch nicht endgültig) oder fehlt (nur ein Grund). */
export function monatsZustaende(perioden: BezugsbasisGrundlagePeriode[] | undefined): { monat: string; text: string; zustand: MonatZustand }[] {
  return (perioden ?? []).map((p) => {
    const zustand: MonatZustand = p.grund || !p.kennzahl ? 'fehlt' : p.kennzahl.zustand === 'endgueltig' ? 'vorhanden' : 'vorlaeufig';
    return { monat: p.periode, text: monatText(p.periode), zustand };
  });
}

/** „vorläufig (1 von 12 Monaten)“ — nur unter der Mindestlänge (P2). */
export function vorlaeufigText(monate: number, mindest: number): string | null {
  return monate < mindest ? `vorläufig (${monate} von ${mindest} Monaten)` : null;
}

/** Die Gründe der Datenlage (P2/P3) als Kundensatz. */
export function datenlageSaetze(f: Pick<BezugsbasisFassung, 'datenlage' | 'datenlage_gruende' | 'monate' | 'mindest_monate'>): string[] {
  if (f.datenlage === 'vollstaendig') return [`vollständig (${f.monate} Monate)`];
  return f.datenlage_gruende.map((g) => {
    if (g.grund === 'monate') {
      const ohne = (g.ohne_wert as string[] | undefined) ?? [];
      return `${vorlaeufigText(f.monate, f.mindest_monate) ?? 'vorläufig'}${ohne.length ? ` · ohne Wert: ${ohne.map(monatText).join(', ')}` : ''}`;
    }
    if (g.grund === 'angeschnitten') return `${monatText(String(g.periode))} angeschnitten (ab ${/^\d{4}-\d{2}-\d{2}$/.test(String(g.ab)) ? datumText(String(g.ab)) : String(g.ab)})`;
    if (g.grund === 'vorlaeufige_werte') {
      return `noch nicht endgültige Werte: ${((g.perioden as string[] | undefined) ?? []).map(monatText).join(', ')}`;
    }
    return String(g.grund);
  });
}

// ------------------------------------------------------------------------------------------------ Methoden

export interface Methode {
  kennung: string;
  kundenwort: string;
  datenbedarf: string;
  mindest_perioden_startwert: number;
  variablen_anzahl: number;
}
export const METHODEN: Methode[] = (katalog as { methoden: Methode[] }).methoden;
export const methodeWort = (kennung: string): string => METHODEN.find((m) => m.kennung === kennung)?.kundenwort ?? kennung;

/**
 * Welche Methoden gebaut sind: das Verhältnis (IP-7) und seit IP-10 die Modelle und die Gradtage. Antwortet die Route auf
 * eine Methode mit `methode_noch_nicht_gebaut`, bleibt sie ausgegraut („kommt“) — auch wenn diese Liste sie kennt.
 */
export const GEBAUTE_METHODEN: readonly string[] = ['verhaeltnis', 'regression_eine_variable', 'regression_zwei_variablen', 'gradtage'];

/** Wählbar oder ausgegraut mit Grund (G1): erst „kommt“, dann der Mindestumfang der Referenzperiode. */
export function methodenWahl(monate: number | null, nichtGebaut: ReadonlySet<string>): { methode: Methode; grund: string | null }[] {
  return METHODEN.map((methode) => {
    if (!GEBAUTE_METHODEN.includes(methode.kennung) || nichtGebaut.has(methode.kennung)) return { methode, grund: KOMMT };
    if (monate !== null && monate < methode.mindest_perioden_startwert) {
      return { methode, grund: `Modell nicht möglich: ${monate} von ${methode.mindest_perioden_startwert} Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.` };
    }
    return { methode, grund: null };
  });
}

// ------------------------------------------------------------------------------------------------ Einflussgrößen

/** Ein Kandidat des Variablen-Vorschlags (IP-11a) als Zeile: wählbar erst mit einer Methode für zwei Größen. */
export function kandidatZeile(k: VariablenVorschlagKandidat): { titel: string; hinweis: string | null; waehlbar: boolean } {
  const titel = `${k.bezugsgroesse.name} (${k.bezugsgroesse.kennzeichen}, ${k.bezugsgroesse.einheit})`;
  if (k.vorschlag === 'statischer_faktor') return { titel, hinweis: k.satz, waehlbar: false };
  const a = k.abhaengigkeit;
  const hinweis =
    k.satz ??
    (a?.ergebnis === 'unabhaengig' && a.r !== null
      ? `unabhängig von ${a.gegen} (r = ${a.r.toFixed(3).replace('.', ',').replace('-', '−')})`
      : a?.ergebnis === 'nicht_pruefbar'
        ? `Abhängigkeit nicht prüfbar (${a.paare} Monatspaare)`
        : null);
  return { titel, hinweis, waehlbar: a?.ergebnis !== 'variablen_abhaengig' };
}

// ------------------------------------------------------------------------------------------------ Zahlen und Zeilen

/** Dezimaltext → deutsch, Tausender mit Leerzeichen (wie die §5.8-Sätze): „0.2837“ → „0,2837“. */
export function dezimal(t: string): string {
  const [ganz, rest] = t.split('.');
  const minus = ganz.startsWith('-') ? '−' : '';
  const ziffern = ganz.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${minus}${ziffern}${rest ? `,${rest}` : ''}`;
}

/**
 * Ein Modell in Kundenwörtern (§5.8 „Fassung 2“): „Modell mit einer Einflussgröße — 10 523 kWh Grundlast + 0,2343 kWh je
 * kg, Streuung ± 0,8 %“ — die Grundlast ganz, die Steigungen mit vier Stellen, wie der Server sie liefert; beim Verhältnis
 * `null`. Die Einheit der zweiten Größe kennt die Fassung nicht — dort steht ihr Kennzeichen.
 */
export function modellText(
  f: Pick<BezugsbasisFassung, 'methode' | 'koeffizienten' | 'streuung_prozent' | 'variablen'>,
  einheit: string | null,
): string | null {
  const k = f.koeffizienten;
  if (!k || k.a === undefined || k.b === undefined) return null;
  const [zaehler, nenner] = (einheit ?? '').split('/');
  const grundlast = dezimal(String(Math.round(Number(k.a))));
  const teile = [`${grundlast}${zaehler ? ` ${zaehler}` : ''} Grundlast`, `${dezimal(k.b)}${zaehler ? ` ${zaehler}` : ''} je ${nenner || f.variablen[0]?.kennzeichen || 'Einheit'}`];
  if (k.c !== undefined) teile.push(`${dezimal(k.c)}${zaehler ? ` ${zaehler}` : ''} je ${f.variablen[1]?.kennzeichen ?? 'Einheit'}`);
  const streuung = f.streuung_prozent ? `, Streuung ± ${dezimal(f.streuung_prozent)} %` : '';
  return `${methodeWort(f.methode)} — ${teile.join(' + ')}${streuung}`;
}

/** G4 beim Bilden (IP-10): die nicht aufgenommene zweite Variable als Satz. */
export const abgelehntSatz = (a: Record<string, unknown>): string =>
  `${String(a.objekt)} nicht aufgenommen: hängt an ${UEMS_EINFLUSSGROESSE} 1${typeof a.r === 'string' || typeof a.r === 'number' ? ` (r = ${Number(a.r).toFixed(3).replace('.', ',').replace('-', '−')})` : ''}. Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.`;

/** „kWh/kg“ → „kWh je kg“ (§5.8). */
export const einheitJe = (einheit: string | null): string => (einheit ?? '').replace('/', ' je ');

export const pruefsummeKurz = (p: string | null): string => (p ? `${p.replace(/^sha256:/, '').slice(0, 8)}…` : '—');

/** B2: nur Quotient und Zusammenfassung tragen eine Bezugsbasis — ein Anteil nie, also auch kein Reiter. */
export const kannBezugsbasis = (k: Pick<Kennzahl, 'rechenform'>): boolean => k.rechenform === QUOTIENT || k.rechenform === ZUSAMMENFASSUNG;

/** Die laufende Basis (höchstens eine, B1). */
export const laufende = (basen: Bezugsbasis[]): Bezugsbasis | null => basen.find((b) => b.beendet_zum === null) ?? null;

/** Die Fassung, die die Zeile nennt: die jüngste freigegebene, sonst die jüngste überhaupt. */
export function zeilenFassung(b: Bezugsbasis): BezugsbasisFassungKurz | null {
  const nach = [...b.fassungen].sort((x, y) => y.fassung - x.fassung);
  return nach.find((f) => f.freigabe_status === 'freigegeben') ?? nach[0] ?? null;
}

/**
 * Die Basis-Zeile (§5.8): „Bezugsbasis BB-0001 · Oktober 2026 · Verhältnis 0,2837 kWh je kg · vorläufig (1 von 12
 * Monaten) · freigegeben von Ines Kaltenbach am 12.11.2026.“ — Entwurf und Antrag stehen als Zustand am Ende.
 */
export function basisZeile(
  b: Pick<Bezugsbasis, 'kennzeichen'>,
  f: Pick<BezugsbasisFassung, 'referenzperiode' | 'methode' | 'basiswert' | 'monate' | 'mindest_monate' | 'freigabe_status' | 'variablen'> &
    Partial<Pick<BezugsbasisFassung, 'freigabe' | 'entscheidung' | 'freigegeben_am' | 'fassung' | 'koeffizienten' | 'streuung_prozent'>>,
  einheit: string | null,
): string {
  const teile = [
    `${UEMS_BEZUGSBASIS} ${b.kennzeichen}${f.fassung && f.fassung > 1 ? ` · Fassung ${f.fassung}` : ''}`,
    referenzperiodeText(f.referenzperiode),
    modellText(f, einheit) ?? `${methodeWort(f.methode)} ${dezimal(f.basiswert)}${einheit ? ` ${einheitJe(einheit)}` : ''}`,
  ];
  const vorl = vorlaeufigText(f.monate, f.mindest_monate);
  if (vorl) teile.push(vorl);
  if (f.freigabe_status === 'freigegeben') {
    // Bei Vier-Augen gibt die zweite Person frei (`entscheidung`), sonst die, die freigab (`freigabe`).
    const wer = f.entscheidung?.name ?? f.freigabe?.name ?? null;
    const am = f.freigegeben_am ?? f.entscheidung?.am ?? f.freigabe?.am ?? null;
    teile.push(`freigegeben${wer ? ` von ${wer}` : ''}${am ? ` am ${tagIn(am)}` : ''}`);
  } else {
    teile.push(FREIGABE_WORT[f.freigabe_status]);
  }
  return `${teile.join(' · ')}.`;
}

/**
 * Das Kennzeichen im Register (B3, §5.8): „Energieleistungskennzahl — Bezugsbasis BB-0001.“ — nur bei freigegebener
 * Basis. Die EINE Stelle, an der das Register das weiß: das Feld `bezugsbasis` der Register-Zeile (IP-8). Den Tag der
 * Freigabe („seit 12.11.2026“) trägt das Feld nicht — die Zeile nennt darum die Basis statt eines Datums.
 */
export function energieleistung(k: Pick<Kennzahl, 'bezugsbasis'>): string | null {
  const b = k.bezugsbasis;
  if (!b || b.freigabe_status !== 'freigegeben') return null;
  return `${UEMS_ENERGIELEISTUNGSKENNZAHL} — ${UEMS_BEZUGSBASIS} ${b.kennzeichen}${b.vorlaeufig ? ' · vorläufig' : ''}.`;
}

/** Ein Zeitpunkt (ISO, mit Zone) als Tag „TT.MM.JJJJ“ in Europe/Berlin; ein reiner Tag bleibt, wie er ist. */
export function tagIn(t: string, zone = 'Europe/Berlin'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return datumText(t);
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return datumText(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d));
}

/** F1: Begründung 10–500 Zeichen (wie die Route, 422 `begruendung_fehlt`). */
export function begruendungFehler(t: string): string | null {
  const n = t.trim().length;
  if (n < 10) return 'Bitte begründen Sie mit mindestens 10 Zeichen.';
  if (n > 500) return 'Die Begründung hat höchstens 500 Zeichen.';
  return null;
}

/** Der Satz nach dem Antrag: sofort wirksam, oder wartend bei Vier-Augen. */
export function nachAntragSatz(f: Pick<BezugsbasisFassung, 'freigabe_status' | 'fassung' | 'gilt_ab'>): string {
  return f.freigabe_status === 'freigegeben'
    ? `Fassung ${f.fassung} ist freigegeben und gilt ab ${datumText(f.gilt_ab)}.`
    : `Fassung ${f.fassung} ist zur Freigabe beantragt und wartet auf eine zweite Person.`;
}
