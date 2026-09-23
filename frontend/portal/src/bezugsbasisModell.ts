import type { BezugsbasisFassung, VariablenVorschlag } from './api';
import { dezimal, einheitJe, methodeWort, monatText } from './bezugsbasisAnlegen';
import { UEMS_EINFLUSSGROESSE, UEMS_GRUNDLAST } from './glossar';

/**
 * Die Modell-Ansicht einer Fassung in Kundenwörtern (UEMS AP-17 IP-14, §5.2, §5.8, `bezugsbasis.md` §4/§13): Kopfsatz,
 * Güte, Streuung, Spannweite je Einflussgröße, die abgelehnte zweite Variable, Kennzeichen und die Monatspaare der
 * Grundlage. **Kein Rechnen im Portal:** jede Zahl im Satz kommt als Dezimaltext aus der Fassung (M4, eingefroren) und
 * wird hier nur geschrieben — gerundet wird kaufmännisch auf dem Text (M5), nie über `Math.round`. Nur die Geometrie der
 * Grafik (Punkte, Gerade a + b·x) arbeitet mit Zahlen; sie zeigt, was die Fassung sagt, und rechnet kein Modell nach.
 */

// ------------------------------------------------------------------------------------------------ Wörter

export const TITEL_MODELL = 'Modell der Fassung';
export const TITEL_VERHAELTNIS = 'Basiswert der Fassung';
export const GUETE = 'Güte';
export const STREUUNG = 'Streuung';
export const SPANNWEITE = 'Spannweite';
export const DATENLAGE = 'Datenlage';
export const KENNZEICHEN = 'Kennzeichen';
export const MONATE = 'Monate der Referenzperiode';
export const LEGENDE_PUNKT = 'ein Monat der Referenzperiode';
export const LEGENDE_GERADE = 'die Gerade der Fassung (erwartet)';
export const LEGENDE_BAND = 'Spannweite der Referenzperiode';
export const WITTERUNGSUNABHAENGIG = 'witterungsunabhängiger Anteil';

// ------------------------------------------------------------------------------------------------ Zahlen als Text

/** Kaufmännisch auf ganze Einheiten (M5: ,5 vom Nullpunkt weg) — auf dem Dezimaltext, ohne `number`. */
export function ganzText(t: string): string {
  const minus = t.trim().startsWith('-');
  const [ganz, rest = ''] = t.trim().replace('-', '').split('.');
  const auf = rest.length > 0 && rest[0] >= '5';
  const wert = BigInt(ganz || '0') + (auf ? 1n : 0n);
  return dezimal(`${minus && wert !== 0n ? '-' : ''}${wert.toString()}`);
}

/** R² (drei Stellen, M5) als Anteil in Prozent: „0.991“ → „99,1“ — nur die Stelle verschoben, nichts gerechnet. */
export function prozentText(t: string): string {
  const [ganz, rest = ''] = t.trim().split('.');
  const hundert = BigInt(ganz || '0') * 100n + BigInt((rest + '00').slice(0, 2));
  const nach = rest.slice(2).replace(/0+$/, '');
  return `${hundert.toString()}${nach ? `,${nach}` : ''}`;
}

/** „0.8“ → „0,8“, „2“ → „2,0“ — Prozent mit einer festen Stelle (M5). */
export const einStelle = (t: string): string => dezimal(t.includes('.') ? t : `${t}.0`);

/** Nur für Achsen und die Mitte der zweiten Spannweite: eine Zahl der Grafik als Text (höchstens eine Stelle). */
export const achsenText = (n: number): string => dezimal(String(Number(n.toFixed(1))));

// ------------------------------------------------------------------------------------------------ Einheiten und Größen

/** „kWh/kg“ → Energie „kWh“ und Einheit der Einflussgröße 1 „kg“. */
export function einheiten(einheit: string | null): { energie: string; bezug: string } {
  const [energie = '', bezug = ''] = (einheit ?? '').split('/');
  return { energie: energie.trim(), bezug: bezug.trim() };
}

