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
