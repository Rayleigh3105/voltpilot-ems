/**
 * Heizstab V1, Paket 4 - die reinen Ableitungen der Heizstab-Flächen (Heizstab-Konzept, entschieden
 * 31.10.2026; Verträge docs/contracts/v2/heizstab-shelly.md und heizstab-regler.md).
 *
 * Ein Heizstab mit einem Element je Phase hängt an mehreren Ausgängen eines Shelly und ist EIN Gerät,
 * geschaltet in Stufen (1, 2, 3 Phasen). Hier stehen: die Prüfung der Ausgangsmenge (Zwilling der Box
 * und der API, gleiche Sätze, gleiche Vektoren `heizstab-stufen-vectors.json`), die Stufen mit ihren kW,
 * die Verbindung, die das Anlegen schickt, und die Sätze der Geräteseite - was BESTÄTIGT läuft, nie was
 * befohlen ist, und eine Abweichung, die länger als 3 min anhält, als Hinweis (HZ-4 B).
 */

/** Anschluss der Heizelemente (connection.anschluss). */
export type Anschluss = 'stern_mit_n' | 'ohne_n' | 'dreieck' | 'unbekannt';

export const ANSCHLUSS_WAHL: { wert: Anschluss; titel: string; text: string }[] = [
  {
    wert: 'stern_mit_n',
    titel: 'Jede Phase mit Neutralleiter',
    text: 'Stern mit N. Der Shelly darf jede Phase einzeln schalten.',
  },
  {
    wert: 'ohne_n',
    titel: 'Ohne Neutralleiter',
    text: 'Stern ohne N. Davor gehört ein dreipoliges Schütz.',
  },
  {
    wert: 'dreieck',
    titel: 'Im Dreieck',
    text: 'Davor gehört ein dreipoliges Schütz.',
  },
  {
    wert: 'unbekannt',
    titel: 'Weiß ich nicht',
    text: 'Ihr Elektriker klärt das. Bis dahin schaltet VoltPilot den Heizstab nicht.',
  },
];

/** Die Ausgangsmenge, wie sie in `connection` reist. */
export interface Ausgangsmenge {
  channels: number[];
  output_kw: number[];
  stages?: number[];
  rotation?: 'daily' | 'fixed';
}

/**
 * Der Satz, warum die Menge nicht geht; null = in Ordnung. Dieselben Regeln und Sätze wie die Box
 * (`shelly.Config.GroupError`) und die API (`HeizstabAusgaenge.fehler`).
 */
export function ausgangsFehler(c: Partial<Ausgangsmenge> & Record<string, unknown>): string | null {
  const chs = Array.isArray(c.channels) ? c.channels : [];
  if (chs.length === 0) return 'Die Ausgänge des Heizstabs fehlen.';
  if (chs.length > 4) return 'Ein Gerät umfasst höchstens vier Ausgänge.';
  const gesehen = new Set<number>();
  for (const ch of chs) {
    if (!Number.isInteger(ch) || ch < 0 || ch > 3) return 'Der Schaltkanal muss zwischen 0 und 3 liegen.';
    if (gesehen.has(ch)) return `Ausgang ${ch} steht zweimal in der Ausgangsmenge.`;
    gesehen.add(ch);
  }
  const kw = Array.isArray(c.output_kw) ? c.output_kw : null;
  if (!kw || kw.length !== chs.length) return 'Für jeden Ausgang fehlt die Leistung seines Heizelements (kW).';
  if (kw.some((k) => typeof k !== 'number' || !Number.isFinite(k) || k <= 0)) {
    return 'Die Leistung jedes Heizelements muss größer als 0 sein.';
  }
  const stufen = Array.isArray(c.stages) && c.stages.length > 0 ? c.stages : [chs.length];
  let vorher = 0;
  for (const s of stufen) {
    if (!Number.isInteger(s) || s < 1 || s > chs.length || s <= vorher) {
      return 'Die Stufen müssen aufsteigend zwischen 1 und der Zahl der Ausgänge liegen.';
    }
    vorher = s;
  }
  if (stufen[0] < chs.length && kw.some((k) => k > 4.6 + 1e-9)) {
    return 'Einzelne Phasen gibt es nur mit Heizelementen bis 4,6 kW (Schieflast) - dieser Heizstab schaltet nur alle Ausgänge zusammen.';
  }
  if (c.rotation !== undefined && c.rotation !== null && !['daily', 'fixed', ''].includes(String(c.rotation))) {
    return 'Unbekannte Phasenwahl für Stufe 1.';
  }
  return null;
}

