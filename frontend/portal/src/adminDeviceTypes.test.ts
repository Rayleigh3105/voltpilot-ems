import { describe, expect, it } from 'vitest';
import {
  certDetail,
  certSummary,
  certView,
  deviceTypeRows,
} from './adminDeviceTypes';
import type { ConsumerDeviceType } from './admin/adminApi';

function dt(over: Partial<ConsumerDeviceType>): ConsumerDeviceType {
  return {
    type: 'wallbox',
    label: 'Wallbox',
    certificationStatus: 'simulator_only',
    certifiedAt: null,
    certificationNotes: null,
    connectedCount: 0,
    ...over,
  };
}

describe('certView', () => {
  it('maps each known status to a word + tone', () => {
    expect(certView('certified')).toEqual({ label: 'Zertifiziert (plattformweit)', tone: 'ok' });
    expect(certView('in_certification').tone).toBe('warn');
    expect(certView('simulator_only').tone).toBe('off');
    expect(certView('not_certified').tone).toBe('off');
  });
  it('an unknown status claims nothing (never "zertifiziert")', () => {
    expect(certView('brand_new_word')).toEqual({ label: 'Unbekannt', tone: 'off' });
    expect(certView(null).label).toBe('Unbekannt');
  });
});

describe('certDetail', () => {
  it('names "seit {Datum}" only for a certified type with a real date', () => {
    expect(certDetail(dt({ certificationStatus: 'certified', certifiedAt: '2026-08-11T00:00:00Z' })))
      .toBe('seit 11.08.2026');
    expect(certDetail(dt({ certificationStatus: 'certified', certifiedAt: null }))).toBe('');
  });
  it('appends the catalog note; a non-certified type gets no date', () => {
    expect(certDetail(dt({ certificationNotes: 'Bench folgt' }))).toBe('Bench folgt');
    expect(certDetail(dt({ certificationStatus: 'simulator_only', certifiedAt: '2026-08-11' })))
      .toBe('');
  });
});

describe('deviceTypeRows', () => {
  it('sorts certified first, then in-certification, then the rest by label', () => {
    const rows = deviceTypeRows([
      dt({ type: 'pump', label: 'Pumpe', certificationStatus: 'simulator_only' }),
      dt({ type: 'wallbox', label: 'Wallbox', certificationStatus: 'certified' }),
      dt({ type: 'heating-rod', label: 'Heizstab', certificationStatus: 'in_certification' }),
      dt({ type: 'generic-load', label: 'Allgemeiner Verbraucher', certificationStatus: 'simulator_only' }),
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      'Wallbox', 'Heizstab', 'Allgemeiner Verbraucher', 'Pumpe',
    ]);
  });
});

describe('certSummary', () => {
  it('states the honest starting state when nothing is certified', () => {
    expect(certSummary([dt({}), dt({ type: 'pump' })])).toContain('nur der Simulator');
  });
  it('counts certified when there are some', () => {
    expect(certSummary([dt({ certificationStatus: 'certified' }), dt({ type: 'pump' })]))
      .toBe('1 von 2 Gerätetypen plattformweit zertifiziert.');
  });
  it('is empty-safe', () => {
    expect(certSummary([])).toContain('Noch keine');
  });
});
