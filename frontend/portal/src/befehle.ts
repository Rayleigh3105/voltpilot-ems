// Die REINE Ableitung der Befehle-Seite (Kommando-Transparenz V1, Konzept
// `vp-kommando-transparenz-k3` §2 + §6.3): aus dem Server-Verlauf werden die
// deutschen Sätze des Tages-Films, seine Töne und der Roh-Blick.
//
// Sie ENTSCHEIDET nichts: die Zustandswörter kommen aus dem Speicher, die
// Live-Zeile aus `control.ts`, das Wächter-Panel aus `curtailment.ts`. Hier
// entstehen ausschließlich SÄTZE - das RolloutStates-Konsumenten-Muster.
//
// **Die drei Wahrheiten bleiben getrennt** (§1): BEFOHLEN (was VoltPilot
// wollte), GESCHRIEBEN & BESTÄTIGT (das Rücklese-Urteil) und WIRKUNG (die
// Messreihe daneben). Diese Datei formuliert die ersten beiden und behauptet
// die dritte nie.
//
// **Vier Ehrlichkeitsregeln tragen jede Funktion hier:**
//  1. Ein Wort außerhalb des Vokabulars erzeugt KEINE Behauptung - im Zweifel
//     bleibt der Satz beobachtend (die Ingest-Regel des Hauses, eine Ebene
//     höher angewandt).
//  2. `keine_antwort` ist NIE `abweichend`. Schweigen ist bernstein, nie rot
//     (die PR-280-Lehre).
//  3. Was nicht gemessen ist, wird nicht gesagt - nie eine erfundene 0, und
//     V1 behauptet keine Schreibzyklen.
//  4. Vor `recordingSince` wird NICHTS behauptet, auch nichts Entlastendes.
import type { CommandEntry, CommandHistory } from './api';
import { batteryDirection, CONTROL_DEADBAND_KW } from './control';
import { fmtNum } from './format';

/** Der Ton einer Zeile - er steuert Farbe UND das Wort daneben. */
export type BefehlTon = 'ok' | 'warn' | 'info' | 'ruhig';

/** Eine Zeile des Tages-Films. */
export interface BefehlZeile {
  id: number;
  art: 'periode' | 'ereignis';
  /** „06:10–09:30" bzw. „17:55" - immer Ortszeit des Lesers. */
  zeit: string;
  /** Der Satz, den der Kunde liest. */
  satz: string;
  /** Das Rücklese-Urteil als WORT, oder null (nie nur eine Farbe). */
  urteil: string | null;
  ton: BefehlTon;
  /** Läuft diese Periode gerade noch? */
  laufend: boolean;
  /** Der Roh-Blick (F1: für ALLE Kunden aufklappbar), ggf. leer. */
  roh: RohZeile[];
  /** Woher die Zeile stammt - sie steht AN jeder Zeile. */
  herkunft: string;
  /**
   * Welcher Schreibweg - in Kundendeutsch, oder null bei einem Wort, das
   * dieser Portal-Stand nicht kennt (nie ein geratenes Etikett).
   */
  strom: string | null;
}

/** Eine Zeile des Roh-Blicks: Bezeichnung + Wert, mehr behauptet V1 nicht. */
export interface RohZeile {
  label: string;
  wert: string;
}

/** Die Ströme in Kundendeutsch. Ein unbekannter bleibt ohne Behauptung. */
const STROM: Record<string, string> = {
  batterie: 'Speicher',
  abregelung: 'Einspeise-Begrenzung',
  verbraucher: 'Gerät',
  waechter: 'Einspeisewächter',
};

/**
 * Das Rücklese-Vokabular in der `readback-verify`-Semantik. ⚠ Die zwei
 * Nicht-Bestätigungen sind bewusst VERSCHIEDEN: „keine Antwort" ist eine
 * Lücke (bernstein), „abweichend" ist ein belegter Widerspruch. Sie gleich zu
 * färben wäre genau die Verwechslung, die PR 280 einmal gekostet hat.
 */
const URTEIL: Record<string, { wort: string; ton: BefehlTon }> = {
  bestaetigt: { wort: 'vom Gerät bestätigt', ton: 'ok' },
  abweichend: { wort: 'das Gerät meldet etwas anderes', ton: 'warn' },
  keine_antwort: { wort: 'keine Antwort vom Gerät', ton: 'info' },
  prueft: { wort: 'wird gerade geprüft', ton: 'info' },
  unbestaetigt: { wort: 'noch nicht bestätigt', ton: 'info' },
};