/** Name und Einheit einer Bezugsgröße je Kennzeichen — aus dem Variablen-Vorschlag, sonst nur das Kennzeichen. */
export type Groessen = Record<string, { name: string; einheit: string }>;

export function groessenAusVorschlag(v: VariablenVorschlag | null | undefined): Groessen {
  const out: Groessen = {};
  for (const k of v?.kandidaten ?? []) out[k.bezugsgroesse.kennzeichen] = { name: k.bezugsgroesse.name, einheit: k.bezugsgroesse.einheit };
  if (v?.variable_1) out[v.variable_1.kennzeichen] = { name: v.variable_1.name, einheit: v.variable_1.einheit };
  return out;
}

export const istModell = (f: Pick<BezugsbasisFassung, 'koeffizienten'>): boolean =>
  !!f.koeffizienten && f.koeffizienten.a !== undefined && f.koeffizienten.b !== undefined;

// ------------------------------------------------------------------------------------------------ Spannweite

export interface Spannweite {
  position: number;
  kennzeichen: string;
  name: string;
  einheit: string;
  von: string;
  bis: string;
  toleriertVon: string | null;
  toleriertBis: string | null;
}

type GrundlageVariable = { position?: number; objekt?: string; spannweite?: { von?: unknown; bis?: unknown; toleriert_von?: unknown; toleriert_bis?: unknown } };
type GrundlagePeriodeVariable = { position?: number; objekt?: string; wert?: unknown; einheit?: string };

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Die Einheit der zweiten Einflussgröße steht nur an den Monaten der Grundlage (je Monat `variablen[]`). */
function einheitZwei(f: Pick<BezugsbasisFassung, 'grundlage'>, kennzeichen: string): string {
  for (const p of f.grundlage.perioden ?? []) {
    const vs = (p as { variablen?: GrundlagePeriodeVariable[] }).variablen ?? [];
    const v = vs.find((x) => x.objekt === kennzeichen);
    if (v?.einheit) return v.einheit;
  }
  return '';
}

/** Spannweite je Einflussgröße: min–max aus der Fassung, das Toleranzband (G3, M2) aus der eingefrorenen Grundlage. */
export function spannweiten(
  f: Pick<BezugsbasisFassung, 'variablen' | 'grundlage'>,
  einheit: string | null,
  groessen: Groessen = {},
): Spannweite[] {
  const ausGrundlage = (f.grundlage.variablen as GrundlageVariable[] | undefined) ?? [];
  return f.variablen
    .filter((v) => v.spannweite_von !== null && v.spannweite_bis !== null)
    .map((v) => {
      const g = ausGrundlage.find((x) => x.position === v.position)?.spannweite;
      const bekannt = groessen[v.kennzeichen];
      return {
        position: v.position,
        kennzeichen: v.kennzeichen,
        name: bekannt?.name ?? v.kennzeichen,
        einheit: v.position === 1 ? einheiten(einheit).bezug || bekannt?.einheit || '' : einheitZwei(f, v.kennzeichen) || bekannt?.einheit || '',
        von: v.spannweite_von as string,
        bis: v.spannweite_bis as string,
        toleriertVon: text(g?.toleriert_von),
        toleriertBis: text(g?.toleriert_bis),
      };
    });
}

const mitEinheit = (zahl: string, einheit: string) => `${zahl}${einheit ? ` ${einheit}` : ''}`;
const bereich = (s: Pick<Spannweite, 'von' | 'bis' | 'einheit'>) => mitEinheit(`${dezimal(s.von)}–${dezimal(s.bis)}`, s.einheit);

