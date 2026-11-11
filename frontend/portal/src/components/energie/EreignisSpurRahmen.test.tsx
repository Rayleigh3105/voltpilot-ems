import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { History, HistoryEvent } from '../../api';
import { ereignisChronik, ereignisSpur, type EreignisZelle } from '../../historieEreignisse';
import { EreignisSpurRahmen } from './EreignisSpurRahmen';

// jsdom misst keine Breite — die Spur bekommt eine feste Zeichenfläche.
vi.mock('../../useContainerWidth', () => ({ useContainerWidth: () => [{ current: null }, 800] }));

const lokal = (d: number, h = 0) => new Date(2026, 9, d, h).toISOString();
const oktober: EreignisZelle[] = Array.from({ length: 31 }, (_, i) => ({
  start: new Date(2026, 9, 1 + i),
  ende: new Date(2026, 9, 2 + i),
}));

function gruppen(events: HistoryEvent[]) {
  const h = { range: 'month', from: '', to: '', bucketMinutes: 1440, buckets: [], totals: {}, protocol: [], plan: [], events } as unknown as History;
  return ereignisChronik(ereignisSpur(h)!, 'month');
}

const EREIGNISSE: HistoryEvent[] = [
  { type: 'negativpreis', start: lokal(10, 13), end: lokal(10, 14), text: '…', value: -0.04, unit: 'ct/kWh' },
  { type: 'datenluecke', start: lokal(7, 10), end: lokal(7, 11), text: '…', value: null },
  { type: 'negativpreis', start: lokal(4, 12), end: lokal(4, 13), text: '…', value: -2.4, unit: 'ct/kWh' },
];

function spur(o: { filter?: 'negativpreis' | null; onOeffnen?: (s: unknown) => void; onFokus?: (f: unknown) => void } = {}) {
  return render(
    <EreignisSpurRahmen
      gruppen={gruppen(EREIGNISSE)}
      zellen={oktober}
      art="bilanz"
      filter={o.filter ?? null}
      fokus={null}
      onFokus={o.onFokus ?? vi.fn()}
      onOeffnen={o.onOeffnen}
    >
      <div data-testid="diagramm" />
    </EreignisSpurRahmen>,
  );
}

describe('EreignisSpurRahmen', () => {
  it('legt je Art eine Bahn an — in kanonischer Reihenfolge — und setzt die Marke unter ihren Tag', () => {
    const { container } = spur({ onOeffnen: vi.fn() });
    expect(screen.getByTestId('diagramm')).toBeInTheDocument();
    const bahnen = [...container.querySelectorAll('.vp-vr-spur-bahn')];
    expect(bahnen.map((b) => b.className)).toEqual([
      'vp-vr-spur-bahn is-markt',
      'vp-vr-spur-bahn is-daten',
    ]);
    // Zeichenfläche 800 - 56 - 12 = 732 px, 31 Bänder; der 10.10. ist Band 9.
    const marke = screen.getByRole('button', { name: /Samstag, 10\.10\./ }) as HTMLElement;
    const band = 732 / 31;
    const left = parseFloat(marke.style.left);
    const width = parseFloat(marke.style.width);
    expect(left).toBeGreaterThanOrEqual(56 + 9 * band);
    expect(left + width).toBeLessThanOrEqual(56 + 10 * band);
  });

  it('öffnet mit einer Marke ihren Tag und meldet den Fokus', () => {
    const onOeffnen = vi.fn();
    const onFokus = vi.fn();
    spur({ onOeffnen, onFokus });
    const marke = screen.getByRole('button', { name: /Mittwoch, 07\.10\.: Datenlücke/ });
    fireEvent.mouseEnter(marke);
    expect(onFokus).toHaveBeenCalledWith({ key: '2026-10-07', art: 'datenluecke' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Mittwoch, 07.10.');
    fireEvent.click(marke);
    expect(onOeffnen).toHaveBeenCalledWith({ range: 'day', at: '2026-10-07' });
  });

  it('lässt bei einem Filter die übrigen Bahnen zurücktreten', () => {
    const { container } = spur({ filter: 'negativpreis' });
    expect(container.querySelector('.vp-vr-spur-bahn.is-daten')).toHaveClass('is-gedimmt');
    expect(container.querySelector('.vp-vr-spur-bahn.is-markt')).not.toHaveClass('is-gedimmt');
  });

  it('zeichnet ohne Ereignisse keine Spur, nur das Diagramm', () => {
    const { container } = render(
      <EreignisSpurRahmen gruppen={[]} zellen={oktober} art="bilanz" filter={null} fokus={null} onFokus={vi.fn()}>
        <div data-testid="diagramm" />
      </EreignisSpurRahmen>,
    );
    expect(screen.getByTestId('diagramm')).toBeInTheDocument();
    expect(container.querySelector('.vp-vr-spur')).toBeNull();
  });
});
