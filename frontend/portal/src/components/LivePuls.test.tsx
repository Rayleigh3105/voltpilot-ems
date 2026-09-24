import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LivePulsRow } from '../livePuls';
import { LivePuls } from './LivePuls';

const ROWS: LivePulsRow[] = [
  {
    key: 'pv', role: 'pv', icon: 'sun', title: 'PV-Erzeugung', value: '14,1 kW',
    stateLabel: 'liefert', stateTone: 'accent', health: 'ok',
    target: { entityId: 'e-pv', channel: 'pv_power_kw' }, today: null,
  },
  {
    key: 'haus', role: 'consumer', icon: 'home', title: 'Hausverbrauch', value: '14,1 kW',
    stateLabel: 'verbraucht', stateTone: 'accent', health: 'ok',
    target: { entityId: 'e-haus', channel: 'power_kw' }, today: null,
  },
];

function fold(open: boolean, onToggle = () => {}) {
  return {
    key: 'haus',
    open,
    onToggle,
    label: 'Zusammensetzung des Verbrauchs',
    panel: <div data-testid="panel">Zusammensetzung</div>,
  };
}

describe('LivePuls · die aufklappbare Zeile', () => {
  it('ohne `fold` rendert das Board Zeichen für Zeichen wie vorher', () => {
    const { container } = render(<LivePuls rows={ROWS} onOpenVerlauf={() => {}} />);
    // Genau eine Schaltfläche je Zeile - kein zweites Ziel, kein Wrapper.
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelectorAll('.vp-puls-rowwrap')).toHaveLength(0);
    expect(container.querySelectorAll('.vp-puls-go')).toHaveLength(2);
  });

  it('der Zeilen-Klick bleibt der Verlauf, das Aufklappen ist ein EIGENER Knopf', () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(<LivePuls rows={ROWS} onOpenVerlauf={onOpen} fold={fold(false, onToggle)} />);

    // ⚠ Kein `<button>` im `<button>`: die zwei Ziele stehen nebeneinander.
    const zeile = screen.getByTitle('Hausverbrauch');
    expect(zeile.querySelector('button')).toBeNull();
    // …und die Zeile trägt dann NICHT auch noch ihr eigenes Chevron: zwei
    // Pfeile nebeneinander wären zwei Versprechen für zwei verschiedene Wege.
    expect(zeile.querySelector('.vp-puls-go')).toBeNull();

    fireEvent.click(zeile);
    expect(onOpen).toHaveBeenCalledWith({ entityId: 'e-haus', channel: 'power_kw' });
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Zusammensetzung des Verbrauchs anzeigen/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('das Panel steht erst nach dem Aufklappen da - und als GESCHWISTER der Zeile', () => {
    const zu = render(<LivePuls rows={ROWS} onOpenVerlauf={() => {}} fold={fold(false)} />);
    expect(zu.queryByTestId('panel')).toBeNull();
    zu.unmount();

    const { container } = render(
      <LivePuls rows={ROWS} onOpenVerlauf={() => {}} fold={fold(true)} />,
    );
    const panel = screen.getByTestId('panel');
    expect(panel).toBeInTheDocument();
    // Nicht Kind der Zeile: es liegt neben ihrem Wrapper in der Zeilen-Liste.
    expect(panel.closest('.vp-puls-rowwrap')).toBeNull();
    expect(panel.parentElement).toBe(container.querySelector('.vp-puls-rows'));
    expect(
      screen.getByRole('button', { name: /Zusammensetzung des Verbrauchs schließen/ }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('klappt nur die EINE genannte Zeile auf', () => {
    const { container } = render(
      <LivePuls rows={ROWS} onOpenVerlauf={() => {}} fold={fold(true)} />,
    );
    expect(container.querySelectorAll('.vp-puls-fold')).toHaveLength(1);
    expect(container.querySelectorAll('.vp-puls-rowwrap')).toHaveLength(1);
  });
});

describe('LivePuls · die Heute-Spalte der Netz-Zeile', () => {
  const netz: LivePulsRow = {
    key: 'netz', role: 'grid', icon: 'zap', title: 'Netz', value: '0,0 kW',
    stateLabel: 'ausgeglichen', stateTone: 'muted', health: 'ok',
    target: { entityId: 'e-netz', channel: 'power_kw' },
    today: [
      { text: '5,2 kWh', arrow: 'down', word: 'Einspeisung' },
      { text: '8,7 kWh', arrow: 'up', word: 'Bezug' },
    ],
  };

  it('nennt Bezug und Einspeisung SICHTBAR - ein Pfeil allein ist keine Richtung', () => {
    const { container } = render(<LivePuls rows={[netz]} onOpenVerlauf={() => {}} />);
    const zeilen = [...container.querySelectorAll('.vp-puls-today-line')];
    expect(zeilen.map((z) => z.textContent)).toEqual(['Einspeisung5,2 kWh', 'Bezug8,7 kWh']);
    expect(zeilen.map((z) => z.getAttribute('aria-label'))).toEqual([
      'Einspeisung 5,2 kWh',
      'Bezug 8,7 kWh',
    ]);
    // Das Wort ERSETZT den Pfeil - zwei Träger derselben Richtung wären Rauschen.
    expect(container.querySelector('.vp-puls-today-line svg')).toBeNull();
  });

  it('eine Zeile ohne Wort behält ihren Pfeil', () => {
    const row = { ...netz, today: [{ text: '1,0 kWh', arrow: 'up' as const }] };
    const { container } = render(<LivePuls rows={[row]} onOpenVerlauf={() => {}} />);
    expect(container.querySelector('.vp-puls-today-line svg')).not.toBeNull();
  });
});
