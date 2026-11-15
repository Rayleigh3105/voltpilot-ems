/**
 * Der Text einer Logik als EINE Quelle für Aufbau und Text (Steuerlogik Stufe 4, Bericht 6.6 und 12.3).
 *
 * Das Portal liest die Sprache nicht - Formeln, Einheiten und Prüfung rechnet nur der Logik-Dienst, mit denselben
 * Lesern wie die Box. Was hier geschieht, ist das FORMAT: den YAML-Text mit seinen Stellen lesen (Bibliothek `yaml`,
 * nur zum Lesen) und Änderungen aus dem Aufbau so hineinschreiben, dass NUR die betroffenen Zeilen sich ändern.
 * Kommentare, Ausrichtung und die Schreibweise des Verfassers bleiben, wo der Aufbau nichts anfasst.
 *
 * Die Schreibregeln der Textform (Vertrag `steuerlogik.md`, die on/off-Regel): Uhrzeiten stehen in
 * Anführungszeichen, Ja/Nein heißt `on`/`off` (außer `else: true`), ein Wort, das ein anderer YAML-Leser als Zahl
 * oder Ja/Nein läse, steht in Anführungszeichen.
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type Node, type Pair } from 'yaml';

/** Ein Pfad im Dokument: Schlüssel und Listenplätze (ab 0). */
export type Pfad = (string | number)[];

/** Ein Wort, das ohne Anführungszeichen geschrieben wird (`on`, `off`, `keep`, `boost` …). */
export class Wort {
  constructor(readonly wort: string) {}
}

/** Was der Aufbau schreibt: ein Wert der Textform. */
export type Wert = string | number | boolean | null | Wort | Wert[] | { [k: string]: Wert };

export type Gelesen =
  | { ok: true; doc: Document.Parsed; zeilen: LineCounter }
  | { ok: false; fehler: string; zeile: number | null };

/** Liest den Text; ein Text, den YAML nicht liest, kommt mit der Zeile der ersten Meldung zurück. */
export function lies(text: string): Gelesen {
  const zeilen = new LineCounter();
  const doc = parseDocument(text, { lineCounter: zeilen, keepSourceTokens: false, uniqueKeys: false });
  if (doc.errors.length) {
    const e = doc.errors[0];
    return { ok: false, fehler: e.message.split('\n')[0], zeile: e.linePos?.[0]?.line ?? null };
  }
  return { ok: true, doc, zeilen };
}

/** Die Zeile (ab 1) einer Stelle im Text. */
export function zeileVon(g: Extract<Gelesen, { ok: true }>, offset: number): number {
  return g.zeilen.linePos(offset).line;
}

/** Der Knoten an einem Pfad, `undefined`, wenn es ihn nicht gibt. */
export function knoten(doc: Document.Parsed, pfad: Pfad): Node | undefined {
  let n: unknown = doc.contents;
  for (const teil of pfad) {
    if (isMap(n)) {
      const p = n.items.find((x) => isScalar(x.key) && String(x.key.value) === String(teil));
      if (!p) return undefined;
      n = p.value;
    } else if (isSeq(n) && typeof teil === 'number') {
      n = n.items[teil];
    } else {
      return undefined;
    }
  }
  return (n ?? undefined) as Node | undefined;
}

/** Das Paar (Schlüssel und Wert) an einem Pfad, dessen letzter Teil ein Schlüssel ist. */
function paar(doc: Document.Parsed, pfad: Pfad): { pair: Pair; eltern: Node } | undefined {
  const eltern = pfad.length === 1 ? doc.contents : knoten(doc, pfad.slice(0, -1));
  if (!isMap(eltern)) return undefined;
  const pair = eltern.items.find((x) => isScalar(x.key) && String(x.key.value) === String(pfad[pfad.length - 1]));
  return pair ? { pair: pair as Pair, eltern: eltern as Node } : undefined;
}

// --- Schreiben: Skalare und Blöcke -------------------------------------------------------------------------------

