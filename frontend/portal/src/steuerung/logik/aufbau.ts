/**
 * Die Ansicht „Aufbau“ einer Logik (Steuerlogik Stufe 4, Bericht 12.3): derselbe Text, als Abschnitte mit ihren
 * Einträgen; jeder Eintrag, den ein Formular darstellen kann, lässt sich dort anlegen und ändern. Was kein Formular
 * darstellen kann (eine Gestalt, die der Aufbau nicht kennt, etwa ein Zeitplan), bleibt Text und steht lesbar als
 * „im Text festgelegt“ da - der Aufbau lässt nichts fallen (Bericht 6.6 Punkt 3).
 *
 * Rein: liest den Text über `text.ts`, schreibt Änderungen als Pfad-Operationen zurück. Die Sprache (Formeln,
 * Einheiten, ob ein Name existiert) prüft nur der Logik-Dienst.
 */
import { entferne, fuegeAn, lies, setze, Wort, zeilenVon, type Gelesen, type Pfad, type Wert } from './text';

export type AbschnittId =
  | 'devices' | 'inputs' | 'settings' | 'constraints' | 'formulas' | 'states' | 'outputs' | 'status'
  | 'notifications' | 'tests';

export type FormArt =
  | 'geraet' | 'eingang' | 'stellwert' | 'zusammen' | 'formel' | 'zustand' | 'ausgang' | 'lage' | 'meldung'
  | 'probe';

export interface AbschnittDef {
  id: AbschnittId;
  titel: string;
  /** Ein Satz, was hier steht. */
  satz: string;
  /** Ein Abschnitt als Liste (Reihenfolge zählt) statt als Objekt mit Kennungen. */
  liste: boolean;
  form: FormArt;
  /** Wie ein neuer Eintrag heißt („Gerät hinzufügen“). */
  neu: string;
}

export const ABSCHNITTE: AbschnittDef[] = [
  { id: 'devices', titel: 'Geräte', satz: 'Was die Logik schaltet.', liste: false, form: 'geraet', neu: 'Gerät' },
  { id: 'inputs', titel: 'Eingänge', satz: 'Was sie liest. Ohne frischen Wert gilt „unbekannt“.', liste: false, form: 'eingang', neu: 'Eingang' },
  { id: 'settings', titel: 'Stellwerte', satz: 'Werte mit Bereich, und wer sie stellt.', liste: false, form: 'stellwert', neu: 'Stellwert' },
  { id: 'constraints', titel: 'Regeln zwischen Stellwerten', satz: 'Was zwischen den Stellwerten immer gelten muss.', liste: true, form: 'zusammen', neu: 'Regel' },
  { id: 'formulas', titel: 'Abgeleitete Werte', satz: 'Formeln, die immer mit den Werten von jetzt gelten.', liste: false, form: 'formel', neu: 'Wert' },
  { id: 'states', titel: 'Zustände und Zeitgeber', satz: 'Was sich die Logik merkt. Die Reihenfolge ist die der Auswertung.', liste: false, form: 'zustand', neu: 'Zustand' },
  { id: 'outputs', titel: 'Ausgänge', satz: 'Was jedes Gerät tun soll.', liste: false, form: 'ausgang', neu: 'Ausgang' },
  { id: 'status', titel: 'Erklärsätze', satz: 'Titel und Satz für den Kunden. Die erste zutreffende Zeile gilt, die letzte ist „sonst“.', liste: true, form: 'lage', neu: 'Satz' },
  { id: 'notifications', titel: 'Meldungen', satz: 'Eine Nachricht, wenn etwas eintritt.', liste: true, form: 'meldung', neu: 'Meldung' },
  { id: 'tests', titel: 'Proben', satz: 'Freiwillig: durchgespielte Fälle mit erwartetem Ergebnis.', liste: true, form: 'probe', neu: 'Probe' },
];

/** Die Schlüssel, die der Aufbau oben im Dokument kennt; alles andere bleibt Text. */
const KOPF = new Set(['logic', 'name', 'description', ...ABSCHNITTE.map((a) => a.id)]);

export interface Eintrag {
  pfad: Pfad;
  /** Kennung (Objekt) oder Platz ab 1 (Liste). */
  schluessel: string;
  titel: string;
  unter: string;
  wert: unknown;
  zeilen: [number, number] | null;
  /** Das Formular, das ihn darstellt; `null` = im Text festgelegt. */
  form: FormArt | null;
}

export interface Aufbau {
  name: string;
  beschreibung: string;
  abschnitte: { def: AbschnittDef; eintraege: Eintrag[]; zeilen: [number, number] | null; nurText: boolean }[];
  /** Was oben im Dokument steht und kein Abschnitt des Aufbaus ist (etwa `display`). */
  sonst: { schluessel: string; zeilen: [number, number] | null }[];
}

