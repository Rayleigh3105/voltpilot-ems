import { describe, expect, it } from 'vitest';
import type { TelemetryPoint } from './api';
import {
  batteryState,
  buildSnapshot,
  composeStatusSentence,
  deriveBatteryKw,
  flowState,
  FLOW_TEMPO_FAST_S,
  FLOW_TEMPO_SLOW_S,
  flowTempo,
  gridState,
  loadState,
  pvState,
  type LiveSnapshot,
} from './live';

const pt = (over: Partial<TelemetryPoint> = {}): TelemetryPoint => ({
  ts: '2026-07-06T10:00:00Z',
  powerKw: null,
  socPct: null,
  pvPowerKw: null,
  loadKw: null,
  gridLimitKw: null,
  ...over,
});

const snap = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  pvKw: null,
  loadKw: null,
  gridKw: null,
  battKw: null,
  socPct: null,
  socAt: null,
  ...over,
});

describe('deriveBatteryKw', () => {
  it('applies the power balance grid - load + pv', () => {
    // report appendix: {load 9.51, power 3.17, pv 0} -> -6.34 discharging
    expect(deriveBatteryKw(0, 9.51, 3.17)).toBeCloseTo(-6.34, 2);
    // surplus charging: pv 4.7, load 1.1, export -2.4 -> +1.2
    expect(deriveBatteryKw(4.7, 1.1, -2.4)).toBeCloseTo(1.2, 5);
  });

  it('stays absent (never 0) when any input is missing', () => {
    expect(deriveBatteryKw(null, 1, 1)).toBeNull();
    expect(deriveBatteryKw(1, null, 1)).toBeNull();
    expect(deriveBatteryKw(1, 1, null)).toBeNull();
  });
});

describe('buildSnapshot', () => {
  it('takes the newest finite value per channel and the newest plausible SoC', () => {
    const s = buildSnapshot([
      pt({ ts: 't1', pvPowerKw: 4, loadKw: 1, powerKw: -2, socPct: 60 }),
      pt({ ts: 't2', pvPowerKw: null, loadKw: 1.2, powerKw: -1, socPct: 61 }),
    ]);
    expect(s.pvKw).toBe(4); // t2 pv is null -> falls back to t1
    expect(s.loadKw).toBe(1.2);
    expect(s.gridKw).toBe(-1);
    // t2 can't derive battery (pv is null) -> newest DERIVABLE sample is t1.
    expect(s.battKw).toBeCloseTo(-2 - 1 + 4, 5);
    expect(s.socPct).toBe(61);
    expect(s.socAt).toBe('t2');
  });

  it('falls back to the newest plausible SoC and skips implausible reads', () => {
    const s = buildSnapshot([
      pt({ ts: 't1', socPct: 55 }),
      pt({ ts: 't2', socPct: 1270 }), // implausible -> ignored
    ]);
    expect(s.socPct).toBe(55);
    expect(s.socAt).toBe('t1');
  });

  it('is all-null for an empty window', () => {
    const s = buildSnapshot([]);
    expect(s).toEqual(snap());
  });
});

describe('tile states', () => {
  it('pvState: deadband + unknown', () => {
    expect(pvState(4.7)).toBe('erzeugt');
    expect(pvState(0.04)).toBe('keine');
    expect(pvState(null)).toBe('unbekannt');
  });

  it('loadState: deadband + unknown', () => {
    expect(loadState(1.1)).toBe('bedarf');
    expect(loadState(0)).toBe('keiner');
    expect(loadState(null)).toBe('unbekannt');
  });

  it('gridState: flips by sign with a 0.05 kW deadband', () => {
    expect(gridState(2.4)).toBe('bezug');
    expect(gridState(-2.4)).toBe('einspeisung');
    expect(gridState(0.02)).toBe('ausgeglichen');
    expect(gridState(-0.02)).toBe('ausgeglichen');
    expect(gridState(null)).toBe('unbekannt');
  });

  it('batteryState: no SoC = no battery, then charge/discharge/full/idle', () => {
    expect(batteryState(null, 3)).toBe('keine');
    expect(batteryState(76, 1.2)).toBe('laedt');
    expect(batteryState(76, -1.2)).toBe('entlaedt');
    expect(batteryState(100, 0)).toBe('voll');
    expect(batteryState(99, null)).toBe('voll');
    expect(batteryState(54, 0)).toBe('bereit');
    expect(batteryState(54, null)).toBe('bereit'); // unknown power, mid SoC -> ruht
  });
});

