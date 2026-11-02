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
    text: 'Stern mit N - jedes Element zwischen einer Phase und dem Neutralleiter. Dann darf der Shelly jede Phase einzeln schalten.',
  },
  {
    wert: 'ohne_n',
    titel: 'Ohne Neutralleiter',
    text: 'Stern ohne N - dafür ist der Shelly nicht ausgelegt; davor gehört ein dreipoliges Schütz.',
  },
  {
    wert: 'dreieck',
    titel: 'Im Dreieck',
    text: 'Dafür ist der Shelly nicht ausgelegt; davor gehört ein dreipoliges Schütz.',
  },
  {
    wert: 'unbekannt',
    titel: 'Weiß ich nicht',
    text: 'Ihr Elektriker klärt das am Anschlusskasten. Bis dahin schaltet VoltPilot den Heizstab nicht.',
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

/** Je Phase: an, aus oder unbekannt (aus outputs_on; ohne bestätigte Stufe unbekannt). */
export function phasen(kanaele: number, s: StufeMeldung | null | undefined): { label: string; an: boolean | null }[] {
  const bekannt = s?.confirmed !== null && s?.confirmed !== undefined;
  const an = new Set(s?.outputs_on ?? []);
  return Array.from({ length: kanaele }, (_, k) => ({ label: `L${k + 1}`, an: bekannt ? an.has(k) : null }));
}

/** Uhrzeit HH:MM in Europe/Berlin. */
function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
}

/**
 * Der Hinweis zu einer Abweichung (HZ-4 B): erst wenn ein Ausgang länger als 3 min gegen den Befehl
 * steht. Kürzer ist ein Schaltvorgang, kein Befund.
 */
export function abweichungHinweis(s: StufeMeldung | null | undefined, jetzt: Date): string | null {
  if (!s?.mismatch_since) return null;
  const seit = new Date(s.mismatch_since);
  if (Number.isNaN(seit.getTime()) || jetzt.getTime() - seit.getTime() < 3 * 60_000) return null;
  return `Seit ${uhr(s.mismatch_since)} meldet ein Ausgang nicht, was VoltPilot befiehlt. Der Heizstab heizt mit der `
    + 'bestätigten Stufe weiter und nie mit mehr als befohlen. Klemmt ein Relais oder hat jemand in der Shelly-App '
    + 'geschaltet?';
}

/** Der Grund des Reglers, mit dem frühesten Wechsel nach oben. */
export function reglerSatz(r: ReglerMeldung | null | undefined): string | null {
  if (!r) return null;
  const teile = [r.grund ?? null];
  if (r.hoeher_ab) teile.push(`Höhere Stufe frühestens ${uhr(r.hoeher_ab)}.`);
  return teile.filter(Boolean).join(' ') || null;
}

/** Dauern für „Jetzt heizen“ (30 min bis 4 h, Handeingriff ≤ 4 h). */
export const HEIZ_DAUERN: { minuten: number; text: string }[] = [
  { minuten: 30, text: '30 Minuten' },
  { minuten: 60, text: '1 Stunde' },
  { minuten: 120, text: '2 Stunden' },
  { minuten: 240, text: '4 Stunden' },
];

/** „Höchstens ≈ 4,0 kWh“ - die Obergrenze, nie eine Zusage (das Thermostat kann früher abschalten). */
export function hoechstensKwh(kw: number, minuten: number): string {
  const kwh = Math.round(((kw * minuten) / 60) * 10) / 10;
  return `Höchstens ≈ ${kwh.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`;
}
