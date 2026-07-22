import { describe, expect, it } from 'vitest';
import { channelLabel, channelUnitHint, commandLabel, hasChannelLabel } from './channels';

describe('channelLabel - no internal identifiers in customer copy (G4)', () => {
  it('names every channel the demo surfaces show', () => {
    expect(channelLabel('pv_power_kw')).toBe('PV-Leistung');
    expect(channelLabel('soc_pct')).toBe('Ladestand');
    expect(channelLabel('battery_power_kw')).toBe('Batterieleistung');
    expect(channelLabel('power_kw')).toBe('Leistung');
    expect(channelLabel('grid_power_kw')).toBe('Netzleistung');
    expect(channelLabel('load_kw')).toBe('Hausverbrauch');
    expect(channelLabel('energy_kwh')).toBe('Energie');
  });

  it('names the actuate commands', () => {
    expect(commandLabel('setpoint_kw')).toBe('Sollwert');
    expect(commandLabel('limit_kw')).toBe('Grenzwert');
    expect(commandLabel('limit_pct')).toBe('Grenzwert (%)');
    expect(commandLabel('on_off')).toBe('Ein/Aus');
    expect(commandLabel('plan')).toBe('Fahrplan');
  });

  it('never invents a label - the open vocabulary falls back to the raw name', () => {
    // MB-M1 lets an operator declare free channels on a modbus-generic entity;
    // showing what they typed is honest, hiding or guessing would not be.
    expect(channelLabel('wasser_temp_c')).toBe('wasser_temp_c');
    expect(commandLabel('irgendein_befehl')).toBe('irgendein_befehl');
    expect(hasChannelLabel('wasser_temp_c')).toBe(false);
    expect(hasChannelLabel('soc_pct')).toBe(true);
  });

  it('derives a unit hint from the channel suffix only when there is one', () => {
    expect(channelUnitHint('soc_pct')).toBe('%');
    expect(channelUnitHint('pv_power_kw')).toBe('kW');
    expect(channelUnitHint('energy_kwh')).toBe('kWh');
    expect(channelUnitHint('mode')).toBeNull();
  });
});