/** Die Punkt-Ereignisse. Ein unbekanntes erzeugt gar keine Zeile. */
const EREIGNIS: Record<string, { satz: string; ton: BefehlTon }> = {
  notaus_ein: {
    satz: 'Not-Aus aktiv: VoltPilot schreibt an kein Gerät. Das Rücklesen läuft weiter.',
    ton: 'warn',
  },
  notaus_aus: { satz: 'Not-Aus aufgehoben: VoltPilot darf wieder schreiben.', ton: 'ok' },
  freigabe_erteilt: { satz: 'Steuerung freigegeben.', ton: 'ok' },
  freigabe_widerrufen: {
    satz: 'Freigabe zurückgenommen - VoltPilot steuert dieses Gerät nicht mehr.',
    ton: 'warn',
  },
  luecke: {
    satz: 'Keine Rückmeldung von Ihrem Gerät - für diese Zeit liegt uns nichts vor.',
    ton: 'info',
  },
  verlauf_gedeckelt: {
    satz: 'Ab hier wurde für heute nicht weiter protokolliert (ungewöhnlich viele Wechsel).',
    ton: 'info',
  },
};

/** Was den Sollwert getrieben hat. Ein unbekannter Modus bleibt ungenannt. */
const MODUS: Record<string, string> = {
  plan: 'Fahrplan',
  follow: 'nachgeführt nach dem gemessenen Verbrauch',
  trim: 'begrenzt auf den gemessenen Solarüberschuss',
  absorb: 'angehoben auf den gemessenen Solarüberschuss',
  fallback: 'Eigenverbrauchs-Sicherung',
};

/** Die Rollen-Namen des Roh-Blicks. Unbekanntes bleibt der Rohname. */
const ROLLE: Record<string, string> = {
  battery_power: 'Sollwert',
  remote_mode: 'Fernsteuerung',
  remote_watchdog: 'Schutzschalter',
  power_control_mode: 'Steuerseite',
  battery_strategy: 'Strategie',
  pv_limit_pct: 'Einspeise-Begrenzung',
  pv_limit_enable: 'Begrenzung aktiv',
  pv_limit_revert_tms: 'Rückfall-Zeit',
};

/** Woher eine Zeile stammt - die Herkunft steht AN der Zeile (§9 Regel 3). */
const HERKUNFT: Record<string, string> = {
  cloud_abgeleitet: 'aus dem Gerätestatus abgeleitet',
  geraet: 'vom Gerät gemeldet',
};

/**
 * Die Beschriftung der zwei Einstiege (Komponenten-Karte + Steuerung). Sie
 * steht hier, damit die zwei Flächen nie verschieden heissen.
 */
export const BEFEHLE_LABEL = 'Befehle an dieses Gerät';

/**
 * Der Satz, der eine NICHT gesteuerte Komponente beantwortet (Captain-Entscheid
 * F4). Er IST die Herzogau-Antwort und kostet fast nichts.
 */
export const NUR_LESEN =
  'VoltPilot sendet an dieses Gerät keine Befehle. Es wird nur gelesen.';

/**
 * Die Fußnote der Ehrlichkeit (§2.2 Punkt 5). Sie sagt, was aufbewahrt wird,
 * wie genau der Verlauf ist und was V1 ausdrücklich NICHT weiß.
 */
export function fussnote(accuracySeconds: number): string[] {
  return [
    'Der Verlauf wird 90 Tage aufbewahrt, danach gelöscht.',
    `Ihr Gerät prüft laufend, ob der Befehl gehalten wird; aufgezeichnet wird das im `
      + `${accuracySeconds}-Sekunden-Raster - ein Wechsel und zurück dazwischen bleibt unsichtbar.`,
    'Wie oft geschrieben wurde, zählen wir noch nicht mit - das kommt mit einem '
      + 'späteren Geräte-Update.',
  ];
}

/**
 * „Aufzeichnung seit <Datum>" - oder der ehrliche Satz, dass noch gar nicht
 * hingesehen wurde. **Vor diesem Datum wird NICHTS behauptet, auch nichts
 * Entlastendes** (§4.3).
 */
export function aufzeichnungSeit(recordingSince: string | null): string {
  if (!recordingSince) {
    return 'Für diese Anlage wird noch nicht aufgezeichnet.';
  }
  return `Aufzeichnung seit ${new Date(recordingSince).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })}`;
}

/**
 * Der Kopfsatz: welche Komponente, über welches Gerät, auf welchem Weg. Was
 * nicht bekannt ist, wird weggelassen - nie ein geratenes Gerät.
 */
export function kopfSatz(input: {
  komponente: string | null;
  geraet: string | null;
  pfad: string | null;
}): string {
  const teile: string[] = [];
  teile.push(input.komponente ?? 'Diese Anlage');
  if (input.geraet) {
    teile.push(`gesteuert über ${input.geraet}`);
  }
  const pfad = pfadWort(input.pfad);
  if (pfad) {
    teile.push(pfad);
  }
  return `${teile.join(' · ')}.`;
}

