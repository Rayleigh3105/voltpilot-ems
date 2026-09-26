import { describe, expect, it } from 'vitest';
import type { FlowNode } from './topology';
import {
  LADEN_BEI_BEZUG_KURZ_MS,
  flussAusKnoten,
  flussAusSnapshot,
  ladenBeiBezug,
  ladenBeiBezugJetzt,
  ladenBeiBezugSeit,
} from './ladenBeiBezug';
import { LADEN_BEI_BEZUG_FAHRPLAN, LADEN_BEI_BEZUG_WOLKE } from './glossar';

const T0 = Date.parse('2026-09-24T15:08:00Z');

function knoten(batt: number, grid: number): FlowNode[] {
  const n = (role: FlowNode['role'], v: number, plus: 'in' | 'out'): FlowNode => ({
    role,
    value_kw: Math.abs(v),
    flow_active: Math.abs(v) > 0.05,
    ...(Math.abs(v) > 0.05 ? { direction: v > 0 ? plus : plus === 'in' ? 'out' : 'in' } : {}),
    members: [],
  });
  return [n('storage', batt, 'out'), n('grid', grid, 'in')];
}

describe('Laden bei Bezug (h4 §7 B2)', () => {
  it('liest die gezeichneten Knoten mit Vorzeichen: Speicher out = laden, Netz in = Bezug', () => {
    expect(flussAusKnoten(knoten(16.58, 8.51))).toEqual({ battKw: 16.58, gridKw: 8.51 });
    expect(flussAusKnoten(knoten(-3, -12))).toEqual({ battKw: -3, gridKw: -12 });
    expect(flussAusKnoten([])).toEqual({ battKw: null, gridKw: null });
    expect(flussAusSnapshot({ pvKw: 1, loadKw: 1, gridKw: 2, battKw: 2, socPct: 1, socAt: null }))
      .toEqual({ battKw: 2, gridKw: 2 });
  });

  it('erkennt den Zustand nur frisch, bekannt und beidseitig deutlich', () => {
    expect(ladenBeiBezugJetzt({ battKw: 16.58, gridKw: 8.51 }, true)).toBe(true);
    expect(ladenBeiBezugJetzt({ battKw: 16.58, gridKw: 8.51 }, false)).toBe(false);
    expect(ladenBeiBezugJetzt({ battKw: 16.58, gridKw: null }, true)).toBe(false);
    expect(ladenBeiBezugJetzt({ battKw: 16.58, gridKw: 0.3 }, true)).toBe(false);
    expect(ladenBeiBezugJetzt({ battKw: -5, gridKw: 8 }, true)).toBe(false);
    expect(ladenBeiBezugJetzt({ battKw: 5, gridKw: -8 }, true)).toBe(false);
  });

  it('hält den ersten Zeitpunkt und löscht ihn, sobald der Zustand endet', () => {
    const a = ladenBeiBezugSeit(null, true, T0);
    expect(a).toBe(T0);
    expect(ladenBeiBezugSeit(a, true, T0 + 30_000)).toBe(T0);
    expect(ladenBeiBezugSeit(a, false, T0 + 60_000)).toBeNull();
  });

  it('kurz: der Wolken-Satz, bis zur Grenze einschließlich', () => {
    expect(ladenBeiBezug(null, T0)).toBeNull();
    expect(ladenBeiBezug(T0, T0)).toEqual({ art: 'wolke', text: LADEN_BEI_BEZUG_WOLKE });
    expect(ladenBeiBezug(T0, T0 + LADEN_BEI_BEZUG_KURZ_MS)?.art).toBe('wolke');
  });

  it('länger und vom Fahrplan gewollt: nennt den Fahrplan und seinen Grund', () => {
    const v = ladenBeiBezug(T0, T0 + 10 * 60_000, {
      slotRole: 'guenstig_laden',
      grund: 'Lädt günstig aus dem Netz für die teuren Stunden.',
    });
    expect(v).toEqual({
      art: 'fahrplan',
      text: `${LADEN_BEI_BEZUG_FAHRPLAN} Lädt günstig aus dem Netz für die teuren Stunden.`,
    });
    expect(ladenBeiBezug(T0, T0 + 10 * 60_000, { slotRole: 'guenstig_laden' })?.text)
      .toBe(LADEN_BEI_BEZUG_FAHRPLAN);
  });

  it('länger ohne belegten Grund: keine erfundene Ursache, die Dauer in Minuten', () => {
    // Herzogau 16:14–16:45: der Plan wollte Solarüberschuss speichern, nicht Netzstrom.
    const v = ladenBeiBezug(T0, T0 + 31 * 60_000, { slotRole: 'pv_speichern', grund: 'egal' });
    expect(v?.art).toBe('anhaltend');
    expect(v?.text).toBe('Der Speicher lädt seit 31 Minuten auch mit Strom aus dem Netz. Bitte im Blick behalten.');
    expect(ladenBeiBezug(T0, T0 + LADEN_BEI_BEZUG_KURZ_MS + 1)?.text).toContain('seit 2 Minuten');
  });
});