/** Der Anschluss-Satz (nur Cloud und Portal kennen den Anschluss); null = darf so angelegt werden. */
export function anschlussFehler(anschluss: Anschluss | null, ausgaenge: number): string | null {
  if (!anschluss) return 'Bitte geben Sie an, wie die Heizelemente angeschlossen sind.';
  if (ausgaenge > 1 && (anschluss === 'ohne_n' || anschluss === 'dreieck')) {
    return 'Ohne Neutralleiter oder im Dreieck darf der Shelly die Phasen nicht einzeln schalten (höchstens 240 V je Kontakt). Davor gehört ein dreipoliges Schütz.';
  }
  return null;
}

/** Eine erlaubte Stufe: so viele Ausgänge zugleich, höchstens so viele kW (die größten Elemente). */
export interface Stufe {
  ausgaenge: number;
  kw: number;
}

export function stufen(c: Ausgangsmenge): Stufe[] {
  if (ausgangsFehler(c as Ausgangsmenge & Record<string, unknown>) !== null) return [];
  const sortiert = [...c.output_kw].sort((a, b) => b - a);
  const liste = c.stages && c.stages.length > 0 ? c.stages : [c.channels.length];
  return liste.map((n) => ({
    ausgaenge: n,
    kw: Math.round(sortiert.slice(0, n).reduce((a, b) => a + b, 0) * 1000) / 1000,
  }));
}

/** „1 Phase“, „2 Phasen“, „aus“. */
export function stufeText(ausgaenge: number): string {
  if (ausgaenge <= 0) return 'aus';
  return ausgaenge === 1 ? '1 Phase' : `${ausgaenge} Phasen`;
}

/** kW deutsch, eine Stelle, mit geschütztem Leerzeichen. */
export function kwText(kw: number): string {
  return `${kw.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`;
}

/**
 * Die Verbindung eines Heizstabs: die Felder der Suche (ip, port) plus die Ausgangsmenge und der
 * Anschluss. Ein vorbelegter `channel` fällt weg - die Menge ersetzt ihn.
 */
export function heizstabVerbindung(
  basis: Record<string, unknown>,
  eingabe: { kanaele: number; kwJeElement: number; stufen: number[]; rotation: 'daily' | 'fixed'; anschluss: Anschluss },
): Record<string, unknown> {
  const { channel: _channel, communication: _communication, ...rest } = basis;
  const channels = Array.from({ length: eingabe.kanaele }, (_, k) => k);
  return {
    ...rest,
    channels,
    output_kw: channels.map(() => eingabe.kwJeElement),
    stages: [...new Set([...eingabe.stufen, eingabe.kanaele])].sort((a, b) => a - b),
    rotation: eingabe.rotation,
    anschluss: eingabe.anschluss,
  };
}

/** Was die Box für die Ausgänge meldet (Verbindungstest, contract op_result.ausgaenge). */
export interface TestAusgang {
  kanal: number;
  ein?: boolean | null;
  nach_stromausfall?: 'off' | 'on' | 'restore_last' | 'match_input' | null;
}

const NACH_STROMAUSFALL_TEXT: Record<string, string> = {
  off: 'aus',
  on: 'ein',
  restore_last: 'wie vorher',
  match_input: 'wie der Schalteingang',
};

