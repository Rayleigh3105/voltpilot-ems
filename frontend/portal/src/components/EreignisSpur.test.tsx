import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EreignisChip, EreignisSpurView } from '../historieEreignisse';
import { EREIGNIS_ARTEN } from '../historieEreignisse';
import { EreignisSpur } from './EreignisSpur';

/** Render-only: die Regeln stehen in `historieEreignisse.test.ts`. */

function chip(o: Partial<EreignisChip> = {}): EreignisChip {
  const art = o.art ?? 'negativpreis';
  return {
    key: `${art}-${o.zeit ?? '15.07.'}`,
    art,
    info: EREIGNIS_ARTEN[art],
    zeit: '15.07.',
    text: 'Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh',
    titel: '15.07. · Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh',
    vonIndex: 14,
    bisIndex: 15,
    sprungAt: '2026-07-15',
    ...o,
  };
}

function spur(o: Partial<EreignisSpurView> = {}): EreignisSpurView {
  const chips = o.chips ?? [chip()];
  return {
    chips,
    leerText: chips.length === 0 ? 'Keine besonderen Ereignisse in diesem Zeitraum.' : null,
    hinweis: null,
    arten: [...new Set(chips.map((c) => c.art))].map((art) => ({
      art,
      info: EREIGNIS_ARTEN[art],
    })),
    ...o,
  };
}

describe('EreignisSpur', () => {
  it('zeigt Zeit und Grund und öffnet auf Klick den Tag', () => {
    const onTagOeffnen = vi.fn();
    render(<EreignisSpur spur={spur()} onTagOeffnen={onTagOeffnen} />);

    expect(screen.getByText('15.07.')).toBeInTheDocument();
    expect(
      screen.getByText('Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Negative Börsenpreise/ }));
    expect(onTagOeffnen).toHaveBeenCalledWith('2026-07-15');
  });

  it('ist ohne Sprungziel ruhige Information statt eines toten Knopfes', () => {
    render(<EreignisSpur spur={spur({ chips: [chip({ sprungAt: null })] })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('klappt jenseits der ersten vier Chips zusammen und zeigt auf Wunsch alle', () => {
    const chips = ['negativpreis', 'abregelung', 'netzgrenze', 'netzladen', 'datenluecke'].map(
      (art, i) =>
        chip({ art: art as EreignisChip['art'], zeit: `0${i + 1}.07.`, text: `Ereignis ${i}` }),
    );
    render(<EreignisSpur spur={spur({ chips })} />);

    expect(screen.queryByText('Ereignis 4')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 weitere anzeigen' }));
    expect(screen.getByText('Ereignis 4')).toBeInTheDocument();
  });

  it('sagt eine leere Spur ausdrücklich an, statt gar nichts zu zeigen', () => {
    render(<EreignisSpur spur={spur({ chips: [] })} />);
    expect(
      screen.getByText('Keine besonderen Ereignisse in diesem Zeitraum.'),
    ).toBeInTheDocument();
  });

  it('rendert den Zeitraum-Hinweis und den Protokoll-Verweis, wenn es sie gibt', () => {
    render(
      <EreignisSpur
        spur={spur({ hinweis: 'Die Netzgrenze (§ 14a) wird für Tag und Woche ausgewertet.' })}
        protokollHinweis="Den ganzen Tag in Sätzen finden Sie unten im Tagesprotokoll."
      />,
    );
    expect(screen.getByText(/Netzgrenze/)).toBeInTheDocument();
    expect(screen.getByText(/Tagesprotokoll/)).toBeInTheDocument();
  });
});
