/**
 * Die Einfärbung der Ansicht „Text“ (Steuerlogik Stufe 4): eigener Code statt einer Editor-Bibliothek, denn die
 * verträgt sich nicht mit der Inhaltsrichtlinie des Portals (Bericht 9, Anmerkung zu Stufe 4). Sie färbt nach
 * Zeilen und Wörtern, sie versteht die Sprache nicht: Schlüssel der Sprache, Namen des Verfassers, Wörter und
 * Funktionen, Zahlen mit Einheit, Texte in Anführungszeichen, Kommentare.
 */
import { SPRACHWOERTER } from './woerter';

export type Art = 'einzug' | 'strich' | 'schluessel' | 'name' | 'wort' | 'funktion' | 'zahl' | 'text' | 'kommentar'
  | 'zeichen' | 'bezeichner' | 'leer';

export interface Stueck {
  t: string;
  art: Art;
}

const FUNKTIONEN = new Set(['if', 'min', 'max', 'known', 'unknown', 'time_window', 'in_schedule', 'holds', 'since',
  'running', 'last', 'changes', 'oldest_change', 'start']);
const WOERTER = new Set(['and', 'or', 'not', 'on', 'off', 'true', 'false', 'keep', 'clock', 'else', 'unknown']);
const ZAHL = /^[-+]?\d+(?:\.\d+)?(?:\s?(?:°C|K|kW|W|%|s|min|h|°|ct))?/;

/** Wo in einer Zeile der Kommentar beginnt (ein `#` am Anfang oder nach Leerraum, nicht in Anführungszeichen). */
function kommentarAb(zeile: string): number {
  let inText: string | null = null;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (inText) {
      if (c === '\\' && inText === '"') i++;
      else if (c === inText) inText = null;
    } else if (c === '"' || c === "'") {
      inText = c;
    } else if (c === '#' && (i === 0 || /\s/.test(zeile[i - 1]))) {
      return i;
    }
  }
  return -1;
}

function wert(teil: string, out: Stueck[]): void {
  let rest = teil;
  while (rest.length) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) {
      out.push({ t: m[0], art: 'leer' });
    } else if ((m = rest.match(/^"(?:[^"\\]|\\.)*"?|^'(?:[^']|'')*'?/))) {
      out.push({ t: m[0], art: 'text' });
    } else if ((m = rest.match(/^([A-Za-z_][\w-]*)(:)(?=\s|$)/))) {
      // Ein Schlüssel mitten in der Zeile: `{entity: …, name: …}`.
      out.push({ t: m[1], art: SPRACHWOERTER.has(m[1]) ? 'schluessel' : 'name' }, { t: m[2], art: 'zeichen' });
      rest = rest.slice(m[0].length);
      continue;
    } else if ((m = rest.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z_]+)?/))) {
      // Eine Kennung der Anlage (Gerät, Fühler) ist ein Wort, keine Rechnung.
      out.push({ t: m[0], art: 'bezeichner' });
    } else if ((m = rest.match(ZAHL)) && m[0].length) {
      out.push({ t: m[0], art: 'zahl' });
    } else if ((m = rest.match(/^[A-Za-z_][\w.]*/))) {
      const w = m[0];
      // `unknown(x)` ist die Funktion, `unknown` allein das Wort (ein Zweig von if() ohne Wert).
      const art: Art = FUNKTIONEN.has(w) && rest.slice(w.length).startsWith('(') ? 'funktion' : WOERTER.has(w) ? 'wort' : 'bezeichner';
      out.push({ t: w, art });
    } else {
      m = rest.match(/^./u)!;
      out.push({ t: m[0], art: /[[\]{}(),:<>=!+\-*/|>]/.test(m[0]) ? 'zeichen' : 'bezeichner' });
    }
    rest = rest.slice(m[0].length);
  }
}

/** Die Stücke einer Zeile. */
export function faerbeZeile(zeile: string): Stueck[] {
  const out: Stueck[] = [];
  const k = kommentarAb(zeile);
  const code = k < 0 ? zeile : zeile.slice(0, k);
  const kommentar = k < 0 ? '' : zeile.slice(k);
  const anfang = code.match(/^(\s*)(-\s+)?/)!;
  if (anfang[1]) out.push({ t: anfang[1], art: 'einzug' });
  if (anfang[2]) out.push({ t: anfang[2], art: 'strich' });
  let rest = code.slice(anfang[0].length);
  // Ein Schlüssel am Anfang: ein Wort der Sprache, ein Name des Verfassers (benannte Bedingung) oder in Anführungszeichen.
  const schluessel = rest.match(/^("(?:[^"\\]|\\.)*"|[^:#{}[\]"'][^:#]*?)(:)(?=\s|$)/);
  if (schluessel) {
    const s = schluessel[1];
    out.push({ t: s, art: SPRACHWOERTER.has(s) ? 'schluessel' : 'name' }, { t: ':', art: 'zeichen' });
    rest = rest.slice(schluessel[0].length);
  }
  wert(rest, out);
  if (kommentar) out.push({ t: kommentar, art: 'kommentar' });
  return out;
}

/** Die Stücke jeder Zeile eines Textes. */
export function faerbe(text: string): Stueck[][] {
  return text.split('\n').map(faerbeZeile);
}
