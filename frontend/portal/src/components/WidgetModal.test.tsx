import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { WidgetModal } from './WidgetModal';
import type { WidgetDef } from '../cockpitWidgets';

/** Portal v3 · M2 — der dünne Render-Beweis des Widget-Modals. */

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
      note: 'Der Rückblick liegt in der Historie.',
      drillIn: { sub: 'historie', label: 'Historie öffnen' },
    },
  },
};

function open(over: Partial<Parameters<typeof WidgetModal>[0]> = {}) {
  return render(
    <WidgetModal widget={WIDGET} onClose={() => {}} onOpenSub={() => {}} {...over} />,
  );
}

describe('WidgetModal', () => {
  it('portalisiert nach document.body (die Host-Karte klippt sonst)', () => {
    const { container } = open();
    expect(container.querySelector('.vp-wmodal')).toBeNull();
    expect(document.body.querySelector('.vp-wmodal')).toBeTruthy();
  });

  it('startet auf „Jetzt" und zeigt dieselben Zahlen wie die Kachel', () => {
    open();
    const values = [...document.body.querySelectorAll('.vp-wmodal-row-value')].map(
      (n) => n.textContent,
    );
    expect(values[0]).toContain('2,1 kW');
    // Ein nicht berechenbarer Wert bleibt „—", nie eine 0.
    expect(values[1]).toBe('—');
  });

  it('schaltet auf „Verlauf" und bietet dort den Absprung an', () => {
    const onOpenSub = vi.fn();
    open({ onOpenSub });
    const segs = [...document.body.querySelectorAll('.vp-wmodal-segbtn')];
    fireEvent.click(segs[1]);
    expect(document.body.textContent).toContain('Der Rückblick liegt in der Historie.');
    fireEvent.click(document.body.querySelector('.vp-wmodal-drill') as HTMLButtonElement);
    expect(onOpenSub).toHaveBeenCalledWith('historie');
  });

  it('schließt über den Knopf und über Escape', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.click(document.body.querySelector('.vp-wmodal-close') as HTMLButtonElement);
    expect(onClose).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBeGreaterThan(1);
  });

  it('nimmt den migrierten Block-Körper als „Jetzt"-Zusatz auf', () => {
    open({ jetztExtra: <p className="probe">Peak-Band</p> });
    expect(document.body.querySelector('.probe')).toBeTruthy();
    fireEvent.click([...document.body.querySelectorAll('.vp-wmodal-segbtn')][1]);
    expect(document.body.querySelector('.probe')).toBeNull();
  });
});
