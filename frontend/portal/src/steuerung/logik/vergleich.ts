/**
 * Zwei Fassungen Zeile für Zeile vergleichen, dazu, welche Proben sich geändert haben (Bericht 8.9). Rein.
 */
import type { LogikBericht } from '../../api';

export type Teil =
  | { art: 'gleich'; zeilen: string[]; alt: number; neu: number }
  | { art: 'weg'; zeile: string; alt: number }
  | { art: 'dazu'; zeile: string; neu: number }
  | { art: 'ausgelassen'; anzahl: number };

/** Höchstens so viele gleiche Zeilen stehen um eine Änderung; längere gleiche Strecken werden zusammengefasst. */
const RAND = 2;

/**
 * Der Vergleich als Folge von Teilen (kleinste Zahl geänderter Zeilen, über die längste gemeinsame Teilfolge); lange
 * gleiche Strecken werden zu „n Zeilen gleich“ zusammengefasst. Zeilennummern ab 1.
 */
export function vergleiche(altText: string, neuText: string): Teil[] {
  const a = altText.split('\n');
  const b = neuText.split('\n');
  // Gemeinsamer Anfang und gemeinsames Ende zuerst: das Raster bleibt klein, auch bei langen Texten.
  let vorne = 0;
  while (vorne < a.length && vorne < b.length && a[vorne] === b[vorne]) vorne++;
  let hinten = 0;
  while (hinten < a.length - vorne && hinten < b.length - vorne && a[a.length - 1 - hinten] === b[b.length - 1 - hinten]) hinten++;
  const am = a.slice(vorne, a.length - hinten);
  const bm = b.slice(vorne, b.length - hinten);
  const n = am.length;
  const m = bm.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = am[i] === bm[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  type Roh = { art: 'gleich' | 'weg' | 'dazu'; zeile: string; alt: number; neu: number };
  const roh: Roh[] = [];
  for (let k = 0; k < vorne; k++) roh.push({ art: 'gleich', zeile: a[k], alt: k + 1, neu: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      roh.push({ art: 'gleich', zeile: am[i], alt: vorne + i + 1, neu: vorne + j + 1 });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) {
      // Erst die alte Zeile, dann die neue.
      roh.push({ art: 'weg', zeile: am[i], alt: vorne + i + 1, neu: 0 });
      i++;
    } else {
      roh.push({ art: 'dazu', zeile: bm[j], alt: 0, neu: vorne + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < hinten; k++) {
    roh.push({ art: 'gleich', zeile: a[a.length - hinten + k], alt: a.length - hinten + k + 1, neu: b.length - hinten + k + 1 });
  }
  // Zusammenfassen: um jede Änderung RAND gleiche Zeilen, dazwischen „ausgelassen“.
  const naheAnAenderung = roh.map(() => false);
  roh.forEach((r, k) => {
    if (r.art === 'gleich') return;
    for (let d = -RAND; d <= RAND; d++) if (roh[k + d]) naheAnAenderung[k + d] = true;
  });
  const out: Teil[] = [];
  let ausgelassen = 0;
  for (let k = 0; k < roh.length; k++) {
    const r = roh[k];
    if (r.art === 'gleich' && !naheAnAenderung[k]) {
      ausgelassen++;
      continue;
    }
    if (ausgelassen) {
      out.push({ art: 'ausgelassen', anzahl: ausgelassen });
      ausgelassen = 0;
    }
    if (r.art === 'weg') out.push({ art: 'weg', zeile: r.zeile, alt: r.alt });
    else if (r.art === 'dazu') out.push({ art: 'dazu', zeile: r.zeile, neu: r.neu });
    else {
      const letzter = out[out.length - 1];
      if (letzter?.art === 'gleich' && letzter.alt + letzter.zeilen.length === r.alt) letzter.zeilen.push(r.zeile);
      else out.push({ art: 'gleich', zeilen: [r.zeile], alt: r.alt, neu: r.neu });
    }
  }
  if (ausgelassen) out.push({ art: 'ausgelassen', anzahl: ausgelassen });
  return out;
}

/** Wie viele Zeilen dazukamen und wegfielen. */
export function zaehle(teile: Teil[]): { dazu: number; weg: number } {
  return {
    dazu: teile.filter((t) => t.art === 'dazu').length,
    weg: teile.filter((t) => t.art === 'weg').length,
  };
}

/** Welche Proben dazukamen, wegfielen oder ihr Ergebnis änderten. */
export function probenVergleich(alt: LogikBericht | null, neu: LogikBericht | null): { name: string; was: 'neu' | 'weg' | 'besteht' | 'besteht nicht' }[] {
  const a = new Map((alt?.proben ?? []).map((p) => [p.name, p.besteht]));
  const b = new Map((neu?.proben ?? []).map((p) => [p.name, p.besteht]));
  const out: { name: string; was: 'neu' | 'weg' | 'besteht' | 'besteht nicht' }[] = [];
  for (const [name, besteht] of b) {
    if (!a.has(name)) out.push({ name, was: 'neu' });
    else if (a.get(name) !== besteht) out.push({ name, was: besteht ? 'besteht' : 'besteht nicht' });
  }
  for (const name of a.keys()) if (!b.has(name)) out.push({ name, was: 'weg' });
  return out;
}
