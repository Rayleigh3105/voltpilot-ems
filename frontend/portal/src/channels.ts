/**
 * THE German label dictionary for v2 entity channels + actuate commands.
 *
 * The portal rule "keine internen Bezeichner in Kundencopy" applies to the
 * entity surface too: a customer must never read `pv_power_kw` / `soc_pct` /
 * `setpoint_kw`. The contract's channel vocabulary is OPEN (edge-entity
 * `CHANNEL_RE`, and MB-M1 lets an operator declare free channel names on a
 * `modbus-generic` entity), so this is a best-effort map with a GRACEFUL
 * FALLBACK: an unknown channel renders its raw name rather than a fabricated
 * or hidden label - honest, and the operator-declared name is what the
 * operator typed anyway.
 *
 * Pure + framework-free, unit-tested in channels.test.ts. Every surface that
 * shows a channel/command to a customer must go through here.
 */

/** Channel name -> plain-German label (the measured quantity). */
const CHANNEL_LABELS: Record<string, string> = {
  // Pilot + E1b measure channels.
  pv_power_kw: 'PV-Leistung',
  // Einzelne MPPT-Stränge + Gen-Port eines Hybrid-Wechselrichters (Ankerfall
  // Deye SUN-30K): der Wechselrichter zählt den Mikrowechselrichter am Gen-Port
  // NICHT in seine PV-Summe — der Kunde liest die Stränge deshalb als eigene Werte.
  pv1_power_kw: 'PV 1',
  pv2_power_kw: 'PV 2',
  pv3_power_kw: 'PV 3',
  microinverter_power_kw: 'Mikrowechselrichter',
  soc_pct: 'Ladestand',
  battery_power_kw: 'Batterieleistung',
  power_kw: 'Leistung',
  load_kw: 'Hausverbrauch',
  grid_power_kw: 'Netzleistung',
  grid_limit_kw: 'Netzgrenze',
  energy_kwh: 'Energie',
  temperature_c: 'Temperatur',
  current_a: 'Strom',
  voltage_v: 'Spannung',
  frequency_hz: 'Frequenz',
};

/** Actuate command -> plain-German label (what can be commanded). */
const COMMAND_LABELS: Record<string, string> = {
  setpoint_kw: 'Sollwert',
  limit_kw: 'Grenzwert',
  limit_pct: 'Grenzwert (%)',
  plan: 'Fahrplan',
  on_off: 'Ein/Aus',
  mode: 'Betriebsart',
};

/**
 * German label for a measure channel. Unknown channels (the open vocabulary /
 * operator-declared Modbus channels) fall back to their raw name.
 */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/**
 * German label for an actuate command. Unknown commands fall back to their raw
 * name (same honesty rule as {@link channelLabel}).
 */
export function commandLabel(command: string): string {
  return COMMAND_LABELS[command] ?? command;
}

/** True when we have a real German word for this channel (else it is raw). */
export function hasChannelLabel(channel: string): boolean {
  return channel in CHANNEL_LABELS;
}

/**
 * The unit a channel is measured in, when the label alone would be ambiguous.
 * Returns null when the entity's own `unit` should be used instead.
 */
export function channelUnitHint(channel: string): string | null {
  if (channel.endsWith('_pct')) return '%';
  if (channel.endsWith('_kw')) return 'kW';
  if (channel.endsWith('_kwh')) return 'kWh';
  return null;
}
