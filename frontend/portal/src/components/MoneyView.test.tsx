import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StripSlot } from '../anlage';
import { MonthStrip } from './MoneyView';

/**
 * Der Monats-Streifen trug seine Zahlen, aber die Reihe war ohne Zahlenlesen
 * ununterscheidbar — es fehlte die Grössenkodierung (`vp-charts-filigran-c7`
 * §3b Nr. 18). Seit Stufe 5 tragen die Chips Mini-Balken EINER gemeinsamen
 * Skala; diese Suite hält fest, dass sie dabei nicht anfangen zu lügen.
 */

const SLOTS: StripSlot[] = [
  { month: '2026-05-01', label: 'Mai', value: 20 },
  { month: '2026-06-01', label: 'Jun', value: 5 },
  { month: '2026-07-01', label: 'Jul', value: 40 },
];

function strip(slots: StripSlot[], showValues = true) {
  return render(
    <MonthStrip
      slots={slots}
      selectedMonth="2026-07-01"
      onSelect={() => {}}
      showValues={showValues}
    />,
  );
}

function bars(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.vp-mstrip-bar .vp-mini-bar')];
}

describe('MonthStrip · Grössenkodierung auf EINER Skala', () => {
  it('gibt jedem Chip einen Balken', () => {
    const { container } = strip(SLOTS);
    expect(bars(container)).toHaveLength(3);
  });

  it('teilt EINE Skala - der grösste Monat ist der höchste Balken', () => {
    const { container } = strip(SLOTS);
    const hoehen = bars(container).map((b) => parseFloat(b.style.height));
    // Mai 20 · Jun 5 · Jul 40 -> Jul am höchsten, Jun am kleinsten.
    expect(hoehen[2]).toBeGreaterThan(hoehen[0]);
    expect(hoehen[0]).toBeGreaterThan(hoehen[1]);
    // Und die Verhältnisse stimmen: 20 zu 40 ist die Hälfte.
    expect(hoehen[0] / hoehen[2]).toBeCloseTo(0.5, 3);
  });

  it('betont den gewählten Monat', () => {
    const { container } = strip(SLOTS);
    const on = container.querySelectorAll('.vp-mstrip-bar .vp-mini-bar.is-on');
    expect(on).toHaveLength(1);
  });

  it('zeichnet für einen Monat OHNE Daten gar keinen Balken, nie einen Nullbalken', () => {
    const { container } = strip([
      { month: '2026-05-01', label: 'Mai', value: 20 },
      { month: '2026-06-01', label: 'Jun', value: null, hasData: false },
      { month: '2026-07-01', label: 'Jul', value: 40 },
    ]);
    expect(bars(container)).toHaveLength(2);
  });

  it('macht aus einem winzigen Monat einen STRICH, statt ihn hochzuziehen', () => {
    const { container } = strip([
      { month: '2026-06-01', label: 'Jun', value: 0.05 },
      { month: '2026-07-01', label: 'Jul', value: 400 },
    ]);
    expect(bars(container).map((b) => b.dataset.form)).toEqual(['tick', 'bar']);
  });

  it('trägt als reiner Sprung-Navigator KEINE Balken (er kennt keine Werte)', () => {
    const { container } = strip(SLOTS, false);
    expect(bars(container)).toHaveLength(0);
  });
});