/** Eine Zeile je Ausgang: „Ausgang 1 (L1): aus · nach Stromausfall: wie vorher“. */
export function testZeilen(ausgaenge: TestAusgang[] | null | undefined): { label: string; wert: string; warn: boolean }[] {
  return (ausgaenge ?? []).map((a) => {
    const zustand = a.ein === true ? 'ein' : a.ein === false ? 'aus' : 'nicht gelesen';
    const nach = a.nach_stromausfall ? NACH_STROMAUSFALL_TEXT[a.nach_stromausfall] : 'nicht gelesen';
    return {
      label: `Ausgang ${a.kanal + 1} (L${a.kanal + 1})`,
      wert: `${zustand} · nach Stromausfall: ${nach}`,
      warn: a.nach_stromausfall !== 'off' && a.nach_stromausfall != null,
    };
  });
}

/** Die eine Zeile über dem Test: antworten alle Ausgänge? Einzelheiten stehen unter „Mehr“. */
export function testKurz(ausgaenge: TestAusgang[] | null | undefined, kanaele: number): string {
  const gelesen = (ausgaenge ?? []).filter((a) => a.ein === true || a.ein === false).length;
  if (gelesen === 0) return 'Die Box hat den Shelly erreicht, die Ausgänge aber nicht gelesen.';
  if (gelesen < kanaele) return `Die Box hat ${gelesen} von ${kanaele} Ausgängen gelesen.`;
  return kanaele === 1 ? 'Die Box erreicht den Shelly und liest den Ausgang.' : `Die Box erreicht den Shelly und liest alle ${kanaele} Ausgänge.`;
}

/** Die Warnung, wenn ein Ausgang nach einem Stromausfall nicht aus bleibt (HZ-5); null = alles gut. */
export function nachStromausfallWarnung(ausgaenge: TestAusgang[] | null | undefined): string | null {
  const nichtAus = (ausgaenge ?? []).filter((a) => a.nach_stromausfall && a.nach_stromausfall !== 'off');
  if (nichtAus.length === 0) return null;
  return 'Nach einem Stromausfall bleibt der Heizstab so nicht aus: ohne die Box heizt er weiter, bis jemand '
    + 'ihn ausschaltet. Stellen Sie die Ausgänge auf „aus“.';
}

/** Die gemeldete Stufe (consumer-status.stufe). */
export interface StufeMeldung {
  commanded: number;
  commanded_kw?: number;
  confirmed?: number | null;
  confirmed_kw?: number | null;
  outputs_on?: number[];
  mismatch_since?: string | null;
  at?: string | null;
}

/** Der Befund des Reglers der Box (consumer-status.heizstab). */
export interface ReglerMeldung {
  stufe: number;
  ausgaenge?: number;
  kw?: number;
  code: string;
  grund?: string;
  verfuegbar_kw?: number | null;
  hoeher_ab?: string | null;
  seit?: string | null;
}

/** Der Kopfsatz: was BESTÄTIGT läuft. Unbekannt bleibt unbekannt, nie „aus“. */
export function zustandsSatz(s: StufeMeldung | null | undefined): string {
  if (!s) return 'Noch keine Rückmeldung der Box';
  if (s.confirmed === null || s.confirmed === undefined) return 'Stufe nicht bestätigt';
  if (s.confirmed === 0) return 'Aus';
  const kw = s.confirmed_kw != null ? ` · ${kwText(s.confirmed_kw)}` : '';
  return `Heizt mit ${stufeText(s.confirmed)}${kw}`;
}

/** Uhrzeit HH:MM in Europe/Berlin. */
function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
}

/**
 * Der Hinweis zu einer Abweichung (HZ-4 B): erst wenn ein Ausgang länger als 3 min gegen den Befehl
 * steht. Kürzer ist ein Schaltvorgang, kein Befund. Die Richtung entscheidet den Satz: heizt der Stab mit
 * MEHR als befohlen, lässt sich ein Ausgang nicht ausschalten - dann darf der Satz nie „nie mehr als
 * befohlen“ versprechen (die Box schaltet die übrigen Ausgänge ab, einen klemmenden nicht).
 */
