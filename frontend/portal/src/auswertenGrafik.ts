import type { BezugsbasisUrteil } from './api';

/**
 * Die Geometrie der Auswerten-Grafiken (Konzept Auswerten a1 §6.12) - REIN: Zahlen rein, Pfade raus. Die Grafiken
 * tragen nur Marken; jede Beschriftung steht als HTML daneben (am Handy lesbar, nie aus dem Rahmen). Gerechnet wird hier
 * nur Lage auf der Zeichenfläche - Abweichung, Urteil und Werte kommen fertig vom Server.
 */

/** Wie eine Säule der Abweichung gezeichnet wird: in der Farbe ihres Urteils, umrissen ohne Urteil, gestrichelt leer. */
export type SaeulenArt = 'schlechter' | 'besser' | 'im_rahmen' | 'ohne_urteil' | 'leer';

export interface MiniAbweichung {
  breite: number;
  hoehe: number;
  /** Die Nulllinie. */
  nullY: number;
  /** Das graue Band „im Rahmen“ (± Band in %). */
  band: { y: number; hoehe: number };
  saeulen: { periode: string; art: SaeulenArt; pfad: string }[];
}

const zahlOderNull = (t: string | null | undefined): number | null => {
  if (t === null || t === undefined || t.trim() === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * Eine Säule von der Grundlinie `y0` bis zum Datenende `y1`: das Datenende gerundet, die Grundlinie eckig; ein Wert
 * kaum über null bleibt als flacher Strich sichtbar (nie eine unsichtbare Säule, die wie „fehlt“ aussähe).
 */
export function saeulenPfad(x: number, y0: number, y1: number, w: number, radius: number): string {
  if (Math.abs(y1 - y0) < 1.5) return `M${r1(x)},${r1(y0 - 1)}h${r1(w)}v2h${r1(-w)}Z`;
  const r = Math.min(radius, Math.abs(y1 - y0), w / 2);
  if (y1 < y0) {
    return `M${r1(x)},${r1(y0)}V${r1(y1 + r)}Q${r1(x)},${r1(y1)} ${r1(x + r)},${r1(y1)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y1)} ${r1(x + w)},${r1(y1 + r)}V${r1(y0)}Z`;
  }
  return `M${r1(x)},${r1(y0)}V${r1(y1 - r)}Q${r1(x)},${r1(y1)} ${r1(x + r)},${r1(y1)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y1)} ${r1(x + w)},${r1(y1 - r)}V${r1(y0)}Z`;
}

/**
 * Die kleine Abweichungsgrafik der Karte: je Monat eine Säule um die Nulllinie, oben mehr als erwartet, unten weniger;
 * `grenze` (± 6 %) hält die Höhe, damit ein Ausreißer die anderen Monate nicht flachdrückt. Ein Monat ohne Abweichung
 * bleibt eine leere, gestrichelte Säule (fehlend ist keine Null).
 */
export function miniAbweichung(
  monate: readonly { periode: string; delta_prozent: string | null; urteil: BezugsbasisUrteil | null }[],
  bandProzent: string | null,
  { breite = 132, hoehe = 34, grenze = 6 }: { breite?: number; hoehe?: number; grenze?: number } = {},
): MiniAbweichung {
  const halb = hoehe / 2;
  const y = (v: number) => halb - (Math.max(-grenze, Math.min(grenze, v)) / grenze) * (halb - 2);
  const band = Math.min(grenze, Math.abs(zahlOderNull(bandProzent) ?? 2));
  const slot = monate.length > 0 ? breite / monate.length : breite;
  const w = Math.max(3, slot * 0.6);
  const saeulen = monate.map((m, i) => {
    const x = i * slot + (slot - w) / 2;
    const d = zahlOderNull(m.delta_prozent);
    if (d === null) {
      return { periode: m.periode, art: 'leer' as const, pfad: `M${r1(x)},${r1(y(1))}h${r1(w)}v${r1(y(-1) - y(1))}h${r1(-w)}Z` };
    }
    const art: SaeulenArt = m.urteil === 'schlechter' || m.urteil === 'besser' || m.urteil === 'im_rahmen' ? m.urteil : 'ohne_urteil';
    return { periode: m.periode, art, pfad: saeulenPfad(x, y(0), y(d), w, 1.5) };
  });
  return { breite, hoehe, nullY: y(0), band: { y: y(band), hoehe: y(-band) - y(band) }, saeulen };
}

export interface MiniLinie {
  breite: number;
  hoehe: number;
  /** Je zusammenhängender Strecke die Punkte einer Polylinie - ein Monat ohne Wert unterbricht die Linie. */
  strecken: string[];
  /** Der jüngste Punkt mit Wert (bekommt den Punkt am Ende). */
  letzter: { x: number; y: number } | null;
}

/** Der kleine Verlauf einer Kennzahl ohne Bezugsbasis: die Werte als Linie, gestreckt auf ihre eigene Spanne. */
export function miniLinie(
  werte: readonly (string | null)[],
  { breite = 132, hoehe = 34, rand = 5 }: { breite?: number; hoehe?: number; rand?: number } = {},
): MiniLinie {
  const zahlen = werte.map(zahlOderNull);
  const da = zahlen.filter((z): z is number => z !== null);
  if (da.length === 0) return { breite, hoehe, strecken: [], letzter: null };
  const lo = Math.min(...da);
  const spanne = Math.max(...da) - lo || 1;
  const schritt = zahlen.length > 1 ? (breite - 2 * rand) / (zahlen.length - 1) : 0;
  const strecken: string[] = [];
  let laufend: string[] = [];
  let letzter: { x: number; y: number } | null = null;
  zahlen.forEach((z, i) => {
    if (z === null) {
      if (laufend.length > 0) strecken.push(laufend.join(' '));
      laufend = [];
      return;
    }
    const x = rand + i * schritt;
    const yy = da.length === 1 ? hoehe / 2 : hoehe - rand - ((z - lo) / spanne) * (hoehe - 2 * rand);
    laufend.push(`${r1(x)},${r1(yy)}`);
    letzter = { x: Math.round(x * 10) / 10, y: Math.round(yy * 10) / 10 };
  });
  if (laufend.length > 0) strecken.push(laufend.join(' '));
  return { breite, hoehe, strecken, letzter };
}

// ------------------------------------------------------------------ Die großen Grafiken der Kennzahl-Seite (§6.12)

/** Eine Beschriftung der Achse als HTML: `oben` in % der Zeichenfläche; `o`/`u` bündig am Rand, `m` mittig. */
export interface AchsenText {
  text: string;
  oben: number;
  art: 'o' | 'm' | 'u';
  /** Ein Richtungswort („mehr“, „weniger“) statt einer Zahl - etwas kleiner und kräftiger. */
  wort: boolean;
}

const prozentAchse = (t: number): string => (t === 0 ? '0' : `${t > 0 ? '+' : '−'}${Math.abs(t).toLocaleString('de-DE')}\u00a0%`);

/** Die Grenze der Abweichungsachse: ± 6 %, bei größeren Abweichungen der nächste runde Wert. */
const GRENZEN: readonly [number, number][] = [[6, 4], [10, 5], [15, 10], [20, 10], [30, 20], [50, 25], [100, 50]];

export interface AbweichungsGrafikBild {
  breite: number;
  /** Höhe der Zeichenfläche samt Rand oben und unten (viewBox). */
  hoehe: number;
  nullY: number;
  band: { y: number; hoehe: number };
  linien: { y: number; istNull: boolean }[];
  achse: AchsenText[];
  saeulen: { periode: string; art: SaeulenArt; pfad: string | null; leer: { x: number; y: number; w: number; h: number } | null; x: number; w: number }[];
  /** Der Rahmen um den gewählten Monat: oben und Höhe der Fläche. */
  wahl: { y: number; h: number };
}

/**
 * Die Abweichung je Monat um die Nulllinie (§6.12): oben mehr als erwartet, unten weniger, das graue Band „im Rahmen“;
 * Säulen höchstens 16 breit, Datenende gerundet; ein Monat ohne Abweichung bleibt eine leere, gestrichelte Säule.
 * `dicht` (Rechner) beschriftet auch die halben Schritte.
 */
export function abweichungsGrafik(
  monate: readonly { periode: string; delta: string | null; art: SaeulenArt }[],
  bandProzent: string | null,
  { breite = 290, flaeche = 134, dicht = false }: { breite?: number; flaeche?: number; dicht?: boolean } = {},
): AbweichungsGrafikBild {
  const rand = 4;
  const hoehe = flaeche + 2 * rand;
  const groesste = Math.max(0, ...monate.map((m) => Math.abs(zahlOderNull(m.delta) ?? 0)));
  const [grenze, schritt] = GRENZEN.find(([g]) => groesste * 1.1 <= g) ?? GRENZEN[GRENZEN.length - 1];
  const y = (v: number) => rand + flaeche / 2 - (Math.max(-grenze, Math.min(grenze, v)) / grenze) * (flaeche / 2);
  const band = Math.min(grenze, Math.abs(zahlOderNull(bandProzent) ?? 2));
  const ticks = dicht ? [schritt, schritt / 2, 0, -schritt / 2, -schritt] : [schritt, 0, -schritt];
  const slot = monate.length > 0 ? breite / monate.length : breite;
  const w = Math.min(16, slot * 0.62);
  const leerHalb = flaeche * 0.1;
  const achse: AchsenText[] = [
    { text: 'mehr', oben: 0, art: 'o', wort: true },
    ...ticks.map((t) => ({ text: prozentAchse(t), oben: (y(t) / hoehe) * 100, art: 'm' as const, wort: false })),
    { text: 'weniger', oben: 100, art: 'u', wort: true },
  ];
  return {
    breite,
    hoehe,
    nullY: y(0),
    band: { y: y(band), hoehe: y(-band) - y(band) },
    linien: ticks.map((t) => ({ y: y(t), istNull: t === 0 })),
    achse,
    saeulen: monate.map((m, i) => {
      const x = i * slot + (slot - w) / 2;
      const d = zahlOderNull(m.delta);
      if (d === null) return { periode: m.periode, art: 'leer' as const, pfad: null, leer: { x, y: y(0) - leerHalb, w, h: 2 * leerHalb }, x, w };
      return { periode: m.periode, art: m.art, pfad: saeulenPfad(x, y(0), y(d), w, 3), leer: null, x, w };
    }),
    wahl: { y: rand - 2, h: flaeche + 4 },
  };
}

/** Ein „schöner“ Schritt (1 · 2 · 2,5 · 5 · 10 × 10^k), mindestens `roh`. */
export function schoenerSchritt(roh: number): number {
  if (!(roh > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(roh));
  return ([1, 2, 2.5, 5, 10].map((f) => f * p).find((s) => s >= roh - 1e-12) ?? 10 * p);
}

const zahlAchse = (t: number): string => t.toLocaleString('de-DE', { maximumFractionDigits: 2 });

export interface SpaltenGrafikBild {
  breite: number;
  hoehe: number;
  nullY: number;
  linien: { y: number }[];
  achse: AchsenText[];
  saeulen: { pfad: string | null; leer: { x: number; y: number; w: number; h: number } | null; x: number; w: number }[];
  punkte: ({ x: number; y: number } | null)[];
  wahl: { y: number; h: number };
}

/**
 * Monatssäulen ab null mit dem Vorjahr als Punkt (§6.12, „Verlauf mit Vorjahr“) - ein roher Vergleich ohne Urteilsfarbe.
 * Zwei runde Werte an der Achse; ein Monat ohne Wert bleibt leer und gestrichelt.
 */
export function spaltenGrafik(
  werte: readonly (string | null)[],
  vorjahr: readonly (string | null)[],
  { breite = 294, flaeche = 130 }: { breite?: number; flaeche?: number } = {},
): SpaltenGrafikBild {
  const oben = 6;
  const unten = 2;
  const hoehe = flaeche + oben + unten;
  const zahlen = werte.map(zahlOderNull);
  const vj = vorjahr.map(zahlOderNull);
  const groesste = Math.max(0, ...zahlen.map((z) => z ?? 0), ...vj.map((z) => z ?? 0));
  const schritt = schoenerSchritt(groesste / 2.5);
  const top = Math.max(schritt, Math.ceil((groesste * 1.08) / (schritt / 2)) * (schritt / 2));
  const y = (v: number) => oben + flaeche - (Math.max(0, v) / top) * flaeche;
  const ticks: number[] = [];
  for (let t = schritt; t <= top + 1e-9; t += schritt) ticks.push(t);
  const slot = zahlen.length > 0 ? breite / zahlen.length : breite;
  const w = Math.min(18, slot * 0.62);
  return {
    breite,
    hoehe,
    nullY: y(0),
    linien: ticks.map((t) => ({ y: y(t) })),
    achse: ticks.map((t) => ({ text: zahlAchse(t), oben: (y(t) / hoehe) * 100, art: 'm' as const, wort: false })),
    saeulen: zahlen.map((z, i) => {
      const x = i * slot + (slot - w) / 2;
      if (z === null) return { pfad: null, leer: { x, y: y(top * 0.28), w, h: y(0) - y(top * 0.28) }, x, w };
      return { pfad: saeulenPfad(x, y(0), y(z), w, 3), leer: null, x, w };
    }),
    punkte: vj.map((z, i) => (z === null ? null : { x: Math.round((i * slot + slot / 2) * 10) / 10, y: Math.round(y(z) * 10) / 10 })),
    wahl: { y: oben - 2, h: flaeche + 4 },
  };
}

export interface ZusammenBild {
  breite: number;
  hoehe: number;
  nullY: number;
  linien: { y: number; istNull: boolean }[];
  achse: AchsenText[];
  /** Je zusammenhängender Strecke Linie und Fläche zur Nulllinie - ein Monat ohne Urteil unterbricht sie. */
  strecken: { linie: string; flaeche: string }[];
  ende: { x: number; y: number; links: number; oben: number } | null;
}

/**
 * „Zusammengezählt“ (§6.12, nur am Rechner): die Abweichungen der Monate mit Urteil als Linie, die Nulllinie heißt „wie
 * erwartet“; der Endwert steht als HTML-Notiz am letzten Punkt. Die Summen kommen vom Server (`zusammen`).
 */
export function zusammenGrafik(
  werte: readonly (string | null)[],
  { breite = 386, flaeche = 122 }: { breite?: number; flaeche?: number } = {},
): ZusammenBild {
  const oben = 22;
  const unten = 4;
  const hoehe = flaeche + oben + unten;
  const zahlen = werte.map(zahlOderNull);
  const da = zahlen.filter((z): z is number => z !== null);
  const lo = Math.min(0, ...da);
  const hi = Math.max(0, ...da);
  const schritt = schoenerSchritt(Math.max(hi - lo, 1) / 2.5);
  const unterkante = Math.floor(lo / schritt) * schritt;
  const oberkante = Math.max(unterkante + schritt, Math.ceil((hi * 1.12) / schritt) * schritt);
  const y = (v: number) => oben + flaeche - ((v - unterkante) / (oberkante - unterkante)) * flaeche;
  const x = (i: number) => ((i + 0.5) * breite) / Math.max(1, zahlen.length);
  const ticks: number[] = [];
  for (let t = unterkante; t <= oberkante + 1e-9; t += schritt) ticks.push(Math.round(t * 1e6) / 1e6);
  const strecken: { linie: string; flaeche: string }[] = [];
  let laufend: { x: number; y: number }[] = [];
  const schliessen = () => {
    if (laufend.length > 0) {
      const linie = laufend.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ');
      const flaecheP = `M${r1(laufend[0].x)},${r1(y(0))} L${laufend.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' L')} L${r1(laufend[laufend.length - 1].x)},${r1(y(0))} Z`;
      strecken.push({ linie, flaeche: flaecheP });
    }
    laufend = [];
  };
  let ende: ZusammenBild['ende'] = null;
  zahlen.forEach((z, i) => {
    if (z === null) return schliessen();
    laufend.push({ x: x(i), y: y(z) });
    ende = { x: Math.round(x(i) * 10) / 10, y: Math.round(y(z) * 10) / 10, links: (x(i) / breite) * 100, oben: (y(z) / hoehe) * 100 };
  });
  schliessen();
  return {
    breite,
    hoehe,
    nullY: y(0),
    linien: ticks.map((t) => ({ y: y(t), istNull: t === 0 })),
    achse: ticks.map((t) => ({ text: zahlAchse(t), oben: (y(t) / hoehe) * 100, art: 'm' as const, wort: false })),
    strecken,
    ende,
  };
}

export interface ZielSkalaBild {
  breite: number;
  hoehe: number;
  /** Die Spur von „mehr“ (links) bis „weniger als erwartet“ (rechts). */
  spur: { x: number; w: number };
  /** Der Weg von der Bezugsbasis bis zum Ziel. */
  weg: { x: number; w: number };
  mitte: number;
  ziel: number;
  jetzt: number | null;
  /** Lage der Beschriftungen in % der Breite; `anker` wie sie am Punkt hängen. */
  texte: { mitte: { links: number; anker: 's' | 'm' | 'e' }; ziel: { links: number; anker: 's' | 'm' | 'e' }; jetzt: { links: number; anker: 's' | 'e' } | null };
}

/**
 * Das Energieziel auf einer Skala (§6.12, Bullet Graph): links „mehr als erwartet“, rechts „weniger“, die Bezugsbasis in
 * der Mitte, das Ziel als Strich, der Stand als Punkt. Die Skala reicht mindestens ± 6 % und wächst mit den Werten.
 */
export function zielSkala(jetzt: string | null, ziel: string, { breite = 320 }: { breite?: number } = {}): ZielSkalaBild {
  const rand = 10;
  const pw = breite - 2 * rand;
  const j = zahlOderNull(jetzt);
  const z = zahlOderNull(ziel) ?? 0;
  const lo = Math.max(6, Math.ceil(Math.max(Math.abs(z), Math.abs(j ?? 0)) + 1));
  const x = (v: number) => rand + ((lo - Math.max(-lo, Math.min(lo, v))) / (2 * lo)) * pw;
  const p = (xx: number) => (xx / breite) * 100;
  const anker = (xx: number): 's' | 'm' | 'e' => (p(xx) < 14 ? 's' : p(xx) > 86 ? 'e' : 'm');
  const x0 = x(0);
  const xz = x(z);
  const xj = j === null ? null : x(j);
  return {
    breite,
    hoehe: 24,
    spur: { x: rand, w: pw },
    weg: { x: Math.min(x0, xz), w: Math.abs(xz - x0) },
    mitte: x0,
    ziel: xz,
    jetzt: xj,
    texte: {
      mitte: { links: p(x0), anker: anker(x0) },
      ziel: { links: p(xz), anker: anker(xz) },
      jetzt: xj === null ? null : p(xj) < 50 ? { links: p(xj - 4), anker: 's' } : { links: p(xj + 4), anker: 'e' },
    },
  };
}
