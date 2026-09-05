import { describe, it, expect, afterEach, vi } from 'vitest';
import { chartMotion, motionOptions, mergeMotion } from './chartMotion';

/**
 * Bewegungs-Programm P1 · der Token-Leser der Diagramme.
 *
 * jsdom rechnet kein `calc()` und kennt kein `@property`, also wird
 * `getComputedStyle` hier GESTUBBT: geprueft wird die Uebersetzung
 * „Token-Zeichenkette → Zahl → ECharts-Option", nicht der Browser.
 */

/** Ein `:root` vortaeuschen, das die Familie in einer bestimmten Form meldet. */
function tokens(werte: Record<string, string>) {
  const spy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (n: string) => werte[n] ?? '',
  } as unknown as CSSStyleDeclaration);
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe('chartMotion() · die Familie wird gelesen, nicht geraten', () => {
  it('liest Sekunden (Chrome-Form) als Millisekunden', () => {
    tokens({
      '--vp-motion-chart': '0.4s',
      '--vp-motion-chart-update': '0.3s',
      '--vp-motion-fast': '0.12s',
      '--vp-motion-scale': '1',
    });
    expect(chartMotion()).toEqual({ enter: 400, update: 300, fast: 120, scale: 1 });
  });

  it('liest Millisekunden ebenso — beide Schreibweisen kommen vor', () => {
    tokens({
      '--vp-motion-chart': '400ms',
      '--vp-motion-chart-update': '300ms',
      '--vp-motion-fast': '120ms',
      '--vp-motion-scale': '1',
    });
    expect(chartMotion()).toEqual({ enter: 400, update: 300, fast: 120, scale: 1 });
  });

  it('der Schalter 0 nullt jede Dauer — das ist die reduzierte Bewegung', () => {
    tokens({
      '--vp-motion-chart': '0s',
      '--vp-motion-chart-update': '0s',
      '--vp-motion-fast': '0s',
      '--vp-motion-scale': '0',
    });
    expect(chartMotion()).toEqual({ enter: 0, update: 0, fast: 0, scale: 0 });
  });

  it('ein leeres oder krummes Token faellt auf den Initialwert der Familie zurueck', () => {
    tokens({ '--vp-motion-chart': '', '--vp-motion-fast': 'auto' });
    expect(chartMotion()).toEqual({ enter: 400, update: 300, fast: 120, scale: 1 });
  });

  it('fragt das Dokument GENAU EINMAL je Aufruf, nicht je Token', () => {
    const spy = tokens({ '--vp-motion-scale': '1' });
    chartMotion();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(document.documentElement);
  });

  it('merkt sich NICHTS — der Schalter darf sich waehrend der Sitzung aendern', () => {
    tokens({ '--vp-motion-scale': '1', '--vp-motion-chart': '0.4s' });
    expect(chartMotion().scale).toBe(1);
    vi.restoreAllMocks();
    tokens({ '--vp-motion-scale': '0', '--vp-motion-chart': '0s' });
    expect(chartMotion()).toMatchObject({ scale: 0, enter: 0 });
  });
});

const M = { enter: 400, update: 300, fast: 120, scale: 1 };
const AUS = { enter: 0, update: 0, fast: 0, scale: 0 };