/** „Produktionsmenge (BZ-1): 254 000–341 000 kg · das Modell gilt von 228 600 bis 375 100 kg; außerhalb ist es nicht anwendbar.“ */
export function spannweiteSatz(s: Spannweite): string {
  const wer = s.name === s.kennzeichen ? s.kennzeichen : `${s.name} (${s.kennzeichen})`;
  const band =
    s.toleriertVon !== null && s.toleriertBis !== null
      ? ` · das Modell gilt von ${dezimal(s.toleriertVon)} bis ${mitEinheit(dezimal(s.toleriertBis), s.einheit)}; außerhalb ist es nicht anwendbar.`
      : '';
  return `${UEMS_EINFLUSSGROESSE} ${s.position}, ${wer}: ${bereich(s)}${band}`;
}

// ------------------------------------------------------------------------------------------------ Sätze

/**
 * Der Kopfsatz der Modell-Ansicht (§5.2): „Grundlast 10 523 kWh · je kg 0,2343 kWh · Streuung ± 0,8 % · gilt für
 * 254 000–341 000 kg“. Die Grundlast ganz (M5 auf dem Text), die Steigungen mit ihren vier Stellen, wie die Fassung sie
 * trägt. Bei Gradtagen ist die Konstante der witterungsunabhängige Anteil; beim Verhältnis `null`.
 */
export function kopfSatz(
  f: Pick<BezugsbasisFassung, 'methode' | 'koeffizienten' | 'streuung_prozent' | 'variablen' | 'grundlage'>,
  einheit: string | null,
  groessen: Groessen = {},
): string | null {
  if (!istModell(f)) return null;
  const k = f.koeffizienten as Record<string, string>;
  const { energie, bezug } = einheiten(einheit);
  const sw = spannweiten(f, einheit, groessen);
  const teile = [
    `${UEMS_GRUNDLAST} ${mitEinheit(ganzText(k.a), energie)}${f.methode === 'gradtage' ? ` (${WITTERUNGSUNABHAENGIG})` : ''}`,
    `je ${bezug || sw[0]?.einheit || f.variablen[0]?.kennzeichen || 'Einheit'} ${mitEinheit(dezimal(k.b), energie)}`,
  ];
  if (k.c !== undefined) {
    const zwei = sw.find((s) => s.position === 2);
    teile.push(`je ${zwei?.einheit || zwei?.kennzeichen || f.variablen[1]?.kennzeichen || 'Einheit'} ${mitEinheit(dezimal(k.c), energie)}`);
  }
  if (f.streuung_prozent) teile.push(`${STREUUNG} ± ${einStelle(f.streuung_prozent)} %`);
  if (sw.length > 0) teile.push(`gilt für ${sw.map(bereich).join(' und ')}`);
  return teile.join(' · ');
}

/** Die Güte in Kundenwort: „Güte 0,991 — das Modell erklärt 99,1 % der Schwankung der Monatswerte.“ */
export const gueteSatz = (r2: string): string =>
  `${GUETE} ${dezimal(r2)} — das Modell erklärt ${prozentText(r2)} % der Schwankung der Monatswerte.`;

/** Die Streuung (M2) in Kundenwort — sie ist auch die Breite des Bands im Vergleich, wenn sie die Toleranz übersteigt. */
export const streuungSatz = (streuung: string): string =>
  `${STREUUNG} ± ${einStelle(streuung)} % — so weit liegen die Monate der Referenzperiode typisch neben der Geraden.`;

/**
 * G4 beim Bilden (§5.8 „Abhängige Variablen“): „Betriebsstunden nicht aufgenommen: hängt an Produktionsmenge (r = 0,997).
 * Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.“ — mit Namen, wenn sie bekannt sind, sonst mit Kennzeichen.
 */
export function abgelehntSatz(a: Record<string, unknown>, variable1: string | null, groessen: Groessen = {}): string {
  const objekt = String(a.objekt ?? '');
  const wer = groessen[objekt]?.name ?? objekt;
  const gegen = variable1 ? (groessen[variable1]?.name ?? variable1) : `${UEMS_EINFLUSSGROESSE} 1`;
  const r = a.r === null || a.r === undefined ? '' : ` (r = ${dezimal(String(a.r))})`;
  return `${wer} nicht aufgenommen: hängt an ${gegen}${r}. Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.`;
}