const UHRZEIT = /^\d{1,2}:\d{2}(:\d{2})?$/;
const ZAHLARTIG = /^[-+]?(\.\d|\d)[\d_.,eE+-]*$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$|^0[xo]/;
const JA_NEIN = /^(y|n|yes|no|true|false|on|off|null|~)$/i;
const ANFANG = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Ein Skalar der Textform; {@code imFluss}: innerhalb von `{…}` oder `[…]`, wo Kommas und Klammern zählen. */
export function skalar(w: string | number | boolean | null | Wort, imFluss = false): string {
  if (w === null) return 'null';
  if (w instanceof Wort) return w.wort;
  if (typeof w === 'boolean') return w ? 'true' : 'false';
  if (typeof w === 'number') return Number.isFinite(w) ? String(w) : JSON.stringify(String(w));
  const s = w;
  const anfuehrung =
    s === '' ||
    s !== s.trim() ||
    /\n/.test(s) ||
    UHRZEIT.test(s) ||
    ZAHLARTIG.test(s) ||
    JA_NEIN.test(s) ||
    (ANFANG.test(s) && !/^-[^\s-]/.test(s)) ||
    /^- /.test(s) ||
    s.includes(': ') ||
    s.endsWith(':') ||
    s.includes(' #') ||
    (imFluss && /[,[\]{}]/.test(s));
  return anfuehrung ? JSON.stringify(s) : s;
}

function istSkalar(w: Wert): w is string | number | boolean | null | Wort {
  return w === null || w instanceof Wort || typeof w !== 'object';
}

/** Ein Wert in Fluss-Form (`{a: b}`, `[a, b]`), wenn er so einfach ist; sonst null. */
function fluss(w: Wert): string | null {
  if (istSkalar(w)) return skalar(w, true);
  if (Array.isArray(w)) {
    if (!w.every(istSkalar)) return null;
    return `[${w.map((x) => skalar(x as string, true)).join(', ')}]`;
  }
  const teile: string[] = [];
  for (const [k, v] of Object.entries(w)) {
    if (!istSkalar(v) && !(Array.isArray(v) && v.every(istSkalar))) return null;
    teile.push(`${skalar(k, true)}: ${fluss(v)}`);
  }
  return `{${teile.join(', ')}}`;
}

/** Höchstens so lang wird eine Fluss-Zeile, bevor der Block die Werte untereinander schreibt. */
const FLUSS_GRENZE = 110;

/**
 * Die Zeilen eines Paars `schluessel: wert` in Block-Form ab einer Einrückung: Skalare in derselben Zeile,
 * Objekte aus Skalaren als `{…}`, wenn die Zeile kurz bleibt (so wie die Beispiele `devices` und `inputs`
 * schreiben), sonst darunter eingerückt.
 */
export function paarZeilen(schluessel: string, wert: Wert, einzug: number): string[] {
  const vor = ' '.repeat(einzug) + skalar(schluessel) + ':';
  if (istSkalar(wert)) return [`${vor} ${skalar(wert)}`];
  const f = fluss(wert);
  const leer = Array.isArray(wert) ? wert.length === 0 : Object.keys(wert).length === 0;
  if (leer) return [`${vor} ${Array.isArray(wert) ? '[]' : '{}'}`];
  if (f !== null && !Array.isArray(wert) && vor.length + 1 + f.length <= FLUSS_GRENZE && Object.keys(wert).length <= 6) {
    return [`${vor} ${f}`];
  }
  if (f !== null && Array.isArray(wert) && vor.length + 1 + f.length <= FLUSS_GRENZE) return [`${vor} ${f}`];
  return [vor, ...blockZeilen(wert, einzug + 2)];
}

/** Die Zeilen eines Objekts oder einer Liste in Block-Form. */
export function blockZeilen(wert: Wert, einzug: number): string[] {
  if (istSkalar(wert)) return [' '.repeat(einzug) + skalar(wert)];
  if (Array.isArray(wert)) return wert.flatMap((e) => listenEintrag(e, einzug));
  return Object.entries(wert).flatMap(([k, v]) => paarZeilen(k, v, einzug));
}