type Obj = Record<string, unknown>;

function istObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function istSkalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function nurSchluessel(o: Obj, erlaubt: string[]): boolean {
  return Object.keys(o).every((k) => erlaubt.includes(k));
}

/** Eine Liste von Bedingungen: eine Formel oder eine Liste aus Formeln und `{Name: Formel}`. */
export function istBedingungen(v: unknown): boolean {
  if (v === undefined) return true;
  if (istSkalar(v)) return true;
  return Array.isArray(v) && v.every((c) => istSkalar(c) || (istObj(c) && Object.keys(c).length === 1 && istSkalar(Object.values(c)[0])));
}

/** Welche Form einen Eintrag darstellt, oder `null`, wenn er im Text bleibt. */
export function formFuer(art: FormArt, w: unknown): FormArt | null {
  switch (art) {
    case 'geraet':
      return istObj(w) && nurSchluessel(w, ['entity', 'name']) && istSkalar(w.entity) ? art : null;
    case 'eingang':
      return istObj(w) && nurSchluessel(w, ['source', 'name', 'max_age']) && typeof w.source === 'string' ? art : null;
    case 'stellwert': {
      if (!istObj(w) || !nurSchluessel(w, ['name', 'type', 'default', 'range', 'step', 'editable_by', 'help', 'options'])) return null;
      if (w.type === 'schedule' || !istSkalar(w.default)) return null;
      if (w.range !== undefined && !(Array.isArray(w.range) && w.range.length === 2 && w.range.every(istSkalar))) return null;
      if (w.options !== undefined && !(istObj(w.options) && Object.values(w.options).every(istSkalar))) return null;
      if (w.help !== undefined && !istSkalar(w.help)) return null;
      return art;
    }
    case 'zusammen':
      return istObj(w) && Object.keys(w).length === 1 && istSkalar(Object.values(w)[0]) ? art : null;
    case 'formel':
      return istSkalar(w) ? art : null;
    case 'zustand': {
      if (!istObj(w)) return null;
      if (w.type === 'boolean') {
        return nurSchluessel(w, ['type', 'name', 'on_when', 'on_when_any', 'off_when', 'off_when_any', 'after_restart', 'on_text', 'off_text'])
          && ['on_when', 'on_when_any', 'off_when', 'off_when_any'].every((k) => istBedingungen(w[k])) ? art : null;
      }
      if (w.type === 'timer') return nurSchluessel(w, ['type', 'name', 'duration', 'after_restart']) ? art : null;
      if (w.type === 'counter') {
        if (!nurSchluessel(w, ['type', 'name', 'min', 'max', 'after_restart', 'steps']) || !Array.isArray(w.steps)) return null;
        return w.steps.every((s) => istObj(s) && nurSchluessel(s, ['name', 'text', 'by', 'set', 'not_before', 'when', 'when_any', 'then'])
          && istBedingungen(s.when) && istBedingungen(s.when_any)) ? art : null;
      }
      return null;
    }
    case 'ausgang':
      return istObj(w) && nurSchluessel(w, ['level', 'on_off', 'setpoint', 'mode', 'percent']) && Object.values(w).every(istSkalar) ? art : null;
    case 'lage':
      return istObj(w) && nurSchluessel(w, ['when', 'else', 'title', 'type', 'text']) ? art : null;
    case 'meldung':
      return istObj(w) && nurSchluessel(w, ['when', 'to', 'text', 'repeat_after']) ? art : null;
    case 'probe':
      return istObj(w) && nurSchluessel(w, ['name', 'given', 'after', 'expect'])
        && (w.given === undefined || (istObj(w.given) && Object.values(w.given).every(istSkalar)))
        && (w.expect === undefined || (istObj(w.expect) && Object.values(w.expect).every(istSkalar))) ? art : null;
  }
  return null;
}

const DARF: Record<string, string> = { customer: 'Kunde stellt', customer_admin: 'Kundenadministrator stellt', installer: 'Fachbetrieb stellt' };
const LAGE_ART: Record<string, string> = { solar: 'Sonne', grid: 'Netz', waiting: 'wartet', idle: 'ruht', fault: 'Störung' };
const AUSGANG: Record<string, string> = { level: 'Stufe', on_off: 'Ein/Aus', setpoint: 'Sollwert', mode: 'Betriebsart', percent: 'Anteil' };
const ZUSTAND_ART: Record<string, string> = { boolean: 'Schalter', counter: 'Zähler', timer: 'Zeitgeber' };