/** Beim Verhältnis (§4): „Verhältnis 0,2837 kWh je kg aus 1 Monat der Referenzperiode.“ */
export function basiswertSatz(f: Pick<BezugsbasisFassung, 'methode' | 'basiswert' | 'monate'>, einheit: string | null): string {
  const je = einheitJe(einheit);
  return `${methodeWort(f.methode)} ${dezimal(f.basiswert)}${je ? ` ${je}` : ''} aus ${f.monate} ${f.monate === 1 ? 'Monat' : 'Monaten'} der Referenzperiode.`;
}

/** Kennzeichen der Fassung (M3 „ohne Grundlast“) und ihre Vorbehalte (P2/P3), ohne Doppel. */
export const kennzeichenListe = (f: Pick<BezugsbasisFassung, 'kennzeichen' | 'vorbehalte'>): string[] => [
  ...new Set([...(f.kennzeichen ?? []), ...(f.vorbehalte ?? [])]),
];

// ------------------------------------------------------------------------------------------------ Monate und Grafik

export interface Monatspaar {
  periode: string;
  energie: string;
  bezug: string;
  zwei: string | null;
}

/** Die Monatspaare der Grundlage (F3) — Energie und Einflussgröße 1 (und 2) je Monat mit Zahl; Monate mit Grund fehlen. */
export function monatspaare(f: Pick<BezugsbasisFassung, 'grundlage'>): Monatspaar[] {
  return (f.grundlage.perioden ?? [])
    .filter((p) => !p.grund && p.zaehler !== undefined && p.nenner !== undefined)
    .map((p) => {
      const zweite = ((p as { variablen?: GrundlagePeriodeVariable[] }).variablen ?? []).find((v) => v.position === 2);
      return { periode: p.periode, energie: String(p.zaehler), bezug: String(p.nenner), zwei: zweite ? text(zweite.wert) : null };
    });
}

/** Die Monatsliste: „Oktober 2026: 88 630 kWh bei 312 400 kg“; ein Monat ohne Zahl nennt seinen Grund. */
export function monatsZeilen(f: Pick<BezugsbasisFassung, 'grundlage'>, einheit: string | null, einheitZweite = ''): string[] {
  const { energie, bezug } = einheiten(einheit);
  return (f.grundlage.perioden ?? []).map((p) => {
    if (p.grund || p.zaehler === undefined || p.nenner === undefined) return `${monatText(p.periode)}: ohne Wert`;
    const paar = monatspaare({ grundlage: { perioden: [p] } })[0];
    const zwei = paar.zwei !== null ? ` und ${mitEinheit(dezimal(paar.zwei), einheitZweite)}` : '';
    return `${monatText(p.periode)}: ${mitEinheit(dezimal(paar.energie), energie)} bei ${mitEinheit(dezimal(paar.bezug), bezug)}${zwei}`;
  });
}

export interface Grafik {
  punkte: { periode: string; x: number; y: number }[];
  /** Die Gerade aus den eingefrorenen Koeffizienten, links und rechts an den Enden des gezeigten Bereichs. */
  gerade: { x1: number; y1: number; x2: number; y2: number };
  /** Die Spannweite von Einflussgröße 1 als Band. */
  band: { von: number; bis: number };
  x: { min: number; max: number };
  y: { min: number; max: number };
  /** Bei zwei Einflussgrößen: der Wert der zweiten, bei dem die Gerade gezeigt wird (Mitte ihrer Spannweite). */
  zweiteBei: number | null;
  /** Die Konstante als waagerechte Linie, wenn x = 0 im Bild liegt (Gradtage). */
  grundlast: number | null;
}