/** Ein Listeneintrag: `- wert`, `- Name: Formel` (benannte Bedingung) oder ein Objekt unter `- `. */
function listenEintrag(e: Wert, einzug: number): string[] {
  const vor = ' '.repeat(einzug) + '- ';
  if (istSkalar(e)) return [vor + skalar(e)];
  if (Array.isArray(e)) return [vor.trimEnd(), ...blockZeilen(e, einzug + 2)];
  const zeilen = blockZeilen(e, einzug + 2);
  if (!zeilen.length) return [vor + '{}'];
  return [vor + zeilen[0].slice(einzug + 2), ...zeilen.slice(1)];
}

// --- Ändern ------------------------------------------------------------------------------------------------------

function zeilenAnfang(text: string, i: number): number {
  return text.lastIndexOf('\n', i - 1) + 1;
}

function zeilenEnde(text: string, i: number): number {
  const n = text.indexOf('\n', i);
  return n < 0 ? text.length : n + 1;
}

/** Das Ende der letzten Zeile, die ein Knoten belegt (ohne einen Kommentar dahinter auf eigener Zeile). */
function endeDerZeile(text: string, n: Node): number {
  const r = n.range as [number, number, number];
  let ende = r[1];
  while (ende > r[0] && /\s/.test(text[ende - 1])) ende--;
  return zeilenEnde(text, Math.max(r[0], ende - 1));
}

function einzugAn(text: string, i: number): number {
  const a = zeilenAnfang(text, i);
  let n = 0;
  while (text[a + n] === ' ') n++;
  return n;
}

function ersetze(text: string, von: number, bis: number, neu: string): string {
  return text.slice(0, von) + neu + text.slice(bis);
}

/** Ob ein Knoten in einer Fluss-Sammlung steht oder selbst eine ist. */
function istFluss(n: unknown): boolean {
  return (isMap(n) || isSeq(n)) && !!(n as { flow?: boolean }).flow;
}

function fehler(pfad: Pfad): Error {
  return new Error(`Stelle ${pfad.join('.')} gibt es im Text nicht`);
}

/**
 * Setzt einen Wert. Gibt es die Stelle, ändert sich nur sie (ein Skalar an seinem Platz, eine Sammlung samt ihrem
 * Paar); sonst wird das Paar am Ende seines Objekts angefügt - fehlt das Objekt, entsteht es.
 */
export function setze(text: string, pfad: Pfad, wert: Wert): string {
  const g = lies(text);
  if (!g.ok) throw new Error(g.fehler);
  const { doc } = g;
  if (!pfad.length) throw new Error('leerer Pfad');
  const letzter = pfad[pfad.length - 1];
  const elternPfad = pfad.slice(0, -1);
  const eltern = elternPfad.length ? knoten(doc, elternPfad) : doc.contents;

  // Ein Listenplatz.
  if (typeof letzter === 'number') {
    if (!isSeq(eltern)) throw fehler(elternPfad);
    const alt = eltern.items[letzter] as Node | undefined;
    if (!alt) return fuegeAn(text, elternPfad, wert);
    return ersetzeKnoten(text, alt, wert, istFluss(eltern), true);
  }

  const p = isMap(eltern) ? paar(doc, pfad) : undefined;
  if (p) {
    const v = p.pair.value as Node | null;
    // Ein leerer Wert (`key:`) oder ein Wechsel zwischen Skalar und Sammlung: das ganze Paar neu.
    if (v && isScalar(v) && istSkalar(wert) && v.range && v.source !== undefined) {
      return ersetze(text, v.range[0], v.range[1], skalar(wert, istFluss(eltern)));
    }
    return ersetzePaar(text, p.pair, isMap(eltern) ? (eltern as Node) : undefined, String(letzter), wert);
  }
  if (isMap(eltern)) return fuegePaarAn(text, eltern as Node, String(letzter), wert);
  if (eltern === undefined || eltern === null || (isScalar(eltern) && eltern.value === null)) {
    // Das Objekt fehlt: es entsteht mit diesem einen Paar.
    if (!elternPfad.length) return `${text}${text.endsWith('\n') || !text ? '' : '\n'}${paarZeilen(String(letzter), wert, 0).join('\n')}\n`;
    return setze(text, elternPfad, { [String(letzter)]: wert });
  }
  throw fehler(elternPfad);
}