describe('flowState', () => {
  it('PV flows into the hub, Haus draws, and idle spokes are inactive', () => {
    const f = flowState(snap({ pvKw: 4.7, loadKw: 1.1, gridKw: 0, battKw: 0 }));
    expect(f.pv).toMatchObject({ active: true, reverse: false });
    expect(f.load).toMatchObject({ active: true, reverse: true });
    expect(f.grid.active).toBe(false);
    expect(f.batt.active).toBe(false);
  });

  it('grid reverses on export, battery reverses on charge', () => {
    const exportCharge = flowState(snap({ gridKw: -2.4, battKw: 1.2 }));
    expect(exportCharge.grid).toMatchObject({ active: true, reverse: true }); // export
    expect(exportCharge.batt).toMatchObject({ active: true, reverse: true }); // charge

    const importDischarge = flowState(snap({ gridKw: 2.4, battKw: -1.2 }));
    expect(importDischarge.grid).toMatchObject({ active: true, reverse: false }); // import
    expect(importDischarge.batt).toMatchObject({ active: true, reverse: false }); // discharge
  });

  it('absent channels are inactive (never a phantom flow)', () => {
    const f = flowState(snap());
    expect(f.pv.active).toBe(false);
    expect(f.grid.active).toBe(false);
    expect(f.batt.active).toBe(false);
  });
});

describe('composeStatusSentence', () => {
  const text = (s: Partial<LiveSnapshot>, fresh = true) =>
    composeStatusSentence(snap(s), fresh).text;

  it('stale/offline goes honest-grey and says so', () => {
    const r = composeStatusSentence(snap({ pvKw: 4.7 }), false);
    expect(r.live).toBe(false);
    expect(r.text).toContain('keine aktuellen Daten');
    expect(r.text).toContain('zuletzt bekannten Werte');
  });

  it('producing + charging + exporting (the report headline case)', () => {
    const r = composeStatusSentence(
      snap({ pvKw: 4.7, loadKw: 1.1, gridKw: -2.4, battKw: 1.2, socPct: 76 }),
      true,
    );
    expect(r.live).toBe(true);
    expect(r.text).toContain('erzeugt gerade 4,7');
    expect(r.text).toContain('Batterie lädt');
    expect(r.text).toContain('76');
    expect(r.text).toContain('fließen ins Netz');
  });

  it('idle PV at night: no generation', () => {
    expect(text({ pvKw: 0, loadKw: 0.6, gridKw: 0.6 })).toContain('erzeugt gerade keinen Strom');
  });

  it('discharging + importing', () => {
    const t = text({ pvKw: 0, loadKw: 9.5, gridKw: 3.2, battKw: -6.3, socPct: 54 });
    expect(t).toContain('Batterie entlädt');
    expect(t).toContain('beziehen');
    expect(t).toContain('aus dem Netz');
  });

  it('battery full and balanced grid', () => {
    const t = text({ pvKw: 1, loadKw: 1, gridKw: 0, battKw: 0, socPct: 100 });
    expect(t).toContain('voll geladen');
    expect(t).toContain('ausgeglichen');
  });

  it('battery ruht at mid SoC when power is unknown', () => {
    expect(text({ socPct: 54 })).toContain('Batterie ruht');
  });

  it('no battery clause when SoC is absent', () => {
    const t = text({ pvKw: 2, loadKw: 1, gridKw: -1 });
    expect(t).not.toContain('Batterie');
  });

  it('never leaks a signed number into the copy', () => {
    const t = text({ pvKw: 3, loadKw: 1, gridKw: -2, battKw: 0, socPct: 50 });
    expect(t).not.toMatch(/-\d/);
  });

  it('degrades to a minimal live line when only unknowns are present', () => {
    expect(text({})).toBe('Ihre Anlage liefert gerade Daten.');
  });
});

