/**
 * Die Karte einer scharfen Steuerlogik und ihr Blatt „Warum?“ (Steuerlogik Stufe 3, Bericht 6.5, 7.1, 17.3).
 *
 * Rein: kein React, keine Uhr außer der übergebenen. Die Karte sagt in einem Satz, was die Logik gerade tut (die
 * Lage, die der Kern auf der Box bildet), zeigt eine Störung zuerst und trägt die Schalter, die der Kunde selbst
 * stellt. Das Blatt nennt die Bedingungen mit Haken, die Werte in zwei Gruppen („Das stellen Sie ein“ und „Das legt
 * Ihr Fachbetrieb fest“) und den Verlauf des Tages. Unbekannt ist nie „aus“, und ein Wert gilt erst als übernommen,
 * wenn die Box ihn zurückmeldet.
 */
import type {
  SteuerlogikKarte,
  SteuerlogikKartenGeraet,
  SteuerlogikStand,
  SteuerlogikStellwert,
  SteuerlogikVerlauf,
  SteuerlogikWarum,
} from './api';

const NB = ' ';
const MINUS = '−';

/** Die Pille einer Karte: Klasse der Steuerung (`.pill.on|wait|off|lock|done`) und ihr Wort. */
export interface Pille {
  klasse: 'on' | 'wait' | 'off' | 'lock' | 'done';
  wort: string;
}

/** Die Arten einer Lage-Zeile und ihr Wort auf der Pille (steuerlogik.schema.json, status[].type). */
const LAGE_PILLE: Record<string, Pille> = {
  solar: { klasse: 'on', wort: 'Sonnenstrom' },
  grid: { klasse: 'on', wort: 'Netz' },
  waiting: { klasse: 'wait', wort: 'wartet' },
  idle: { klasse: 'off', wort: 'ruht' },
  fault: { klasse: 'lock', wort: 'Störung' },
};

/** Störungen, die keine Störung der Logik sind, sondern ein Zustand, den jemand gewollt hat. */
const GEWOLLT = new Set(['pausiert']);

/** Die Störung, die die Karte zeigt (die erste), oder keine. */
export function hauptStoerung(k: SteuerlogikKarte): { code: string; text: string } | null {
  return k.stoerungen[0] ?? null;
}

/**
 * Die Störung, die die Karte UNTER dem Satz zeigt: die erste, die nicht schon Titel oder Satz ist (die Lage
 * „Störung Fühler“ steht schon als Titel da; darunter gehört, was fehlt: „Ohne Wert: Speicher.“).
 */
export function zusatzStoerung(k: SteuerlogikKarte): { code: string; text: string } | null {
  const { titel, satz } = kopf(k);
  return k.stoerungen.find((s) => s.text !== titel && s.text !== satz) ?? null;
}

/** Die Fußzeile der Karte: wie alt die Lage ist, wenn sie alt ist, sonst was die Geräte gerade tun. */
export function fusszeile(k: SteuerlogikKarte, jetzt: Date): string {
  const alt = stand(k, jetzt);
  if (alt) return alt;
  if (k.geraete.length === 1) {
    const z = geraetZeile(k.geraete[0]);
    return `${z.name} · ${z.jetzt}`;
  }
  const laufen = k.geraete.filter((g) => {
    const s = g.ist ?? g.befehl;
    return s != null && ((s.stufe ?? 0) > 0 || s.ein === true);
  }).length;
  return `${laufen} von ${k.geraete.length} Geräten laufen`;
}

export function pille(k: SteuerlogikKarte): Pille {
  const s = hauptStoerung(k);
  if (s && GEWOLLT.has(s.code)) return { klasse: 'off', wort: 'angehalten' };
  if (s && s.code === 'keine_meldung') return { klasse: 'off', wort: 'keine Meldung' };
  if (s) return { klasse: 'lock', wort: 'Störung' };
  return LAGE_PILLE[k.lage?.art ?? ''] ?? { klasse: 'wait', wort: 'läuft' };
}

/** Titel und Satz der Karte: die Lage der Box; ohne Meldung ein ehrlicher Satz statt einer erfundenen Lage. */
export function kopf(k: SteuerlogikKarte): { titel: string; satz: string } {
  const s = hauptStoerung(k);
  if (s && (s.code === 'haelt_an' || s.code === 'box_lehnt_ab')) {
    return { titel: 'Läuft nicht', satz: s.text };
  }
  if (!k.lage) {
    return { titel: 'Noch keine Meldung', satz: 'Die Box hat zu dieser Logik noch nichts gemeldet.' };
  }
  return { titel: k.lage.titel, satz: k.lage.satz ?? '' };
}