/** Ersetzt einen Knoten (Listeneintrag) durch einen neuen Wert. */
function ersetzeKnoten(text: string, alt: Node, wert: Wert, imFluss: boolean, listenEintragIst: boolean): string {
  const r = alt.range as [number, number, number];
  if (isScalar(alt) && istSkalar(wert)) return ersetze(text, r[0], r[1], skalar(wert, imFluss));
  if (imFluss) return ersetze(text, r[0], r[1], fluss(wert) ?? JSON.stringify(wert));
  if (listenEintragIst) {
    // Der Eintrag beginnt hinter `- `; seine Zeilen bis zum Ende werden neu geschrieben.
    const anfang = zeilenAnfang(text, r[0]);
    const strich = text.lastIndexOf('-', r[0]);
    const einzug = strich >= anfang ? strich - anfang : einzugAn(text, r[0]);
    return ersetze(text, anfang, endeDerZeile(text, alt), listenEintrag(wert, einzug).join('\n') + '\n');
  }
  return ersetze(text, r[0], r[1], fluss(wert) ?? JSON.stringify(wert));
}

/** Schreibt ein Paar neu, mit derselben Einrückung; in einem Fluss-Objekt an seinem Platz. */
function ersetzePaar(text: string, p: Pair, eltern: Node | undefined, schluessel: string, wert: Wert): string {
  const k = p.key as Node;
  const v = p.value as Node | null;
  const kr = k.range as [number, number, number];
  if (eltern && istFluss(eltern)) {
    const ende = v?.range ? v.range[1] : kr[1];
    return ersetze(text, kr[0], ende, `${skalar(schluessel, true)}: ${fluss(wert) ?? JSON.stringify(wert)}`);
  }
  const anfang = zeilenAnfang(text, kr[0]);
  const vorne = text.slice(anfang, kr[0]);
  const ende = v && v.range ? endeDerZeile(text, v) : zeilenEnde(text, kr[0]);
  // Ein Paar, das hinter `- ` beginnt (erster Schlüssel eines Listeneintrags), behält seinen Strich.
  const einzug = vorne.length;
  const zeilen = paarZeilen(schluessel, wert, einzug);
  zeilen[0] = vorne + zeilen[0].slice(einzug);
  return ersetze(text, anfang, ende, zeilen.join('\n') + '\n');
}

/** Fügt ein Paar am Ende eines Objekts an. */
function fuegePaarAn(text: string, objekt: Node, schluessel: string, wert: Wert): string {
  if (!isMap(objekt)) throw new Error('kein Objekt');
  const r = objekt.range as [number, number, number];
  if (istFluss(objekt)) {
    if (!objekt.items.length) {
      // `{}`: das Paar, dem das leere Objekt gehört, wird ein Block.
      return ersetzeLeeresObjekt(text, objekt, schluessel, wert);
    }
    const zu = text.lastIndexOf('}', r[1]);
    let vor = zu;
    while (vor > r[0] && text[vor - 1] === ' ') vor--;
    return ersetze(text, vor, zu, `, ${skalar(schluessel, true)}: ${fluss(wert) ?? JSON.stringify(wert)}`);
  }
  const letztes = objekt.items[objekt.items.length - 1] as Pair;
  const k = letztes.key as Node;
  const v = letztes.value as Node | null;
  const einzug = einzugDesSchluessels(text, k);
  const nach = v && v.range ? endeDerZeile(text, v) : zeilenEnde(text, (k.range as number[])[0]);
  const zeilen = paarZeilen(schluessel, wert, einzug).join('\n') + '\n';
  const davor = text.slice(0, nach);
  return davor + (davor.endsWith('\n') || !davor ? '' : '\n') + zeilen + text.slice(nach);
}

/** Die Einrückung eines Schlüssels; hinter `- ` zählt der Strich mit (erster Schlüssel eines Eintrags). */
function einzugDesSchluessels(text: string, k: Node): number {
  const r = k.range as number[];
  return r[0] - zeilenAnfang(text, r[0]);
}