/** Der Schreibweg als Etikett; ein unbekannter bleibt ungenannt. */
export function stromLabel(stream: string): string | null {
  return STROM[stream] ?? null;
}

/** Der Schreibweg in Kundendeutsch; ein unbekannter bleibt ungenannt. */
export function pfadWort(pfad: string | null | undefined): string | null {
  if (pfad === 'remote') return 'Fernsteuer-Register';
  if (pfad === 'tou') return 'Zeitprogramm des Wechselrichters';
  return null;
}

/**
 * Der Tages-Film: aus den Server-Zeilen werden Sätze, ÄLTESTE zuerst (die
 * Reihenfolge kommt schon so an). Eine Zeile, deren Vokabular dieser
 * Portal-Stand nicht kennt, wird ÜBERSPRUNGEN statt geraten.
 */
export function film(history: CommandHistory | null, now: number): BefehlZeile[] {
  if (!history) return [];
  const out: BefehlZeile[] = [];
  for (const e of history.entries) {
    const zeile = e.kind === 'ereignis' ? ereignisZeile(e) : periodenZeile(e, now);
    if (zeile) out.push(zeile);
  }
  return out;
}

function ereignisZeile(e: CommandEntry): BefehlZeile | null {
  const wort = e.eventKind == null ? null : EREIGNIS[e.eventKind];
  if (!wort) return null; // nie ein geratenes Ereignis
  return {
    id: e.id,
    art: 'ereignis',
    zeit: spanne(e.startedAt, e.endedAt, false),
    satz: wort.satz,
    urteil: null,
    ton: wort.ton,
    laufend: false,
    roh: [],
    herkunft: HERKUNFT[e.source] ?? '',
    strom: stromLabel(e.stream),
  };
}

function periodenZeile(e: CommandEntry, now: number): BefehlZeile {
  const laufend = e.endedAt == null;
  const urteil = e.verdict == null ? null : URTEIL[e.verdict] ?? null;
  return {
    id: e.id,
    art: 'periode',
    zeit: spanne(e.startedAt, e.endedAt, laufend),
    satz: periodenSatz(e),
    urteil: urteil?.wort ?? null,
    ton: periodenTon(e, urteil?.ton ?? null),
    laufend: laufend && Date.parse(e.startedAt) <= now,
    roh: rohBlick(e),
    herkunft: HERKUNFT[e.source] ?? '',
    strom: stromLabel(e.stream),
  };
}

/**
 * Der Ton einer Periode: ein Fremdeinfluss ist die schärfere Aussage als das
 * Urteil (das Register kann halten, während etwas anderes mitregelt - die
 * Klemm-Plateau-Lektion), ein Not-Aus färbt nicht rot (er ist ein ZUSTAND),
 * und ohne Urteil bleibt die Zeile ruhig.
 */
function periodenTon(e: CommandEntry, urteilTon: BefehlTon | null): BefehlTon {
  if (e.foreignInfluence) return 'warn';
  return urteilTon ?? 'ruhig';
}

/**
 * Der Satz einer Halteperiode. Er nennt, was BEFOHLEN wurde, und - wo der Server
 * es aufgezeichnet hat - warum. Er behauptet NIE eine Wirkung.
 */
export function periodenSatz(e: CommandEntry): string {
  const teile: string[] = [];
  teile.push(handlung(e));
  const grund = grundSatz(e);
  if (grund) teile.push(grund);
  if (e.controlEnabled === false) {
    teile.push('Not-Aus aktiv - es wurde nichts geschrieben');
  } else if (e.released === false && e.stream === 'batterie') {
    teile.push('für dieses Gerät noch nicht freigegeben');
  }
  if (e.foreignInfluence) {
    teile.push('möglicherweise regelt ein anderes System mit');
  }
  return `${teile.join(' — ')}.`;
}

/** Was in dieser Periode gefahren wurde - je Strom eine eigene Sprache. */
function handlung(e: CommandEntry): string {
  if (e.stream === 'abregelung') {
    if (e.mode === 'abregeln') {
      const kw = spanneKw(e);
      return kw
        ? `Einspeisung begrenzt auf ${kw}`
        : 'Einspeisung begrenzt';
    }
    return 'Keine Einspeise-Begrenzung';
  }
  if (e.stream === 'verbraucher') {
    // Der Verbraucher-Strom trägt NUR die Bestätigungs-Dimension: was das
    // Gerät TAT, steht im Regel-Protokoll und wird hier nicht zweimal gesagt.
    return 'VoltPilot hat dieses Gerät gesteuert';
  }
  const dir = batteryDirection(e.commandedKwLast ?? e.commandedKwFirst);
  if (dir === 'pausieren') return 'Speicher angehalten (Sollwert 0,0 kW)';
  const kw = spanneKw(e);
  const wort = dir === 'laden' ? 'Laden' : 'Entladen';
  return kw ? `${wort} mit ${kw}` : wort;
}