export function abweichungHinweis(s: StufeMeldung | null | undefined, jetzt: Date): string | null {
  if (!s?.mismatch_since) return null;
  const seit = new Date(s.mismatch_since);
  if (Number.isNaN(seit.getTime()) || jetzt.getTime() - seit.getTime() < 3 * 60_000) return null;
  const frage = 'Klemmt ein Relais, oder hat jemand in der Shelly-App geschaltet?';
  const bestaetigt = s.confirmed ?? null;
  if (bestaetigt !== null && bestaetigt > s.commanded) {
    return `Seit ${uhr(s.mismatch_since)} heizt der Stab mit mehr als befohlen (${stufeText(bestaetigt)} statt `
      + `${stufeText(s.commanded)}): ein Ausgang lässt sich nicht ausschalten. ${frage}`;
  }
  if (bestaetigt !== null && bestaetigt < s.commanded) {
    return `Seit ${uhr(s.mismatch_since)} schaltet ein Ausgang nicht ein. Der Stab heizt mit ${stufeText(bestaetigt)} `
      + `statt ${stufeText(s.commanded)} weiter. ${frage}`;
  }
  return `Seit ${uhr(s.mismatch_since)} meldet ein Ausgang nicht, was VoltPilot befiehlt. ${frage}`;
}

/**
 * Ist der Anschluss offen? Dann schaltet VoltPilot den Stab nicht - weder der Regler noch „Jetzt heizen“
 * (Zwilling von `HeizstabGeraet.anschlussOffen`/`HeizstabAusgaenge.anschlussBestaetigt`).
 */
export function anschlussOffen(connection: Record<string, unknown> | null | undefined): boolean {
  return Array.isArray(connection?.channels) && connection?.anschluss !== 'stern_mit_n';
}

export const ANSCHLUSS_OFFEN_SATZ =
  'Der Anschluss der Heizelemente ist nicht bestätigt. Bis Ihr Elektriker ihn klärt, schaltet VoltPilot den '
  + 'Heizstab nicht - auch nicht von Hand.';

/** Der Grund des Reglers, mit dem frühesten Wechsel nach oben. */
export function reglerSatz(r: ReglerMeldung | null | undefined): string | null {
  if (!r) return null;
  const teile = [r.grund ?? null];
  if (r.hoeher_ab) teile.push(`Höhere Stufe frühestens ${uhr(r.hoeher_ab)}.`);
  return teile.filter(Boolean).join(' ') || null;
}

// ---------------------------------------------------------------------------
// Steuerung wie in Home Assistant (05.11.2026, Entscheide D1-A, D2-A, D3-A): Smart zuerst, darunter ein
// Schalter je Phase. Die Stellung eines Schalters ist, was der Shelly BESTÄTIGT hat; ein angefragter Wechsel
// sieht anders aus, ohne Rückmeldung steht „?“ - nie „aus“.
// ---------------------------------------------------------------------------

/** Die Fähigkeit der Box, genau die gewählten Phasen zu schalten (edge-supports.md). */
export const FAEHIGKEIT_PHASEN = 'heizstab_phasen';

/** Von Hand geschaltet kehrt der Stab nach zwei Stunden zu Smart zurück; jeder Tipp setzt die Frist neu (D1-A). */
export const HAND_MINUTEN = 120;

/**
 * Ob eine Box der Anlage einzelne Phasen schaltet: true/false, null = unbekannt (noch nicht geladen oder
 * kein Stand gemeldet) - dann bleibt die Stufenwahl, die jede Box kann.
 */
export function phasenFaehig(
  versionen: readonly { siteId: string; capabilities?: string[] | null; supports?: string[] | null }[] | null,
  siteId: string,
): boolean | null {
  if (!versionen) return null;
  const boxen = versionen.filter((v) => v.siteId === siteId);
  if (boxen.length === 0) return null;
  return boxen.some((v) => (v.capabilities ?? v.supports ?? []).includes(FAEHIGKEIT_PHASEN));
}