/** Ein leeres Fluss-Objekt bekommt sein erstes Paar: das Paar darüber wird in Block-Form neu geschrieben. */
function ersetzeLeeresObjekt(text: string, objekt: Node, schluessel: string, wert: Wert): string {
  const g = lies(text);
  if (!g.ok) throw new Error(g.fehler);
  const r = objekt.range as number[];
  // Das Paar, dessen Wert dieses Objekt ist.
  const besitzer = findePaar(g.doc.contents, (p) => (p.value as Node | null)?.range?.[0] === r[0]);
  if (!besitzer) return ersetze(text, r[0], r[1], `{${skalar(schluessel, true)}: ${fluss(wert) ?? JSON.stringify(wert)}}`);
  const k = besitzer.key as Node;
  const kr = k.range as number[];
  const anfang = zeilenAnfang(text, kr[0]);
  const einzug = kr[0] - anfang;
  const zeilen = [text.slice(anfang, kr[0]) + skalar(String((k as unknown as { value: unknown }).value)) + ':',
    ...paarZeilen(schluessel, wert, einzug + 2)];
  return ersetze(text, anfang, endeDerZeile(text, objekt), zeilen.join('\n') + '\n');
}

function findePaar(n: unknown, passt: (p: Pair) => boolean): Pair | undefined {
  if (isMap(n)) {
    for (const p of n.items) {
      if (passt(p as Pair)) return p as Pair;
      const t = findePaar(p.value, passt);
      if (t) return t;
    }
  } else if (isSeq(n)) {
    for (const e of n.items) {
      const t = findePaar(e, passt);
      if (t) return t;
    }
  }
  return undefined;
}

/** Fügt einen Eintrag am Ende einer Liste an; fehlt die Liste, entsteht sie. */
export function fuegeAn(text: string, listenPfad: Pfad, wert: Wert): string {
  const g = lies(text);
  if (!g.ok) throw new Error(g.fehler);
  const liste = knoten(g.doc, listenPfad);
  if (!liste || (isScalar(liste) && liste.value === null)) return setze(text, listenPfad, [wert]);
  if (!isSeq(liste)) throw fehler(listenPfad);
  const r = liste.range as number[];
  if (istFluss(liste)) {
    if (!liste.items.length) return setze(text, listenPfad, [wert]);
    const zu = text.lastIndexOf(']', r[1]);
    return ersetze(text, zu, zu, `, ${fluss(wert) ?? JSON.stringify(wert)}`);
  }
  const letztes = liste.items[liste.items.length - 1] as Node;
  const lr = letztes.range as number[];
  const strich = text.lastIndexOf('-', lr[0]);
  const einzug = strich - zeilenAnfang(text, strich);
  const nach = endeDerZeile(text, letztes);
  const davor = text.slice(0, nach);
  return davor + (davor.endsWith('\n') ? '' : '\n') + listenEintrag(wert, einzug).join('\n') + '\n' + text.slice(nach);
}

/**
 * Entfernt ein Paar oder einen Listeneintrag samt seinen Zeilen. Wird ein Abschnitt dadurch leer, geht er mit
 * (ein leerer Abschnitt trägt nichts).
 */
