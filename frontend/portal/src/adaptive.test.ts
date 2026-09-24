import { describe, expect, it } from 'vitest';
import {
  controlPreset,
  iconFor,
  isControllableConsumerType,
  ROLE_META,
  truncate,
} from './adaptive';

describe('ROLE_META', () => {
  it('maps every role to a flow token + tile class', () => {
    expect(ROLE_META.pv.color).toContain('--vp-flow-pv');
    expect(ROLE_META.storage.tileClass).toBe('batt');
    expect(ROLE_META.consumer.tileClass).toBe('load');
    expect(ROLE_META.grid.icon).toBe('zap');
  });
});

describe('iconFor', () => {
  it('gives controllable consumers a per-type icon', () => {
    expect(iconFor('wallbox', 'consumer')).toBe('battery-charging');
    expect(iconFor('heating-rod', 'consumer')).toBe('activity');
    expect(iconFor('generic-load', 'consumer')).toBe('home');
  });
  it('falls back to the role icon for unknown types', () => {
    expect(iconFor('', 'pv')).toBe('sun');
    expect(iconFor('', 'grid')).toBe('zap');
  });
  it('names a hybrid per ROLE - its PV circle shows the sun, not a battery', () => {
    expect(iconFor('battery-hybrid', 'pv')).toBe('sun');
    expect(iconFor('battery-hybrid', 'storage')).toBe('battery');
    expect(iconFor('battery-hybrid', 'consumer')).toBe('home');
    expect(iconFor('battery-hybrid', 'grid')).toBe('zap');
  });
});

describe('isControllableConsumerType', () => {
  it('recognises the catalog consumer types', () => {
    expect(isControllableConsumerType('wallbox')).toBe(true);
    expect(isControllableConsumerType('heating-rod')).toBe(true);
    expect(isControllableConsumerType('generic-load')).toBe(true);
  });
  it('is false for non-consumer types', () => {
    expect(isControllableConsumerType('battery-hybrid')).toBe(false);
    expect(isControllableConsumerType('grid-meter')).toBe(false);
  });
});

describe('controlPreset', () => {
  it('gives a wallbox the Aus/Nur PV/Voll switches with Nur PV default', () => {
    const p = controlPreset('wallbox');
    expect(p?.options).toEqual(['Aus', 'Nur PV', 'Voll']);
    expect(p?.defaultIndex).toBe(1);
  });
  it('gives a heating rod the Auto/An/Aus switches', () => {
    expect(controlPreset('heating-rod')?.options).toEqual(['Auto', 'An', 'Aus']);
  });
  it('is null for a non-controllable type', () => {
    expect(controlPreset('battery-hybrid')).toBeNull();
  });
});

describe('truncate', () => {
  it('leaves short labels untouched', () => {
    expect(truncate('Wallbox')).toBe('Wallbox');
  });
  it('ellipsises a long label', () => {
    expect(truncate('Deye SUN-30K-SG01HP3')).toBe('Deye SUN-3…');
  });
});