/**
 * Die Geometrie der Grafik — Punkte sind die Monatspaare (Energie über Einflussgröße 1), die Gerade ist a + b·x (+ c·x₂)
 * mit den Koeffizienten der Fassung. Der x-Bereich ist das Toleranzband der Spannweite (sonst die Spannweite), damit
 * man sieht, wo das Modell gilt. `null` ohne Modell oder ohne Monatspaar.
 */
export function grafik(f: Pick<BezugsbasisFassung, 'koeffizienten' | 'variablen' | 'grundlage'>): Grafik | null {
  if (!istModell(f)) return null;
  const paare = monatspaare(f);
  if (paare.length === 0) return null;
  const k = f.koeffizienten as Record<string, string>;
  const a = Number(k.a);
  const b = Number(k.b);
  const c = k.c !== undefined ? Number(k.c) : null;
  const sw = spannweiten(f, null);
  const eins = sw.find((s) => s.position === 1);
  const zwei = sw.find((s) => s.position === 2);
  const punkte = paare.map((p) => ({ periode: p.periode, x: Number(p.bezug), y: Number(p.energie) }));
  const xs = punkte.map((p) => p.x);
  const band = eins ? { von: Number(eins.von), bis: Number(eins.bis) } : { von: Math.min(...xs), bis: Math.max(...xs) };
  const xMin = Math.min(...xs, eins?.toleriertVon !== null && eins?.toleriertVon !== undefined ? Number(eins.toleriertVon) : band.von);
  const xMax = Math.max(...xs, eins?.toleriertBis !== null && eins?.toleriertBis !== undefined ? Number(eins.toleriertBis) : band.bis);
  const zweiteBei = c !== null && zwei ? (Number(zwei.von) + Number(zwei.bis)) / 2 : null;
  const y = (x: number) => a + b * x + (c !== null && zweiteBei !== null ? c * zweiteBei : 0);
  const gerade = { x1: xMin, y1: y(xMin), x2: xMax, y2: y(xMax) };
  const grundlast = xMin <= 0 ? y(0) : null;
  const ys = [...punkte.map((p) => p.y), gerade.y1, gerade.y2, ...(grundlast !== null ? [grundlast] : [])];
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const luft = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.1 || 1;
  return {
    punkte,
    gerade,
    band,
    x: { min: xMin, max: xMax === xMin ? xMin + 1 : xMax },
    y: { min: Math.max(0, yMin - luft), max: yMax + luft },
    zweiteBei,
    grundlast,
  };
}

/** Der Hinweis bei zwei Einflussgrößen: die Gerade ist ein Schnitt bei einem Wert der zweiten. */
export function zweiteHinweis(zweite: Spannweite, bei: number): string {
  return `Die Gerade zeigt das Modell bei ${zweite.name} = ${mitEinheit(achsenText(bei), zweite.einheit)} (Mitte ihrer Spannweite ${bereich(zweite)}); jeder Punkt ist ein Monat mit seinem eigenen Wert.`;
}

/** Die Beschriftung der Grafik für Screenreader — dieselben Zahlen wie der Kopfsatz, dazu die Zahl der Punkte. */
export const grafikBeschreibung = (kopf: string, punkte: number): string =>
  `Grafik: ${punkte} Monate der Referenzperiode als Punkte und die Gerade der Fassung. ${kopf}.`;

/** Die x-Achse beschriftet mit Einflussgröße 1, die y-Achse mit der Energie. */
export function achsen(
  f: Pick<BezugsbasisFassung, 'methode' | 'variablen'>,
  einheit: string | null,
  groessen: Groessen = {},
): { x: string; y: string } {
  const { energie, bezug } = einheiten(einheit);
  const v1 = f.variablen[0]?.kennzeichen;
  const name = f.methode === 'gradtage' ? 'Gradtage' : v1 ? (groessen[v1]?.name ?? v1) : `${UEMS_EINFLUSSGROESSE} 1`;
  return { x: `${name}${bezug ? ` in ${bezug}` : ''}`, y: `Energie${energie ? ` in ${energie}` : ''}` };
}