/** Wie alt die Lage ist, wenn sie älter als zwei Minuten ist („Stand 10:42“); sonst nichts. */
export function stand(k: SteuerlogikKarte, jetzt: Date): string | null {
  if (!k.gemeldetAm) return null;
  const t = new Date(k.gemeldetAm);
  if (jetzt.getTime() - t.getTime() < 120_000) return null;
  return `Stand ${uhr(t)}`;
}

export function uhr(t: Date): string {
  return t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
}

// --- Werte ---------------------------------------------------------------------------------------------------

/** Wie viele Nachkommastellen ein Schritt braucht (0,5 → 1). */
export function stellen(schritt: number | null): number {
  if (schritt == null || !Number.isFinite(schritt)) return 1;
  const t = String(schritt);
  const i = t.indexOf('.');
  return i < 0 ? 0 : Math.min(3, t.length - i - 1);
}

/** Eine Zahl deutsch, mit echtem Minus. */
export function zahlDeutsch(v: number, nachkomma: number): string {
  const s = v.toLocaleString('de-DE', { minimumFractionDigits: nachkomma, maximumFractionDigits: nachkomma });
  return s.replace('-', MINUS);
}

/** Die Zahl eines Werts in der Form des Dokuments („72 °C“ → 72); `null`, wenn es keine Zahl ist. */
export function zahlAus(wert: unknown): number | null {
  if (typeof wert === 'number') return Number.isFinite(wert) ? wert : null;
  if (typeof wert !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)/.exec(wert);
  return m ? Number(m[1]) : null;
}

/** Ein Zahlwert in der Form des Dokuments: Punkt, Leerzeichen, Einheit („72.5 °C“). */
export function insDokument(s: SteuerlogikStellwert, v: number): string | number {
  const n = Number(v.toFixed(stellen(s.schritt) + 2));
  const text = String(n);
  return s.einheit ? `${text} ${s.einheit}` : n;
}

/** Ein Wert für Menschen: „72 °C“ (schmales Leerzeichen), „an“/„aus“, „06:00 Uhr“, der Name einer Auswahl. */
export function wertText(s: SteuerlogikStellwert, wert: unknown): string {
  if (s.art === 'boolean') return wert === 'on' || wert === true ? 'an' : 'aus';
  if (s.art === 'select') {
    const o = (s.optionen ?? []).find((x) => x.wert === wert);
    return o ? o.name : String(wert ?? '');
  }
  if (s.art === 'uhrzeit') return typeof wert === 'string' ? `${wert}${NB}Uhr` : '';
  if (s.art === 'schedule') return 'nach Zeitplan';
  const v = zahlAus(wert);
  if (v == null) return '';
  const t = zahlDeutsch(v, stellen(s.schritt));
  return s.einheit ? `${t}${NB}${s.einheit}` : t;
}

/** Der Wert, wie er gerade gilt: was die Box meldet, solange die Cloud nichts Neueres gestellt hat. */
export function geltend(s: SteuerlogikStellwert): unknown {
  return s.uebernommen || s.wertBox == null ? s.wert : s.wertBox;
}

/** Ein Schalter ist an, wenn sein Wert „on“ ist. */
export function istAn(wert: unknown): boolean {
  return wert === 'on' || wert === true;
}

/** Der nächste Wert eines Reglers um einen Schritt, in seinen Grenzen; `null`, wenn er dort schon steht. */
export function schritt(s: SteuerlogikStellwert, aktuell: number, richtung: 1 | -1): number | null {
  const d = s.schritt ?? 1;
  const basis = s.von ?? 0;
  let n = Math.round((aktuell - basis) / d) + richtung;
  let v = basis + n * d;
  if (s.von != null && v < s.von - 1e-9) v = s.von;
  if (s.bis != null && v > s.bis + 1e-9) {
    n = Math.floor((s.bis - basis) / d + 1e-9);
    v = basis + n * d;
  }
  v = Number(v.toFixed(stellen(s.schritt) + 2));
  return Math.abs(v - aktuell) < 1e-9 ? null : v;
}

/** Die Gruppen des Blatts: was der Kunde stellt (Zielwerte und `customer`), was der Fachbetrieb festlegt. */
export function gruppen(werte: SteuerlogikStellwert[]): { frei: SteuerlogikStellwert[]; fachbetrieb: SteuerlogikStellwert[] } {
  return { frei: werte.filter((w) => w.frei), fachbetrieb: werte.filter((w) => !w.frei) };
}

/** Die Schalter, die die Karte selbst trägt (Bericht 17.3: „ein Satz, ein Bild, der Schalter“). */
export function kartenSchalter(k: SteuerlogikKarte): SteuerlogikStellwert[] {
  return k.stellwerte.filter((s) => s.frei && s.art === 'boolean');
}