/** Ein laufender Handeingriff (start oder stop, nicht abgelaufen), sonst null. */
export function handEingriff<T extends { kind: string; endsAt: string }>(o: T | null | undefined, jetzt: Date): T | null {
  if (!o || (o.kind !== 'start' && o.kind !== 'stop')) return null;
  const ende = new Date(o.endsAt).getTime();
  return Number.isFinite(ende) && ende > jetzt.getTime() ? o : null;
}

/**
 * Was von Hand GEWÜNSCHT ist, als Kanäle: die gewählten Ausgänge eines Starts, [] bei „Aus“, null ohne
 * Handeingriff oder bei einem Start ohne Wahl (eine Stufe: welche Phasen, entscheidet die Box).
 */
export function handWunsch(
  o: { kind: string; endsAt: string; targetOutputs?: number[] | null } | null | undefined,
  jetzt: Date,
): number[] | null {
  const h = handEingriff(o, jetzt);
  if (!h) return null;
  if (h.kind === 'stop') return [];
  return h.targetOutputs && h.targetOutputs.length > 0 ? [...h.targetOutputs].sort((a, b) => a - b) : null;
}

/** Eine Zeile je Phase: bestätigt (an/aus/unbekannt) und, falls von Hand gewählt, der Wunsch. */
export interface PhasenZeile {
  label: string;
  kanal: number;
  kw: number | null;
  /** Bestätigt vom Shelly; null = keine Rückmeldung. */
  an: boolean | null;
  /** Von Hand gewünscht; null = kein Wunsch für diese Phase. */
  wunsch: boolean | null;
}

/** Die Phasen eines Stabs in der Reihenfolge seiner Ausgänge: L1 ist der erste Ausgang der Menge. */
export function phasenZeilen(
  connection: Record<string, unknown> | null | undefined,
  s: StufeMeldung | null | undefined,
  wunsch: number[] | null,
): PhasenZeile[] {
  const chs = Array.isArray(connection?.channels) ? (connection!.channels as number[]) : [];
  const kw = Array.isArray(connection?.output_kw) ? (connection!.output_kw as number[]) : [];
  const bekannt = s?.confirmed !== null && s?.confirmed !== undefined;
  const an = new Set(s?.outputs_on ?? []);
  return chs.map((ch, i) => ({
    label: `L${i + 1}`,
    kanal: ch,
    kw: typeof kw[i] === 'number' ? kw[i] : null,
    an: bekannt ? an.has(ch) : null,
    wunsch: wunsch === null ? null : wunsch.includes(ch),
  }));
}

/** Wie eine Phasen-Zeile aussieht: das Wort, der Zusatz darunter und die Stellung des Schalters. */
export function phasenAnsicht(z: PhasenZeile, s: StufeMeldung | null | undefined): {
  wort: string;
  unter: string | null;
  stellung: 'an' | 'aus' | 'warte-an' | 'warte-aus' | 'unbekannt';
} {
  if (z.wunsch !== null && z.wunsch !== z.an) {
    return z.wunsch
      ? { wort: 'schaltet ein …', unter: 'gesendet, noch nicht bestätigt', stellung: 'warte-an' }
      : { wort: 'schaltet aus …', unter: 'gesendet, noch nicht bestätigt', stellung: 'warte-aus' };
  }
  if (z.an === null) {
    const seit = s?.at ? `keine Rückmeldung seit ${uhr(s.at)}` : 'noch keine Rückmeldung der Box';
    return { wort: '?', unter: z.label === 'L1' ? seit : null, stellung: 'unbekannt' };
  }
  return { wort: z.an ? 'an' : 'aus', unter: null, stellung: z.an ? 'an' : 'aus' };
}

/** Die erlaubten Zahlen gleichzeitiger Ausgänge (`stages`, ohne Angabe nur alle zusammen). */
export function erlaubteStufen(connection: Record<string, unknown> | null | undefined): number[] {
  const n = Array.isArray(connection?.channels) ? (connection!.channels as unknown[]).length : 0;
  const st = Array.isArray(connection?.stages) ? (connection!.stages as number[]) : [];
  return st.length > 0 ? [...st].sort((a, b) => a - b) : n > 0 ? [n] : [];
}

