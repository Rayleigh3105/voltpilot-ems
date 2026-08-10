/**
 * The pure reason_code/state → German mapping of the consumer live status
 * (docs/verbrauchssteuerung.md §14.13/§15, Inkrement 3 / D9). THE house rule:
 * no surface ever greps German sentences - the machine-readable words map
 * through THIS one tested table, and a word we do not know produces NO claimed
 * text (the surface then says "Zustand nicht bestätigt", never a guess).
 *
 * Honesty rules the derivation keeps:
 *  - no reported entry at all => "Zustand nicht bestätigt" (nothing invented),
 *  - `confirmed === false` appends "Ausführung nicht bestätigt" (§3.3),
 *  - `confirmed` absent/null claims NOTHING about execution (tri-state).
 */

export interface ConsumerRuntimeStatus {
  entityId: string;
  state: string;
  reasonCode?: string | null;
  actualKw?: number | null;
  confirmed?: boolean | null;
  runtimeSecondsToday?: number | null;
  startsToday?: number | null;
  reportedAt: string;
}

/** §14.13 state → customer sentence (verbatim from the concept table). */
export const CONSUMER_STATE_TEXT: Record<string, string> = {
  disconnected: 'Noch nicht verbunden',
  offline: 'Gerät meldet sich nicht',
  ready: 'Bereit',
  running_forced: 'Läuft · Pflichtregel',
  running_optimized: 'Läuft · von VoltPilot geplant',
  waiting: 'Wartet auf passenden Zeitpunkt',
  fulfilled: 'Tagesziel erfüllt',
  clamped: 'Begrenzt · Schutz/Netzvorgabe',
  missed: 'Ziel nicht vollständig erreicht',
  unknown: 'Zustand nicht bestätigt',
};

/** §15 reason_code (incl. the cycle-guard extension) → customer wording. */
export const CONSUMER_REASON_TEXT: Record<string, string> = {
  vehicle_connected: 'Auto verbunden',
  fixed_window: 'Festes Zeitfenster',
  price_below_threshold: 'Günstiger Strompreis',
  soc_above_threshold: 'Speicher ausreichend geladen',
  flex_deadline: 'Frist rückt näher',
  flex_deadline_fallback: 'Vom Gerät gestartet, damit die Frist hält',
  optimizer_selected_low_cost: 'Von VoltPilot günstig eingeplant',
  consumer_first: 'Verbraucher zuerst',
  storage_first: 'Speicher zuerst',
  guard_rated_power: 'Durch die Nennleistung begrenzt',
  guard_grid_limit: 'Durch Netzvorgabe begrenzt',
  device_offline: 'Gerät meldet sich nicht',
  readback_mismatch: 'Das Gerät hat den Befehl nicht übernommen',
  signal_stale: 'Messwert veraltet',
  guard_min_on: 'Mindestlaufzeit des Geräts hält',
  guard_min_off: 'Mindestpause des Geräts',
  guard_max_starts: 'Maximale Starts für heute erreicht',
  guard_ramp: 'Leistung wird schrittweise angepasst',
  guard_phase_switch: 'Wartet auf die Phasenumschaltpause',
  plan_stale: 'Kein aktueller Fahrplan',
};

/** The honest no-evidence sentence (also the `unknown` state's text). */
export const STATUS_UNKNOWN_TEXT = 'Zustand nicht bestätigt';

/** The §3.3 execution disclaimer for a disagreeing readback. */
export const NOT_CONFIRMED_TEXT = 'Ausführung nicht bestätigt';

export interface ConsumerStatusLine {
  /** The state sentence ("Läuft · von VoltPilot geplant"). */
  text: string;
  /** The reason sentence, '' when none / unknown word. */
  reason: string;
  /** True exactly when confirmed === false (append NOT_CONFIRMED_TEXT). */
  unconfirmed: boolean;
  /** Tone for the dot: ok (running) | warn (holds/limits) | off (idle). */
  tone: 'ok' | 'warn' | 'off';
}

/**
 * Derive the status line of one consumer. `entry` undefined/null = no reported
 * evidence => the unknown line (never a fabricated live state). An unknown
 * state WORD (a newer edge against an older portal - the ingest whitelist
 * normally prevents it) also claims nothing.
 */
export function consumerStatusLine(
  entry: ConsumerRuntimeStatus | null | undefined,
): ConsumerStatusLine {
  if (!entry) {
    return { text: STATUS_UNKNOWN_TEXT, reason: '', unconfirmed: false, tone: 'off' };
  }
  const text = CONSUMER_STATE_TEXT[entry.state];
  if (!text) {
    return { text: STATUS_UNKNOWN_TEXT, reason: '', unconfirmed: false, tone: 'off' };
  }
  const reason = entry.reasonCode ? (CONSUMER_REASON_TEXT[entry.reasonCode] ?? '') : '';
  const unconfirmed = entry.confirmed === false;
  let tone: ConsumerStatusLine['tone'] = 'off';
  if (entry.state === 'running_forced' || entry.state === 'running_optimized'
    || entry.state === 'fulfilled') {
    tone = 'ok';
  }
  if (entry.state === 'clamped' || entry.state === 'offline' || entry.state === 'missed'
    || unconfirmed) {
    tone = 'warn';
  }
  return { text, reason, unconfirmed, tone };
}