/**
 * Die Spanne der befohlenen Leistung. Nie ein Vorzeichen für den Kunden (die
 * `live.ts`-Konvention) und nie eine erfundene 0.
 */
function spanneKw(e: CommandEntry): string | null {
  const werte = [e.commandedKwMin, e.commandedKwMax]
    .filter((v): v is number => v != null && Number.isFinite(v))
    .map((v) => Math.abs(v));
  if (werte.length === 0) return null;
  const min = Math.min(...werte);
  const max = Math.max(...werte);
  if (max - min <= CONTROL_DEADBAND_KW) {
    return fmtNum(max, 'kW');
  }
  return `${fmtNum(min, '')}–${fmtNum(max, 'kW')}`;
}

/** Das WARUM, so weit der Server es aufgezeichnet hat - sonst gar nichts. */
function grundSatz(e: CommandEntry): string | null {
  if (e.whyKind === 'sicherung') {
    return 'Eigenverbrauchs-Sicherung (kein aktueller Fahrplan)';
  }
  const modus = e.mode == null ? null : MODUS[e.mode];
  if (e.whyKind === 'fahrplan') {
    return modus && e.mode !== 'plan' ? `Fahrplan, ${modus}` : 'Fahrplan';
  }
  return modus ?? null;
}

/**
 * Der Roh-Blick (§2.4, Captain-Entscheid F1: für ALLE Kunden aufklappbar).
 * V1 zeigt Rollen, kW und den Pfad - Register und Adressen folgen mit dem
 * Präzisions-Uplink; sie hier zu erfinden wäre das Gegenteil des Zwecks.
 */
export function rohBlick(e: CommandEntry): RohZeile[] {
  const out: RohZeile[] = [];
  const pfad = pfadWort(e.path);
  if (pfad) out.push({ label: 'Schreibweg', wert: pfad });
  if (e.commandedKwFirst != null) {
    out.push({ label: 'Befohlen (zuerst)', wert: fmtNum(e.commandedKwFirst, 'kW') });
  }
  if (e.commandedKwLast != null) {
    out.push({ label: 'Befohlen (zuletzt)', wert: fmtNum(e.commandedKwLast, 'kW') });
  }
  const d = e.detail;
  if (d?.mismatchRoles) {
    const rollen = d.mismatchRoles.split(',').map((r) => ROLLE[r.trim()] ?? r.trim());
    out.push({ label: 'Weicht ab', wert: rollen.join(', ') });
  }
  if (d?.units != null) {
    out.push({
      label: 'Wechselrichter',
      wert: `${d.certifiedUnits ?? 0} von ${d.units} freigegeben`,
    });
  }
  // Die Zyklen-Zähler sind in V1 IMMER leer - das SAGT die Zeile, statt zu
  // schweigen: sonst läse sich ihr Fehlen wie „es wurde nichts geschrieben".
  if (e.kind === 'periode') {
    out.push({ label: 'Schreibzyklen', wert: zyklenWort(e) });
  }
  return out;
}

/** „—" mit Grund, nie eine erfundene Zahl (§9 Regel 3). */
export function zyklenWort(e: CommandEntry): string {
  return e.cycles == null ? '— (zählen wir noch nicht mit)' : String(e.cycles);
}

/** „06:10–09:30", „ab 18:30" (laufend) oder „17:55" (Punkt-Ereignis). */
export function spanne(startedAt: string, endedAt: string | null, laufend: boolean): string {
  const von = uhr(startedAt);
  if (laufend) return `ab ${von}`;
  if (!endedAt) return von;
  const bis = uhr(endedAt);
  return bis === von ? von : `${von}–${bis}`;
}

function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Die Zeile über dem Film, wenn nichts aufgezeichnet ist. Sie unterscheidet
 * die zwei Fälle, die man nie verwechseln darf: „wir haben noch nicht
 * hingesehen" und „wir haben hingesehen und es gab nichts".
 */
export function leerSatz(history: CommandHistory | null, gefiltert: boolean): string {
  if (!history || !history.recordingSince) {
    return 'Für diesen Zeitraum liegt uns nichts vor - die Aufzeichnung hat noch nicht begonnen.';
  }
  if (!history.writes && gefiltert) {
    return NUR_LESEN;
  }
  return 'In diesem Zeitraum wurde an dieses Gerät kein Befehl geschickt.';
}

/** Der Hinweis, wenn der Deckel gegriffen hat - nie ein stilles Kappen. */
export function deckelSatz(history: CommandHistory | null): string | null {
  return history?.truncated
    ? 'Es sind sehr viele Einträge - ältere sind hier nicht mehr aufgeführt.'
    : null;
}