/**
 * Der Tempo-Waechter des Energieflusses (Bewegungs-Programm P3, E4 a).
 *
 * Er misst die DREI Zusagen, mit denen die Bewegung einen Messwert erzaehlt:
 * Deckel in beide Richtungen, Ruhe bei Null (ueber `flowState.active`) und
 * Monotonie — mehr Leistung darf nie langsamer aussehen.
 */
describe('flowTempo', () => {
  it('haelt die Formel clamp(0.45, 1.8/(1+kW/2), 1.8)', () => {
    expect(flowTempo(0)).toBeCloseTo(1.8, 6); // 1.8 / 1
    expect(flowTempo(1)).toBeCloseTo(1.2, 6); // 1.8 / 1.5
    expect(flowTempo(2)).toBeCloseTo(0.9, 6); // 1.8 / 2  == das heutige Tempo
    expect(flowTempo(4)).toBeCloseTo(0.6, 6); // 1.8 / 3
  });

  it('deckelt nach OBEN beim Ruhetempo', () => {
    expect(flowTempo(0)).toBe(FLOW_TEMPO_SLOW_S);
    expect(flowTempo(0.05)).toBeLessThanOrEqual(FLOW_TEMPO_SLOW_S);
  });

  it('deckelt nach UNTEN, damit das Punktband nie flimmert', () => {
    expect(flowTempo(6)).toBe(FLOW_TEMPO_FAST_S); // 1.8/4 = 0.45 exakt
    expect(flowTempo(30)).toBe(FLOW_TEMPO_FAST_S);
    expect(flowTempo(1e9)).toBe(FLOW_TEMPO_FAST_S);
  });

  it('ist MONOTON: mehr kW ist nie langsamer', () => {
    let prev = flowTempo(0);
    for (let kw = 0.1; kw <= 40; kw += 0.1) {
      const cur = flowTempo(kw);
      expect(cur).toBeLessThanOrEqual(prev + 1e-12);
      prev = cur;
    }
  });

  it('ist vorzeichenblind - die Richtung sagt `reverse`, nicht das Tempo', () => {
    expect(flowTempo(-3.4)).toBe(flowTempo(3.4));
    expect(flowTempo(-30)).toBe(flowTempo(30));
  });

  it('faellt bei unbrauchbarer Zahl auf das RUHETEMPO, nie auf NaN', () => {
    expect(flowTempo(Number.NaN)).toBe(FLOW_TEMPO_SLOW_S);
    expect(flowTempo(Number.POSITIVE_INFINITY)).toBe(FLOW_TEMPO_SLOW_S);
  });

  it('RUHE BEI NULL: unter dem Totband ist die Speiche inaktiv, also punktlos', () => {
    const snap: LiveSnapshot = {
      ts: new Date('2026-09-04T10:00:00Z'),
      pvKw: 0.04,
      loadKw: 0,
      gridKw: -0.049,
      battKw: null,
      socPct: null,
    };
    const f = flowState(snap);
    expect(f.pv.active).toBe(false);
    expect(f.load.active).toBe(false);
    expect(f.grid.active).toBe(false);
    expect(f.batt.active).toBe(false);
    // Die Richtung bleibt trotzdem definiert - sie ist eine Eigenschaft der
    // Rolle, nicht der Leistung.
    expect(f.load.reverse).toBe(true);
  });

  it('bleibt ueber dem Totband aktiv und bekommt dort ein echtes Tempo', () => {
    const f = flowState({
      ts: new Date('2026-09-04T10:00:00Z'),
      pvKw: 8,
      loadKw: 2,
      gridKw: -6,
      battKw: null,
      socPct: null,
    });
    expect(f.pv.active).toBe(true);
    expect(flowTempo(f.pv.magnitude)).toBeLessThan(flowTempo(f.load.magnitude));
  });
});