// --- Geräte --------------------------------------------------------------------------------------------------

/** Ein Schaltstand für Menschen: „3 Phasen“, „1 Phase“, „aus“, „an“; unbekannt ist kein Wort. */
/** Die Betriebsarten der Regelsprache (`steuerlogik-woerter.json`) in Kundenwörtern; ein fremdes Wort bleibt stehen. */
const BETRIEBSART: Record<string, string> = {
  normal: 'normal',
  boost: 'angehoben',
  cool: 'kühlt',
  heat: 'heizt',
  fan_only: 'lüftet',
  dry: 'trocknet',
  auto: 'Automatik',
  start: 'Start',
};

/**
 * Ein Stand in Kundenwörtern: Phasen eines Heizstabs, sonst an/aus und bei einem Gerät, das selbst regelt (Klima,
 * Heizung, Kälte), sein Sollwert und seine Betriebsart - „an · 25 °C · kühlt“. Ein ausgeschaltetes Gerät ist nur „aus“.
 */
export function standText(s: SteuerlogikStand | null): string | null {
  if (!s) return null;
  if (s.stufe != null) return s.stufe === 0 ? 'aus' : s.stufe === 1 ? '1 Phase' : `${s.stufe} Phasen`;
  if (s.ein === false) return 'aus';
  const teile: string[] = [];
  if (s.ein) teile.push('an');
  if (s.sollwert != null) teile.push(`${zahlDeutsch(s.sollwert, Number.isInteger(s.sollwert) ? 0 : 1)}${NB}°C`);
  if (s.betriebsart) teile.push(BETRIEBSART[s.betriebsart] ?? s.betriebsart);
  return teile.length ? teile.join(' · ') : null;
}

const HALTER: Record<string, string> = {
  'local-ui': 'von Hand',
  'cloud-command': 'von Hand',
  heizstab: 'Heizstab-Regler',
  flow: 'eine Regel',
  'plan-executor': 'der Fahrplan',
  'deadline-fallback': 'eine Frist',
  failsafe: 'Ruhewert',
};

/** Die Zeile eines Geräts: Name, was es tut, warum es anders ist als gewünscht. */
export function geraetZeile(g: SteuerlogikKartenGeraet): { name: string; jetzt: string; grund: string | null } {
  const ist = standText(g.ist) ?? standText(g.befehl);
  const jetzt = ist ?? 'Schaltstand unbekannt';
  let grund: string | null = null;
  if (g.konflikt) grund = g.konflikt.text;
  else if (g.halter && g.halter !== 'failsafe') grund = `Gerade bestimmt ${HALTER[g.halter] ?? g.halter}.`;
  else if (g.schutz) grund = schutzSatz(g.schutz.code, g.schutz.text);
  return { name: g.name, jetzt, grund };
}

/** Der Grund eines Schutzes als Satz („läuft - Mindestlaufzeit hält“ → „Die Mindestlaufzeit hält es noch an.“). */
export function schutzSatz(code: string, text: string): string {
  switch (code) {
    case 'guard_min_on':
      return 'Schutz: die Mindestlaufzeit hält es noch an.';
    case 'guard_min_off':
      return 'Schutz: die Mindestpause hält es noch aus.';
    case 'guard_max_starts':
      return 'Schutz: die Starts für heute sind aufgebraucht.';
    default:
      return `Schutz: ${text}`;
  }
}

// --- Warum ---------------------------------------------------------------------------------------------------

/** Die Überschrift einer Gruppe der Liste „Warum?“. */
/**
 * Die Überschrift einer Gruppe: der Satz, den die Box schickt (der Satz der Logik oder einer aus ihrem Wortschatz),
 * und wie die Bedingungen darunter zusammen gelten. Kennungen von Zuständen und Schritten erscheinen nie; eine Box
 * ohne Satz bekommt ein allgemeines Wort.
 */
export function warumTitel(g: SteuerlogikWarum): string {
  const satz = g.satz?.trim() || (g.was === 'an' ? 'Schaltet ein' : g.was === 'aus' ? 'Schaltet aus' : 'Nächster Schritt');
  const wie =
    g.bedingungen.length === 1 ? 'wenn dies zutrifft' : g.modus === 'alle' ? 'wenn alles erfüllt ist' : 'sobald eines davon zutrifft';
  return `${satz}, ${wie}`;
}

/** Wie lange ein Schritt noch wartet („frühestens in 4 min“). */
export function wartetText(s: number | undefined): string | null {
  if (!s || s <= 0) return null;
  if (s < 90) return `frühestens in ${s}${NB}s`;
  return `frühestens in ${Math.ceil(s / 60)}${NB}min`;
}

