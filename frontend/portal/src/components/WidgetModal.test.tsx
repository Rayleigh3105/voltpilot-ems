import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { WidgetModal } from './WidgetModal';
import type { History, HistoryBucket } from '../api';
import type { WidgetDef } from '../cockpitWidgets';

/**
 * Portal v3.2 · M2 — der Beweis des RICHEN Detail-Modals: Werte UND Verlauf in
 * EINER Ansicht, kein „Jetzt | Verlauf"-Umschalter mehr.
 */

// jsdom hat kein Canvas-Backend für ECharts - für diesen Render-Beweis egal.
vi.mock('../useEChart', () => ({ useEChart: () => ({ current: null }) }));

const WIDGET: WidgetDef = {
  id: 'netz',
  label: 'Netz',
  value: '2,1 kW',
  sub: 'Einspeisung',
  accent: 'grid',
  lead: false,
  modal: {
    jetzt: {
      rows: [
        { label: 'Netz jetzt', value: '2,1 kW', sub: 'Einspeisung' },
        { label: 'Heute bezogen', value: '—' },
      ],
      note: null,
      drillIn: null,
    },
    verlauf: {
      rows: [],
      note: null,
      drillIn: { sub: 'historie', label: 'Historie öffnen' },
    },
  },
};

function bucket(start: string, over: Partial<HistoryBucket> = {}): HistoryBucket {
  return {
    start,
    pvKwh: null,
    loadKwh: null,
    gridImportKwh: null,
    gridExportKwh: null,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
    ...over,
  };
}

function history(range: History['range'], buckets: HistoryBucket[]): History {
  return {
    range,
    from: '',
    to: '',
    bucketMinutes: range === 'day' ? 15 : 1440,
    buckets,
    totals: {} as never,
    protocol: [],
    plan: [],
  };
}

const MONTH_HISTORY = history('month', [
  bucket('2026-07-01T00:00:00Z', { gridImportKwh: 4, gridExportKwh: 1 }),
  bucket('2026-07-02T00:00:00Z', { gridImportKwh: 3, gridExportKwh: 2 }),
]);

function open(over: Partial<Parameters<typeof WidgetModal>[0]> = {}) {
  return render(
    <WidgetModal
      widget={WIDGET}
      onClose={() => {}}
      onOpenSub={() => {}}
      range="month"
      periodLabel="Juli"
      history={MONTH_HISTORY}
      {...over}
    />,
  );
}

describe('WidgetModal (v3.2 M2 · Werte + Verlauf in EINER Ansicht)', () => {
  it('portalisiert nach document.body (die Host-Karte klippt sonst)', () => {
    const { container } = open();
    expect(container.querySelector('.vp-wmodal')).toBeNull();
    expect(document.body.querySelector('.vp-wmodal')).toBeTruthy();
  });

  it('zeigt die Werte-Zeilen (dieselben Zahlen wie die Kachel) — nie eine 0', () => {
    open();
    const values = [...document.body.querySelectorAll('.vp-wmodal-row-value')].map(
      (n) => n.textContent,
    );
    expect(values[0]).toContain('2,1 kW');
    expect(values[1]).toBe('—');
  });

  it('hat KEINEN Jetzt/Verlauf-Umschalter mehr', () => {
    open();
    expect(document.body.querySelector('.vp-wmodal-seg')).toBeNull();
    expect(document.body.querySelector('.vp-wmodal-segbtn')).toBeNull();
  });

  it('rendert den Verlauf GEMEINSAM mit den Werten, wenn Historie vorliegt', () => {
    open();
    // Werte UND Verlauf im selben Modal.
    expect(document.body.querySelector('.vp-wmodal-rows')).toBeTruthy();
    const verlauf = document.body.querySelector('.vp-wmodal-verlauf');
    expect(verlauf).toBeTruthy();
    // Das Diagramm ist da (der geteilte Chart-Container).
    expect(document.body.querySelector('.vp-chart-modal')).toBeTruthy();
    // Die Überschrift trägt das Periodenetikett.
    expect(verlauf?.querySelector('.vp-wmodal-verlauf-title')?.textContent).toBe('Verlauf · Juli');
    // Kein „kein Verlauf"-Satz, wenn Daten da sind.
    expect(document.body.querySelector('.vp-wmodal-noverlauf')).toBeNull();
  });

  it('folgt dem gewählten Zeitraum — die Überschrift trägt das Etikett', () => {
    const day = history('day', [
      bucket('2026-07-20T09:00:00Z', { gridImportKwh: 1, gridExportKwh: 0 }),
    ]);
    open({ range: 'day', periodLabel: 'Heute', history: day });
    expect(document.body.querySelector('.vp-wmodal-verlauf-title')?.textContent).toBe(
      'Verlauf · Heute',
    );
    expect(document.body.querySelector('.vp-chart-modal')).toBeTruthy();
  });

  it('zeigt „kein Verlauf" statt eines erfundenen Diagramms, wenn keine Historie da ist', () => {
    open({ history: null });
    expect(document.body.querySelector('.vp-chart-modal')).toBeNull();
    const note = document.body.querySelector('.vp-wmodal-noverlauf');
    expect(note).toBeTruthy();
    expect(note?.textContent).toContain('noch kein Verlauf');
  });

  it('nennt „Gesamt" ehrlich beim Namen (kein All-Zeit-Verlauf)', () => {
    open({ range: 'all', periodLabel: 'Gesamt', history: null });
    expect(document.body.querySelector('.vp-chart-modal')).toBeNull();
    expect(document.body.querySelector('.vp-wmodal-noverlauf')?.textContent).toContain('Gesamt');
  });

  it('bietet den Absprung in die Tiefen-Sicht an', () => {
    const onOpenSub = vi.fn();
    open({ onOpenSub });
    fireEvent.click(document.body.querySelector('.vp-wmodal-drill') as HTMLButtonElement);
    expect(onOpenSub).toHaveBeenCalledWith('historie');
  });

  it('nimmt den migrierten Block-Körper als Zusatz auf', () => {
    open({ extra: <p className="probe">Peak-Band</p> });
    expect(document.body.querySelector('.probe')).toBeTruthy();
  });

  it('schließt über den Knopf und über Escape', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(document.body.querySelector('.vp-wmodal-close') as HTMLButtonElement);
    expect(onClose).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBeGreaterThan(1);
  });

  it('zeigt für eine Kachel OHNE Verlauf-Kennzahl kein Diagramm (Automatik)', () => {
    const automatik: WidgetDef = {
      ...WIDGET,
      id: 'automatik',
      label: 'Geräte-Automatik',
      modal: {
        jetzt: { rows: [{ label: 'Regel', value: 'aktiv' }], note: null, drillIn: null },
        verlauf: { rows: [], note: null, drillIn: { sub: 'steuerung', label: 'Steuerung öffnen' } },
      },
    };
    open({ widget: automatik });
    // Kein Metrik-Diagramm, aber die Werte + der Absprung bleiben.
    expect(document.body.querySelector('.vp-wmodal-verlauf')).toBeNull();
    expect(document.body.querySelector('.vp-wmodal-rows')).toBeTruthy();
    expect(document.body.querySelector('.vp-wmodal-drill')).toBeTruthy();
  });
});