describe('motionOptions() · zwei Phasen, zwei Aussagen', () => {
  it('EINSTIEG: `animation: false` — jeder Wert steht ab Bild 1', () => {
    expect(motionOptions(M, 'enter').animation).toBe(false);
  });

  it('UEBERGANG: Morph in der Token-Dauer mit der Zwischen-Kurve', () => {
    const o = motionOptions(M, 'update');
    expect(o.animation).toBe(true);
    expect(o.animationDurationUpdate).toBe(300);
    expect(o.animationEasingUpdate).toBe('cubicInOut');
    expect(o.animationDelayUpdate).toBe(0);
  });

  it('Interaktion: Fokus/Dimmen, Tooltip und Achsen-Fahne tragen `--vp-motion-fast`', () => {
    const o = motionOptions(M, 'update');
    expect(o.stateAnimation).toEqual({ duration: 120, easing: 'cubicOut' });
    // ECharts rechnet den Tooltip in SEKUNDEN, alles andere in Millisekunden.
    expect(o.tooltip.transitionDuration).toBeCloseTo(0.12, 5);
    expect(o.axisPointer.animationDurationUpdate).toBe(120);
  });

  it('`animationThreshold` bleibt bei 2000 (Werk, Konzept §7.3)', () => {
    expect(motionOptions(M, 'enter').animationThreshold).toBe(2000);
    expect(motionOptions(M, 'update').animationThreshold).toBe(2000);
  });

  it('Schalter 0: alles 0/false — in BEIDEN Phasen', () => {
    for (const phase of ['enter', 'update'] as const) {
      const o = motionOptions(AUS, phase);
      expect(o.animation).toBe(false);
      expect(o.animationDurationUpdate).toBe(0);
      expect(o.stateAnimation.duration).toBe(0);
      expect(o.tooltip.transitionDuration).toBe(0);
      expect(o.axisPointer.animationDurationUpdate).toBe(0);
    }
  });
});

describe('mergeMotion() · der Konsument gewinnt', () => {
  it('legt die Bewegung UNTER die Optionen des Diagramms', () => {
    const o = mergeMotion({ series: [{ type: 'bar' }] }, M, 'update');
    expect(o.animation).toBe(true);
    // ⚠ Seit P2 reist die Serie nicht mehr unveraendert durch: sie bekommt
    // ihre stabile Kennung und ihren Fokus/Dimm-Zustand dazu (dort geprueft,
    // in `chartFamilien.test.ts`). Was die Flaeche SELBST gesagt hat, bleibt
    // aber unangetastet — genau das ist die Aussage dieses Falls.
    const s = (o.series as Record<string, unknown>[])[0];
    expect(s.type).toBe('bar');
    expect(s.id).toBe('vp:#0');
  });

  it('ein eigenes `animation: false` des Diagramms bleibt stehen (die 3 stillen Flaechen)', () => {
    const o = mergeMotion({ animation: false }, M, 'update');
    expect(o.animation).toBe(false);
  });

  it('eine eigene Update-Dauer des Diagramms gewinnt ebenfalls', () => {
    const o = mergeMotion({ animationDurationUpdate: 42 }, M, 'update');
    expect(o.animationDurationUpdate).toBe(42);
  });

  it('ERFINDET KEINEN TOOLTIP: ohne eigenen Tooltip kommt auch keine Dauer dazu', () => {
    const o = mergeMotion({ series: [] }, M, 'update') as Record<string, unknown>;
    expect(o.tooltip).toBeUndefined();
    expect(o.axisPointer).toBeUndefined();
  });

  it('erklaert das Diagramm einen Tooltip, wird die Dauer nur ERGAENZT', () => {
    const o = mergeMotion(
      { tooltip: { trigger: 'axis', formatter: 'x' } },
      M,
      'update',
    ) as Record<string, Record<string, unknown>>;
    expect(o.tooltip).toEqual({ trigger: 'axis', formatter: 'x', transitionDuration: 0.12 });
  });

  it('`axisPointer.link` der Zwei-Panel-Charts ueberlebt die Ergaenzung', () => {
    const o = mergeMotion(
      { axisPointer: { link: [{ xAxisIndex: 'all' }] } },
      M,
      'update',
    ) as Record<string, Record<string, unknown>>;
    expect(o.axisPointer).toEqual({
      link: [{ xAxisIndex: 'all' }],
      animationDurationUpdate: 120,
    });
  });

  it('eine eigene Tooltip-Dauer schlaegt die unsere', () => {
    const o = mergeMotion({ tooltip: { transitionDuration: 0 } }, M, 'update') as Record<
      string,
      Record<string, unknown>
    >;
    expect(o.tooltip.transitionDuration).toBe(0);
  });

  it('ein Tooltip-ARRAY wird nicht gemischt (das waere ein anderer Typ)', () => {
    const o = mergeMotion({ tooltip: [] }, M, 'update') as Record<string, unknown>;
    expect(o.tooltip).toEqual([]);
  });
});