/**
 * Die Gruppen in der Reihenfolge für Menschen: zuerst die mit benannten Bedingungen und einem Satz der Logik, dann
 * die, deren Text nur Formeln trägt - sonst in der Reihenfolge des Textes.
 */
export function warumSortiert(gruppen: SteuerlogikWarum[] | null): SteuerlogikWarum[] {
  const gewicht = (g: SteuerlogikWarum) => (g.eigen ? 1 : 0) + (g.bedingungen.some((b) => !b.formel) ? 2 : 0);
  return (gruppen ?? []).map((g, i) => ({ g, i })).sort((a, b) => gewicht(b.g) - gewicht(a.g) || a.i - b.i).map((x) => x.g);
}

/** Ob eine Gruppe gerade erfüllt ist (alle oder eines); `null` = unbekannt. */
export function erfuellt(g: SteuerlogikWarum): boolean | null {
  const ok = g.bedingungen.map((b) => b.ok);
  if (g.modus === 'alle') {
    if (ok.some((x) => x === false)) return false;
    return ok.some((x) => x === null) ? null : true;
  }
  if (ok.some((x) => x === true)) return true;
  return ok.some((x) => x === null) ? null : false;
}

// --- Verlauf -------------------------------------------------------------------------------------------------

/** Eine Zeile des Verlaufs: Zeit, Satz, Art (Schaltung oder Schritt eines Menschen). */
export interface VerlaufZeile {
  t: string;
  uhr: string;
  satz: string;
  art: 'schaltung' | 'mensch';
}

const SCHRITT_WORT: Record<string, string> = {
  angenommen: 'neue Fassung angenommen',
  scharf: 'scharf geschaltet',
  zurueck: 'zur vorigen Fassung zurückgekehrt',
  stillgelegt: 'stillgelegt',
};

/**
 * Der Verlauf eines Tages, jüngstes zuerst: jede Schaltung (was das Gerät tat, mit der Lage in dieser Sekunde) und
 * jeder Schritt eines Menschen (wer welchen Wert gestellt hat). Hat die Box einen Schaltstand nicht gelesen, steht
 * die Wunschzeile da, ausdrücklich als Wunsch.
 */
export function verlaufZeilen(v: SteuerlogikVerlauf, k: SteuerlogikKarte): VerlaufZeile[] {
  const namen = new Map(k.geraete.map((g) => [g.kennung, g.name]));
  const werte = new Map(k.stellwerte.map((s) => [s.kennung, s]));
  const mitIst = new Set(v.wechsel.filter((w) => w.was === 'ist').map((w) => w.geraet));
  const out: VerlaufZeile[] = [];
  for (const w of v.wechsel) {
    if (w.was === 'wunsch' && mitIst.has(w.geraet)) continue;
    const name = namen.get(w.geraet) ?? w.geraet;
    const neu = standText(w.neu) ?? 'unbekannt';
    const satz = w.was === 'ist' ? `${name}: ${neu}` : `${name} soll: ${neu}`;
    out.push({ t: w.t, uhr: uhr(new Date(w.t)), satz: w.lage ? `${satz} · ${w.lage}` : satz, art: 'schaltung' });
  }
  for (const s of v.schritte) {
    const wer = s.von ?? 'VoltPilot';
    let satz: string;
    if (s.was === 'stellwert') {
      const d = (s.daten ?? {}) as { kennung?: string; name?: string; alt?: unknown; neu?: unknown; verworfen?: boolean };
      const sw = d.kennung ? werte.get(d.kennung) : undefined;
      const name = d.name ?? sw?.name ?? d.kennung ?? 'ein Wert';
      if (d.verworfen) satz = `${name} gilt wieder mit der Vorgabe (passt nicht zur neuen Fassung)`;
      else if (sw) satz = `${wer}: ${name} ${wertText(sw, d.alt)} → ${wertText(sw, d.neu)}`;
      else satz = `${wer}: ${name} geändert`;
    } else {
      satz = `${wer}: ${SCHRITT_WORT[s.was] ?? s.was} (Fassung ${s.fassung})`;
    }
    out.push({ t: s.am, uhr: uhr(new Date(s.am)), satz, art: 'mensch' });
  }
  return out.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
}

/** Die Logiken, die ein Gerät führen: Entität → Name der Logik (für „Smart: Logik „…““ in der Geräteliste). */
export function herrschaft(karten: SteuerlogikKarte[] | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of karten ?? []) for (const g of k.geraete) out.set(g.entityId, k.name);
  return out;
}
