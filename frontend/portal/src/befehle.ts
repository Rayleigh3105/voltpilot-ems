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
import { journalSatz, journalTon } from './registerWrite';
import { batteryDirection, CONTROL_DEADBAND_KW } from './control';
import { fmtNum } from './format';

/**
 * Die Plattform-Zeitzone. Sie ist HIER festgenagelt, weil der Server sein
 * Fenster in genau dieser Zone aufspannt ({@code HistoryRange.ZONE}): würde die
 * Fläche in der Browser-Zone rendern, begänne der „Heute"-Tab eines Lesers
 * ausserhalb der DACH-Zone sichtbar nicht um 00:00 - dieselbe Regel wie in
 * `anlage.ts`/`fleet.ts`/`strompreis.ts`.
 */
const ZONE = 'Europe/Berlin';

/**
 * Der Berliner Kalendertag eines Zeitpunkts („2026-08-19"), oder null.
 *
 * ⚠ Exportiert, seit der VERLAUF (Geräteseiten Stufe 2) seine Datumszeilen
 * daraus bildet: die Zone ist HIER festgenagelt, und ein zweiter Tages-Begriff
 * daneben wäre genau die zweite Wahrheit, gegen die dieser Kopf gebaut ist.
 */
export function berlinTag(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: ZONE });
}

/** Der Ton einer Zeile - er steuert Farbe UND das Wort daneben. */
export type BefehlTon = 'ok' | 'warn' | 'info' | 'ruhig';

/** Eine Zeile des Tages-Films. */
export interface BefehlZeile {
  id: number;
  /**
   * Der Berliner Kalendertag des BEGINNS („2026-08-19"), oder null.
   *
   * ⚠ Er trägt die Datumszeile des Verlaufs (Stufe 2) - gruppiert wird nach dem
   * BEGINN, weil das Ende einer über Mitternacht laufenden Periode per
   * Konstruktion im Fenster liegt und ein zweites Datum Rauschen wäre (dieselbe
   * Begründung wie in {@link spanne}).
   */
  tag: string | null;
  art: 'periode' | 'ereignis';
  /**
   * „06:10–09:30" bzw. „17:55" - IMMER Europe/Berlin, die Zone, in der der
   * Server sein Fenster aufspannt; eine Zeile, die vor dem Fenster begann,
   * trägt zusätzlich ihr Datum („18.08. 22:00–06:00").
   */
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
  ladepunkt: 'OCPP-Ladeprofil',
  waechter: 'Einspeisewächter',
  register: 'Register',
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
  // P3a: „Jetzt voll laden" schreibt seinen Beleg seit je in den
  // Ladepunkt-Strom (`ChargingBoostService.record`) - gerendert hat ihn bis
  // hierher niemand, ein unbekanntes Wort erzeugt gar keine Zeile.
  voll_laden_erteilt: {
    satz: 'Jetzt voll laden: dieser Ladevorgang bekommt volle Leistung - auch aus dem Netz.',
    ton: 'info',
  },
  voll_laden_zurueckgenommen: {
    satz: 'Jetzt voll laden beendet - für diesen Ladevorgang gilt wieder Ihre Priorität.',
    ton: 'ok',
  },
  // P3b: die zweite Richtung desselben Eingriffs (Entscheid E5). Sie hat eigene
  // Wörter, weil „Jetzt voll laden beendet" über einer Pause eine Falschaussage
  // wäre - der Verlauf muss sagen, was wirklich geschah.
  laden_pausiert: {
    satz: 'Laden pausiert: dieser Ladevorgang wurde angehalten - alle anderen laden weiter.',
    ton: 'info',
  },
  laden_pausiert_beendet: {
    satz: 'Pause beendet - dieser Ladevorgang lädt wieder nach Ihrer Priorität.',
    ton: 'ok',
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
  limit: 'begrenzt auf den gemessenen Verbrauch',
  trim: 'begrenzt auf den gemessenen Solarüberschuss',
  absorb: 'angehoben auf den gemessenen Solarüberschuss',
  fallback: 'Eigenverbrauchs-Sicherung',
  idle_follow: 'unerwarteter Verbrauch live aus dem Speicher gedeckt',
  deficit_cover: 'Verbrauch live aus dem Speicher gedeckt statt eingekauft',
  surplus_store: 'gemessener Solarüberschuss eingespeichert statt eingespeist',
  high_soc_follow: 'fast voller Speicher deckt den Verbrauch live',
  high_soc_charge: 'fast voller Speicher lädt den Solarüberschuss nach',
  // Wechselrichter-Eigenregelung: die Box schreibt KEINEN Leistungswert, der
  // Wechselrichter entscheidet die Watt selbst - der Satz nennt nur die Absicht.
  autonomous_discharge: 'Automatik: Verbrauch aus dem Speicher decken',
  autonomous_charge: 'Automatik: nur Solarüberschuss laden',
  autonomous_selfconsumption: 'Automatik: Eigenverbrauch',
};

/**
 * Die Modi, in denen der WECHSELRICHTER die Batterie-Leistung selbst regelt.
 * Die Box schreibt dort keinen Sollwert, `commanded_kw` ist null - eine
 * kW-Zahl wäre erfunden (null ist kein 0 kW).
 */
const WR_AUTOMATIK = new Set(['autonomous_discharge', 'autonomous_charge', 'autonomous_selfconsumption']);

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
  portal: 'über das Portal ausgelöst',
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
    genauigkeitsSatz(accuracySeconds),
    'Wie oft geschrieben wurde, zählen wir noch nicht mit - das kommt mit einem '
      + 'späteren Geräte-Update.',
  ];
}

