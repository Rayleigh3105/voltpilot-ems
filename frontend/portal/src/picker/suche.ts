/**
 * Die EINE tolerante Suche des Portals.
 *
 * Sie stand seit der Modell-Suche (PR 461) in `komponentenAssistent.ts` und war
 * damit an EINE Fläche gebunden. Der VpPicker bringt dieselbe Suche in jede
 * Auswahlliste - und zwei Implementierungen derselben Toleranz laufen
 * irgendwann auseinander, dann findet dieselbe Eingabe auf zwei Flächen
 * Verschiedenes. Also wohnt sie hier, und `komponentenAssistent.ts` REICHT SIE
 * DURCH (`export { … } from './picker/suche'`) - jeder alte Aufrufer und jeder
 * alte Test bleiben unverändert gültig.
 *
 * Diese Datei rechnet und formuliert; sie rendert nichts und ruft nichts ab.
 */

/** Ein Stück Text mit der Auskunft, ob es zur Suche gehört (für `<mark>`). */
export interface TextTeil {
  text: string;
  treffer: boolean;
}

/**
 * ⚠ Die Schreibweise darf nicht entscheiden, ob jemand sein Gerät findet.
 * Ein Typenschild trennt mit Bindestrichen, ein Mensch tippt Leerzeichen, ein
 * Datenblatt schreibt zusammen - normalisiert wird deshalb auf BEIDEN Seiten:
 * klein, ohne Trennzeichen, ohne Umlaut-Eigenheiten.
 */
export function normalisiereSuche(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[\s\-_./]/g, '');
}

/** Die Suchbegriffe - jeder muss vorkommen (UND, nie ODER). */
export function suchBegriffe(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((t) => normalisiereSuche(t))
    .filter((t) => t !== '');
}

/**
 * Die Fundstellen eines Begriffs IM ORIGINALTEXT.
 *
 * ⚠ Gesucht wird auf der normalisierten Fassung, hervorgehoben im ORIGINAL -
 * die zwei haben verschiedene Längen (aus „SUN-30K" wird „sun30k"), deshalb
 * trägt jede Original-Position ihren Index in der normalisierten Fassung.
 */
export function hervorheben(text: string, begriffe: string[]): TextTeil[] {
  if (begriffe.length === 0 || text === '') return [{ text, treffer: false }];
  // Position je Zeichen der NORMALISIERTEN Fassung → Position im Original.
  const norm: string[] = [];
  const pos: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const n = normalisiereSuche(text[i]);
    for (let k = 0; k < n.length; k += 1) {
      norm.push(n[k]);
      pos.push(i);
    }
  }
  const flach = norm.join('');
  const markiert = new Array<boolean>(text.length).fill(false);
  for (const b of begriffe) {
    let from = 0;
    for (;;) {
      const at = flach.indexOf(b, from);
      if (at === -1) break;
      for (let k = at; k < at + b.length; k += 1) markiert[pos[k]] = true;
      from = at + b.length;
    }
  }
  // ⚠ Ein Trennzeichen INNERHALB einer Fundstelle wird mit markiert: es kommt
  // in der normalisierten Fassung gar nicht vor, bliebe also unmarkiert und
  // risse „SUN-30K" optisch in zwei Treffer auseinander.
  for (let i = 1; i < text.length - 1; i += 1) {
    if (markiert[i] || normalisiereSuche(text[i]) !== '') continue;
    let links = i - 1;
    while (links >= 0 && normalisiereSuche(text[links]) === '') links -= 1;
    let rechts = i + 1;
    while (rechts < text.length && normalisiereSuche(text[rechts]) === '') rechts += 1;
    if (links >= 0 && rechts < text.length && markiert[links] && markiert[rechts]) {
      markiert[i] = true;
    }
  }
  const out: TextTeil[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const letzte = out[out.length - 1];
    if (letzte && letzte.treffer === markiert[i]) letzte.text += text[i];
    else out.push({ text: text[i], treffer: markiert[i] });
  }
  return out;
}

/** Passt der Heuhaufen auf ALLE Begriffe? (Der Heuhaufen ist normalisiert.) */
export function passt(heuhaufen: string, begriffe: string[]): boolean {
  return begriffe.every((b) => heuhaufen.includes(b));
}