function anzahl(n: number, eins: string, viele: string): string {
  return `${n} ${n === 1 ? eins : viele}`;
}

function bedingungenZahl(v: unknown): number {
  if (v === undefined) return 0;
  return Array.isArray(v) ? v.length : 1;
}

function text(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Titel und Kurzsatz eines Eintrags für die Liste des Aufbaus. */
export function beschreibe(art: FormArt, schluessel: string, w: unknown, namen: Record<string, string> = {}): { titel: string; unter: string } {
  const o = istObj(w) ? w : {};
  switch (art) {
    case 'geraet':
      return { titel: text(o.name) || schluessel, unter: namen[text(o.entity)] ?? 'Gerät nicht gefunden' };
    case 'eingang':
      return { titel: text(o.name) || schluessel, unter: [namen[text(o.source)] ?? text(o.source), o.max_age ? `höchstens ${text(o.max_age)} alt` : ''].filter(Boolean).join(' · ') };
    case 'stellwert': {
      const bereich = Array.isArray(o.range) ? ` (${o.range.map(text).join(' bis ')})` : '';
      const wer = String(o.default).endsWith('°C') ? 'Kunde stellt' : DARF[text(o.editable_by)] ?? 'Fachbetrieb stellt';
      const vorgabe = o.type === 'select' && istObj(o.options) ? text(o.options[text(o.default)] ?? o.default) : text(o.default);
      return { titel: text(o.name) || schluessel, unter: `${vorgabe}${bereich} · ${wer}` };
    }
    case 'zusammen': {
      const [name, formel] = Object.entries(o)[0] ?? ['', ''];
      return { titel: name, unter: text(formel) };
    }
    case 'formel':
      return { titel: schluessel, unter: text(w) };
    case 'zustand': {
      const typ = ZUSTAND_ART[text(o.type)] ?? text(o.type);
      let teil = '';
      if (o.type === 'boolean') {
        const an = bedingungenZahl(o.on_when) + bedingungenZahl(o.on_when_any);
        const aus = bedingungenZahl(o.off_when) + bedingungenZahl(o.off_when_any);
        teil = `${anzahl(an, 'Bedingung', 'Bedingungen')} für an, ${aus} für aus`;
      } else if (o.type === 'counter') {
        teil = `${text(o.min)} bis ${text(o.max)} · ${anzahl(Array.isArray(o.steps) ? o.steps.length : 0, 'Schritt', 'Schritte')}`;
      } else if (o.type === 'timer') {
        teil = `Dauer ${text(o.duration)}`;
      }
      return { titel: text(o.name) || schluessel, unter: `${typ} · ${teil}` };
    }
    case 'ausgang':
      return { titel: namen[`geraet:${schluessel}`] ?? schluessel, unter: Object.entries(o).map(([k, v]) => `${AUSGANG[k] ?? k}: ${text(v)}`).join(' · ') };
    case 'lage':
      return { titel: text(o.title), unter: `${o.else === true ? 'sonst' : `wenn ${text(o.when)}`} · ${LAGE_ART[text(o.type)] ?? text(o.type)}` };
    case 'meldung':
      return { titel: text(o.text), unter: `wenn ${text(o.when)}` };
    case 'probe': {
      const erwartet = istObj(o.expect) ? Object.keys(o.expect).length : 0;
      return { titel: text(o.name), unter: `${o.after ? `nach ${text(o.after)} · ` : ''}${anzahl(erwartet, 'Erwartung', 'Erwartungen')}` };
    }
  }
  return { titel: schluessel, unter: '' };
}

/**
 * Der Aufbau eines gelesenen Textes. `namen` übersetzt Kennungen für Menschen: Gerätekennungen und Quellen der Anlage
 * (`entity`/`source` → Name) und `geraet:<schluessel>` → Name des Geräts der Logik.
 */
export function aufbau(g: Extract<Gelesen, { ok: true }>, namen: Record<string, string> = {}): Aufbau {
  const js = (g.doc.toJS() ?? {}) as Obj;
  const geraeteNamen: Record<string, string> = { ...namen };
  if (istObj(js.devices)) {
    for (const [k, v] of Object.entries(js.devices)) if (istObj(v) && v.name) geraeteNamen[`geraet:${k}`] = String(v.name);
  }
  const abschnitte = ABSCHNITTE.map((def) => {
    const roh = js[def.id];
    const eintraege: Eintrag[] = [];
    let nurText = false;
    if (def.liste) {
      if (Array.isArray(roh)) {
        roh.forEach((w, i) => {
          const form = formFuer(def.form, w);
          eintraege.push({ pfad: [def.id, i], schluessel: String(i + 1), ...beschreibe(def.form, String(i + 1), w, geraeteNamen), wert: w, zeilen: zeilenVon(g, [def.id, i]), form });
        });
      } else if (roh !== undefined && roh !== null) {
        nurText = true;
      }
    } else if (istObj(roh)) {
      for (const [k, w] of Object.entries(roh)) {
        const form = formFuer(def.form, w);
        eintraege.push({ pfad: [def.id, k], schluessel: k, ...beschreibe(def.form, k, w, geraeteNamen), wert: w, zeilen: zeilenVon(g, [def.id, k]), form });
      }
    } else if (roh !== undefined && roh !== null) {
      nurText = true;
    }
    return { def, eintraege, zeilen: roh === undefined ? null : zeilenVon(g, [def.id]), nurText };
  });
  const sonst = Object.keys(js).filter((k) => !KOPF.has(k)).map((k) => ({ schluessel: k, zeilen: zeilenVon(g, [k]) }));
  return { name: text(js.name), beschreibung: text(js.description), abschnitte, sonst };
}

// --- Schreiben aus dem Formular ----------------------------------------------------------------------------------

/** Felder, deren Werte Wörter der Sprache sind und ohne Anführungszeichen stehen. */
const WORT_FELDER = new Set(['type', 'after_restart', 'editable_by']);
const ZAHL = /^[-+]?\d+(\.\d+)?$/;

/**
 * Ein Wert aus dem Formular in der Form der Textform: Wörter der Sprache ohne Anführungszeichen (die on/off-Regel:
 * `on`/`off` sind feste Werte), eine reine Zahl als Zahl, leere Felder fallen weg.
 */
export function alsWert(feld: string, v: unknown, art: FormArt): Wert | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) {
    const liste = v.map((e, i) => alsWert(String(i), e, art)).filter((e): e is Wert => e !== undefined);
    return liste;
  }
  if (istObj(v)) {
    const o: Record<string, Wert> = {};
    for (const [k, w] of Object.entries(v)) {
      const x = alsWert(feld === 'given' || feld === 'expect' ? `wert:${k}` : k, w, art);
      if (x !== undefined) o[k] = x;
    }
    return o;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v).trim();
  if (s === '') return undefined;
  if (WORT_FELDER.has(feld) || feld === 'to') return new Wort(s);
  if (ZAHL.test(s) && feld !== 'name' && feld !== 'title' && feld !== 'text' && feld !== 'help') return Number(s);
  // Ein fester Ja/Nein-Wert einer Probe oder Vorgabe: on/off (Vertrag: on = true, off = false).
  if ((feld === 'default' || feld.startsWith('wert:')) && /^(on|off|unknown)$/.test(s)) return new Wort(s);
  return s;
}