/**
 * Die GENAUIGKEIT in einem Satz - er steht auf der Befehle-Seite in der Fußnote
 * und auf der Geräteseite direkt unter dem Ausschnitt. **Eine Quelle**, damit
 * die zwei Flächen nie verschiedene Raster behaupten.
 */
export function genauigkeitsSatz(accuracySeconds: number): string {
  return `Ihr Gerät prüft laufend, ob der Befehl gehalten wird; aufgezeichnet wird das im `
    + `${accuracySeconds}-Sekunden-Raster - ein Wechsel und zurück dazwischen bleibt unsichtbar.`;
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
    timeZone: ZONE,
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

/**
 * Der Kopfsatz der GERÄTE-Sicht (Anlagen-Zentrale Stufe 1, §7.4). Er nennt das
 * Gerät und - nur bei einem Gerät hinter der Box - dass hier ausschliesslich
 * SEINE Befehle stehen.
 *
 * ⚠ Der Unterschied zwischen Box und Gerät ist eine AUSSAGE: die Box ist das
 * TOR - sie ÜBERBRINGT, was für die ganze Anlage gilt (allen voran die
 * Abregelung, die EIN Rücklesen über ALLE Einheiten zurückliest) -, ein Gerät
 * dahinter trägt die Befehle, die es AUSFÜHRT. Wer das gleich formuliert,
 * behauptet an einem von drei Wechselrichtern eine Abregelung, die der ganzen
 * Anlage gilt.
 *
 * ⚠ Seit der Ziel-Attribution (Konzept `vp-geraeteseite-rev-b8` §5) sagt der
 * Box-Satz ausdrücklich NICHT mehr „alle Befehle dieser Anlage": ein Befehl mit
 * Komponente steht seither auf der Seite des Geräts, das ihn ausführt. Die
 * ganze Anlage auf einmal zeigt weiterhin die Befehle-Seite ohne Filter.
 */
export function geraetKopfSatz(input: {
  geraet: string | null;
  box: boolean;
  pfad: string | null;
}): string {
  const name = input.geraet ?? 'Dieses Gerät';
  if (input.box) {
    return `${name} · die anlagenweiten Befehle, die Ihre Box überbringt.`;
  }
  const pfad = pfadWort(input.pfad);
  return pfad ? `${name} · ${pfad}.` : `${name} · nur die Befehle an dieses Gerät.`;
}

/**
 * Der Verweis, der die Grenze ERKLÄRT, statt sie nur zu ziehen: die
 * anlagenweiten Befehle (allen voran die Abregelung, die EIN Rücklesen über
 * ALLE Einheiten zurückliest) stehen auf der Seite der Box.
 */
export const ANLAGENWEITE_BEFEHLE =
  'Anlagenweite Befehle - zum Beispiel die Abregelung - stehen auf der Seite Ihrer VoltPilot-Box.';

/**
 * Die GEGENRICHTUNG desselben Satzes, auf der Box (Ziel-Attribution, Konzept
 * `vp-geraeteseite-rev-b8` §4.1/§5): sie ist der Überbringer, ausgeführt wird
 * ein Befehl vom GERÄT - und dort steht er seither auch.
 *
 * Ohne diesen Satz läse sich die kürzere Box-Liste als Verlust; mit ihm ist sie
 * ein Wegweiser. Die Geräte stehen direkt darüber in der Liste „Geräte an
 * dieser Box".
 */
export const GERAETE_BEFEHLE =
  'Befehle an ein einzelnes Gerät - zum Beispiel der Speicher-Sollwert - stehen auf der '
  + 'Seite dieses Geräts.';

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
export function film(
  history: CommandHistory | null,
  now: number,
  opts: { datiert?: boolean } = {},
): BefehlZeile[] {
  if (!history) return [];
  // Der ERSTE Tag des Fensters. Er ist der Bezug, gegen den eine Zeile
  // entscheidet, ob sie ihr Datum mitnennen muss - ohne ihn läse sich eine
  // Zeile, die vor dem Fenster begann, als hätte sie HEUTE um 23:45 begonnen
  // (der 19.08.2026 gemeldete Fall).
  //
  // ⚠ `datiert: false` schaltet genau das AB - und zwar nur dort, wo eine
  // andere Fläche das Datum schon trägt: der VERLAUF (Stufe 2) gruppiert nach
  // Tagen und schreibt es in seine Datumszeile. Beides zugleich wäre dieselbe
  // Auskunft zweimal in einer Zeile („18.08. 22:00" unter der Überschrift
  // „Dienstag, 18. August 2026"). Ohne diese Angabe bleibt es beim datierten
  // Verhalten - eine Fläche verliert das Datum nie versehentlich.
  const fensterTag = opts.datiert === false ? null : berlinTag(history.from);
  const out: BefehlZeile[] = [];
  for (const e of history.entries) {
    const zeile = e.stream === 'register'
      ? registerZeile(e, fensterTag)
      : e.kind === 'ereignis' ? ereignisZeile(e, fensterTag) : periodenZeile(e, now, fensterTag);
    if (zeile) out.push(zeile);
  }
  return out;
}

/**
 * Der VIERTE Strom `register`: ein Einmal-Schreibvorgang auf einem Geräte-Register
 * (Konzept `vp-reg-schreib-konzept-p8` §2.5).
 *
 * ⚠ Der Satz kommt aus `registerWrite.journalSatz` - DERSELBE, den der
 * Register-Drawer in seinem Verlauf zeigt. Zwei Formulierungen über denselben
 * Vorgang wären zwei Wahrheiten, und der Beleg ist genau das, was diese Zeile
 * beweisen soll.
 *
 * OHNE den `register`-Block gibt es KEINE Zeile: ein Strom-Wort, dessen Inhalt
 * dieser Portal-Stand nicht kennt, behauptet nichts (die
 * Unbekannt-bleibt-ohne-Behauptung-Regel).
 */
function registerZeile(e: CommandEntry, fensterTag: string | null): BefehlZeile | null {
  const r = e.register;
  if (!r) return null;
  return {
    id: e.id,
    tag: berlinTag(e.startedAt),
    art: 'ereignis',
    zeit: spanne(e.startedAt, e.endedAt, false, fensterTag),
    satz: journalSatz(r),
    urteil: null,
    ton: journalTon(r),
    laufend: false,
    roh: registerRoh(r),
    herkunft: HERKUNFT[e.source] ?? '',
    strom: stromLabel(e.stream),
  };
}

/** Der Roh-Blick eines Register-Vorgangs - die getippten Begriffe VERBATIM. */
function registerRoh(r: NonNullable<CommandEntry['register']>): RohZeile[] {
  const out: RohZeile[] = [];
  if (r.addressInput) out.push({ label: 'Eingetippte Adresse', wert: r.addressInput });
  if (r.valueInput) out.push({ label: 'Eingetippter Wert', wert: r.valueInput });
  if (r.scaleNote) out.push({ label: 'Umrechnung', wert: r.scaleNote });
  if (r.beforeRaw != null) out.push({ label: 'Vorher (roh)', wert: String(r.beforeRaw) });
  if (r.afterRaw != null) out.push({ label: 'Zurückgelesen (roh)', wert: String(r.afterRaw) });
  if (r.note) out.push({ label: 'Grund', wert: r.note });
  if (r.targetLabel) out.push({ label: 'Ziel', wert: r.targetLabel });
  return out;
}

function ereignisZeile(e: CommandEntry, fensterTag: string | null): BefehlZeile | null {
  const wort = e.eventKind == null ? null : EREIGNIS[e.eventKind];
  if (!wort) return null; // nie ein geratenes Ereignis
  return {
    id: e.id,
    tag: berlinTag(e.startedAt),
    art: 'ereignis',
    zeit: spanne(e.startedAt, e.endedAt, false, fensterTag),
    satz: wort.satz,
    urteil: null,
    ton: wort.ton,
    laufend: false,
    roh: [],
    herkunft: HERKUNFT[e.source] ?? '',
    strom: stromLabel(e.stream),
  };
}

function periodenZeile(e: CommandEntry, now: number, fensterTag: string | null): BefehlZeile {
  const laufend = e.endedAt == null;
  const urteil = e.verdict == null ? null : URTEIL[e.verdict] ?? null;
  return {
    id: e.id,
    tag: berlinTag(e.startedAt),
    art: 'periode',
    zeit: spanne(e.startedAt, e.endedAt, laufend, fensterTag),
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
  if (e.stream === 'ladepunkt') {
    // Der Ladepunkt-Strom nennt die GRENZE, die die Box der Säule hinterlegt
    // hat - nie eine Wirkung. Was das Fahrzeug daraus gemacht hat, steht auf
    // der Ladevorgangs-Liste.
    const kw = spanneKw(e);
    if (e.mode === 'laedt') {
      return kw ? `Ladelimit ${kw}` : 'Ladefreigabe erteilt';
    }
    return kw ? `Ladelimit ${kw} - kein Fahrzeug angesteckt` : 'Kein Ladevorgang';
  }
  if (e.stream === 'verbraucher') {
    // Der Verbraucher-Strom trägt NUR die Bestätigungs-Dimension: was das
    // Gerät TAT, steht im Regel-Protokoll und wird hier nicht zweimal gesagt.
    return 'VoltPilot hat dieses Gerät gesteuert';
  }
  if (e.mode != null && WR_AUTOMATIK.has(e.mode)) {
    return 'Vom Wechselrichter selbst geregelt (ohne Leistungs-Sollwert von VoltPilot)';
  }
  const letzter = e.commandedKwLast ?? e.commandedKwFirst;
  // Kein gemeldeter Wert ist kein Stillstand - nie eine erfundene 0.
  if (letzter == null) return 'Speicher-Sollwert nicht gemeldet';
  const dir = batteryDirection(letzter);
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
    out.push({ label: 'Befohlen (zuerst)', wert: rohWert(e.commandedKwFirst, e.stream) });
  }
  if (e.commandedKwLast != null) {
    out.push({ label: 'Befohlen (zuletzt)', wert: rohWert(e.commandedKwLast, e.stream) });
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

/**
 * Ein befohlener Wert im Roh-Blick: Betrag + RICHTUNGSWORT, nie ein nacktes
 * Minus (die `live.ts`-Konvention gilt auch hier - „-6,5 kW" beantwortet nicht,
 * ob geladen oder entladen wurde). Für die Einspeise-Begrenzung ist der Wert
 * eine Kappe und hat keine Richtung.
 */
export function rohWert(kw: number, stream: string): string {
  if (stream !== 'batterie') {
    return fmtNum(kw, 'kW');
  }
  const dir = batteryDirection(kw);
  const betrag = fmtNum(Math.abs(kw), 'kW');
  if (dir === 'pausieren') return `${betrag} (Pause)`;
  return `${betrag} ${dir === 'laden' ? 'Laden' : 'Entladen'}`;
}

/** „—" mit Grund, nie eine erfundene Zahl (§9 Regel 3). */
export function zyklenWort(e: CommandEntry): string {
  return e.cycles == null ? '— (zählen wir noch nicht mit)' : String(e.cycles);
}

/**
 * „06:10–09:30", „ab 18:30" (laufend) oder „17:55" (Punkt-Ereignis) - und
 * „18.08. 22:00–06:00", wenn die Zeile an einem ANDEREN Tag begann als dem
 * ersten Tag des Fensters.
 *
 * <b>Das Datum ist eine Ehrlichkeitsregel, kein Schmuck</b> (19.08.2026): eine
 * Zeile, die vor dem Fenster begann, trug im „Heute"-Tab nur „22:00" - und das
 * las sich als HEUTE 22:00, also als Zukunft. Datiert wird bewusst nur der
 * BEGINN und nur gegen den ersten Tag des Fensters: das Ende liegt per
 * Konstruktion im Fenster, und ein zweites Datum wäre Rauschen.
 *
 * @param fensterTag der erste Berliner Kalendertag des Fensters („2026-08-19");
 *                   `null` = kein Bezug bekannt, dann wird nie datiert (nie ein
 *                   geratenes Datum).
 */
export function spanne(startedAt: string, endedAt: string | null, laufend: boolean,
    fensterTag: string | null = null): string {
  const von = tagUndUhr(startedAt, fensterTag);
  if (laufend) return `ab ${von}`;
  if (!endedAt) return von;
  const bis = uhr(endedAt);
  // Punkt-Ereignis: Beginn == Ende, dann nur EIN Zeitpunkt. Verglichen werden
  // die nackten Uhrzeiten - „18.08. 23:45" ist nie gleich „23:45", und die
  // Zeile läse sich sonst als Spanne von sich selbst auf sich selbst.
  if (bis === uhr(startedAt) && berlinTag(startedAt) === berlinTag(endedAt)) {
    return von;
  }
  return `${von}–${bis}`;
}

/** Uhrzeit, ggf. mit vorangestelltem Datum (siehe {@link spanne}). */
function tagUndUhr(iso: string, fensterTag: string | null): string {
  const zeit = uhr(iso);
  const tag = berlinTag(iso);
  if (!fensterTag || !tag || tag === fensterTag) return zeit;
  const datum = new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    timeZone: ZONE,
  });
  return `${datum} ${zeit}`;
}

function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: ZONE,
  });
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
    // Der Kopf trägt hier schon NUR_LESEN - denselben Satz noch einmal zu
    // sagen ist keine zweite Auskunft, sondern Rauschen.
    return 'Deshalb ist dieser Verlauf leer.';
  }
  return 'In diesem Zeitraum wurde an dieses Gerät kein Befehl geschickt.';
}

/** Der Hinweis, wenn der Deckel gegriffen hat - nie ein stilles Kappen. */
export function deckelSatz(history: CommandHistory | null): string | null {
  return history?.truncated
    ? 'Es sind sehr viele Einträge - ältere sind hier nicht mehr aufgeführt.'
    : null;
}