/** Ein Stab, der nur alle Ausgänge zusammen schaltet (eine Stufe = alle): ein Schalter für den ganzen Stab. */
export function nurZusammen(connection: Record<string, unknown> | null | undefined): boolean {
  const n = Array.isArray(connection?.channels) ? (connection!.channels as unknown[]).length : 0;
  const st = erlaubteStufen(connection);
  return n <= 1 || (st.length === 1 && st[0] === n);
}

/** Was ein Tipp auf eine Phase bewirkt. */
export type PhasenTipp =
  | { art: 'start'; ausgaenge: number[] }
  | { art: 'stop' }
  | { art: 'fehler'; satz: string };

/**
 * Der Tipp auf eine Phase: ausgehend vom Wunsch (läuft ein Handeingriff) oder vom Bestätigten wechselt diese
 * eine Phase. Keine Phase mehr = „Aus“. Ist die neue Zahl keine erlaubte Stufe, sagt ein Satz warum - das
 * Portal schickt nichts, was die API (`HeizstabAusgaenge.phasenFehler`) ablehnen würde.
 */
export function phaseTippen(
  connection: Record<string, unknown> | null | undefined,
  zeilen: PhasenZeile[],
  kanal: number,
): PhasenTipp {
  const basis = zeilen.filter((z) => (z.wunsch ?? z.an) === true).map((z) => z.kanal);
  const neu = basis.includes(kanal) ? basis.filter((k) => k !== kanal) : [...basis, kanal];
  if (neu.length === 0) return { art: 'stop' };
  const erlaubt = erlaubteStufen(connection);
  if (!erlaubt.includes(neu.length)) {
    return {
      art: 'fehler',
      satz: `${stufeText(neu.length)} zugleich sind bei diesem Heizstab nicht erlaubt (erlaubt: ${erlaubt.join(', ')}).`,
    };
  }
  return { art: 'start', ausgaenge: [...neu].sort((a, b) => a - b) };
}

/** „Smart wieder ab 15:02“ - das Ende eines Handeingriffs, als Uhrzeit. */
export function smartWiederAb(endsAt: string): string {
  return `Smart wieder ab ${uhr(endsAt)}`;
}

/** Die Leistung je Phase als kurze Zeile: „2,0 kW je Phase“, bei ungleichen Elementen die Summe. */
export function leistungJePhase(zeilen: PhasenZeile[]): string | null {
  const kw = zeilen.map((z) => z.kw).filter((k): k is number => k !== null);
  if (kw.length === 0) return null;
  if (kw.every((k) => Math.abs(k - kw[0]) < 1e-9)) return `${kwText(kw[0])} je Phase`;
  return `${kwText(kw.reduce((a, b) => a + b, 0))} zusammen`;
}

/**
 * Der Smart-Block: an, ruht (pausiert oder von Hand übersteuert) oder nicht eingerichtet. Der Schalter
 * fehlt, wenn es kein Smart gibt, das ruhen könnte.
 */
export function smartZustand(
  aktivierung: 'not_activated' | 'active' | 'paused' | null | undefined,
  hand: { kind: string } | null,
): { titel: string; an: boolean; schalter: boolean; ruht: string | null } {
  if (hand) {
    return { titel: 'Smart ruht', an: false, schalter: true, ruht: 'Von Hand geschaltet' };
  }
  if (aktivierung === 'paused') {
    return { titel: 'Smart ruht', an: false, schalter: true, ruht: 'Der Stab bleibt aus, bis Smart wieder an ist.' };
  }
  if (aktivierung === 'active') return { titel: 'Smart', an: true, schalter: true, ruht: null };
  return { titel: 'Smart ist nicht eingerichtet', an: false, schalter: false, ruht: 'Unter „Einstellungen“ wählen, wann der Stab heizen soll.' };
}