function gleich(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Schreibt die Änderungen eines Formulars in den Text: je geändertem Feld eine Operation, damit unveränderte Felder
 * samt Kommentaren stehen bleiben. `alt === undefined` legt den Eintrag neu an.
 */
export function schreibeEintrag(text: string, pfad: Pfad, art: FormArt, alt: unknown, neu: unknown): string {
  if (alt === undefined) {
    const w = alsWert(String(pfad[pfad.length - 1]), neu, art);
    if (w === undefined) return text;
    if (typeof pfad[pfad.length - 1] === 'number') return fuegeAn(text, pfad.slice(0, -1), w);
    return setze(text, pfad, w);
  }
  if (!istObj(alt) || !istObj(neu)) {
    const w = alsWert(String(pfad[pfad.length - 1]), neu, art);
    if (gleich(alt, neu)) return text;
    return w === undefined ? entferne(text, pfad) : setze(text, pfad, w);
  }
  // Eine benannte Bedingung zwischen Stellwerten ist ein Objekt mit EINEM Schlüssel: ein neuer Name ist ein neues Paar.
  if (art === 'zusammen') {
    if (gleich(alt, neu)) return text;
    const w = alsWert('constraint', neu, art);
    return w === undefined ? entferne(text, pfad) : setze(text, pfad, w);
  }
  let t = text;
  for (const k of Object.keys(alt)) {
    if (!(k in neu) || alsWert(k, neu[k], art) === undefined) t = entferne(t, [...pfad, k]);
  }
  for (const [k, v] of Object.entries(neu)) {
    if (k in alt && gleich(alt[k], v)) continue;
    const w = alsWert(k, v, art);
    if (w === undefined) continue;
    t = setze(t, [...pfad, k], w);
  }
  return t;
}

/** Ein Text, den der Aufbau darstellen kann - für die Prüfung der Formulare, ob der Text lesbar blieb. */
export function lesbar(text: string): boolean {
  return lies(text).ok;
}