export function entferne(text: string, pfad: Pfad): string {
  const g = lies(text);
  if (!g.ok) throw new Error(g.fehler);
  const { doc } = g;
  const letzter = pfad[pfad.length - 1];
  const elternPfad = pfad.slice(0, -1);
  const eltern = elternPfad.length ? knoten(doc, elternPfad) : doc.contents;
  if (typeof letzter === 'number') {
    if (!isSeq(eltern)) throw fehler(elternPfad);
    const e = eltern.items[letzter] as Node | undefined;
    if (!e) return text;
    if (eltern.items.length === 1 && elternPfad.length) return entferne(text, elternPfad);
    const r = e.range as number[];
    if (istFluss(eltern)) return entferneImFluss(text, r[0], r[1], eltern.items.indexOf(e) === 0);
    const anfang = zeilenAnfang(text, text.lastIndexOf('-', r[0]));
    return ersetze(text, anfang, endeDerZeile(text, e), '');
  }
  const p = paar(doc, pfad);
  if (!p) return text;
  if (isMap(eltern) && eltern.items.length === 1 && elternPfad.length) return entferne(text, elternPfad);
  const k = p.pair.key as Node;
  const v = p.pair.value as Node | null;
  const kr = k.range as number[];
  if (istFluss(eltern)) {
    const ende = v?.range ? v.range[1] : kr[1];
    return entferneImFluss(text, kr[0], ende, (eltern as { items: unknown[] }).items.indexOf(p.pair) === 0);
  }
  const anfang = zeilenAnfang(text, kr[0]);
  if (text.slice(anfang, kr[0]).trim() === '-') {
    // Erster Schlüssel eines Listeneintrags: der Eintrag bleibt, der nächste Schlüssel rückt an den Strich.
    const ende = v && v.range ? endeDerZeile(text, v) : zeilenEnde(text, kr[0]);
    const rest = text.slice(ende);
    const einzug = kr[0] - anfang;
    const naechste = rest.match(new RegExp(`^ {${einzug}}(?! )`));
    if (naechste) return text.slice(0, kr[0]) + rest.slice(einzug);
    return ersetze(text, kr[0], ende, '{}\n');
  }
  const ende = v && v.range ? endeDerZeile(text, v) : zeilenEnde(text, kr[0]);
  return ersetze(text, anfang, ende, '');
}

function entferneImFluss(text: string, von: number, bis: number, erstes: boolean): string {
  if (erstes) {
    const m = text.slice(bis).match(/^\s*,\s*/);
    return ersetze(text, von, bis + (m ? m[0].length : 0), '');
  }
  const davor = text.slice(0, von).match(/\s*,\s*$/);
  return ersetze(text, von - (davor ? davor[0].length : 0), bis, '');
}

/**
 * Tauscht einen Eintrag mit seinem Nachbarn (Reihenfolge der Lage und der Zustände zählt): die Zeilen beider
 * wechseln den Platz, Kommentare über ihnen wandern mit.
 */
export function verschiebe(text: string, sammlungPfad: Pfad, index: number, richtung: -1 | 1): string {
  const g = lies(text);
  if (!g.ok) throw new Error(g.fehler);
  const s = sammlungPfad.length ? knoten(g.doc, sammlungPfad) : g.doc.contents;
  if (!(isMap(s) || isSeq(s)) || istFluss(s)) return text;
  const items = s.items as unknown[];
  const j = index + richtung;
  if (index < 0 || j < 0 || index >= items.length || j >= items.length) return text;
  const [a, b] = index < j ? [index, j] : [j, index];
  const bereich = (i: number): [number, number] => {
    const it = items[i];
    const start = isMap(s) ? ((it as Pair).key as Node).range![0] : text.lastIndexOf('-', (it as Node).range![0]);
    const endKnoten = isMap(s) ? ((it as Pair).value as Node | null) ?? ((it as Pair).key as Node) : (it as Node);
    return [zeilenAnfang(text, start), endeDerZeile(text, endKnoten)];
  };
  const [a0, a1] = bereich(a);
  const [b0, b1] = bereich(b);
  return text.slice(0, a0) + text.slice(b0, b1) + text.slice(a1, b0) + text.slice(a0, a1) + text.slice(b1);
}

/** Die Zeilen (ab 1, beide eingeschlossen), die ein Eintrag belegt: für Meldungen und „im Text zeigen“. */
export function zeilenVon(g: Extract<Gelesen, { ok: true }>, pfad: Pfad): [number, number] | null {
  const n = knoten(g.doc, pfad);
  const letzter = pfad[pfad.length - 1];
  let start: number | undefined;
  if (typeof letzter === 'string') {
    const p = paar(g.doc, pfad);
    start = (p?.pair.key as Node | undefined)?.range?.[0];
  } else {
    start = n?.range?.[0];
  }
  if (start === undefined || !n?.range) return null;
  return [zeileVon(g, start), zeileVon(g, Math.max(start, n.range[1] - 1))];
}
