import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SteuerungIntro } from './SteuerungIntro';
import { STEUERUNG_INTRO_KEY } from '../steuerungIntro';
import type { CockpitLayoutDocument } from '../cockpitLayout';

const LEER: CockpitLayoutDocument = { order: [], hidden: [], shown: [], lead: null };

function quelle(doc: CockpitLayoutDocument | null, merken = vi.fn().mockResolvedValue({})) {
  return { quelle: { laden: () => Promise.resolve(doc), merken }, merken };
}

describe('SteuerungIntro (Stufe 8)', () => {
  it('zeigt die drei Sätze, solange er nicht weggeklickt wurde', async () => {
    render(<SteuerungIntro {...quelle(LEER)} />);
    expect(await screen.findByText(/Drei Zonen/)).toBeInTheDocument();
    expect(screen.getByText(/Jetzt zeigt/)).toBeInTheDocument();
    expect(screen.getByText(/Regeln sind Ihre Wünsche/)).toBeInTheDocument();
    expect(screen.getByText(/Betriebsmodelle sind die Betriebsweise/)).toBeInTheDocument();
  });

  it('eine gesetzte Marke lässt ihn GAR NICHT rendern', async () => {
    const { container } = render(
      <SteuerungIntro {...quelle({ ...LEER, seen: [STEUERUNG_INTRO_KEY] })} />,
    );
    await waitFor(() => expect(container.querySelector('.vp-steuerung-intro')).toBeNull());
    expect(screen.queryByText(/Drei Zonen/)).toBeNull();
  });

  it('der Klick blendet ihn sofort aus UND merkt ihn kunden-weit', async () => {
    const { quelle: q, merken } = quelle(LEER);
    render(<SteuerungIntro quelle={q} />);
    await screen.findByText(/Drei Zonen/);
    fireEvent.click(screen.getByRole('button', { name: 'Verstanden' }));
    expect(screen.queryByText(/Drei Zonen/)).toBeNull();
    await waitFor(() => expect(merken).toHaveBeenCalledTimes(1));
    expect(merken.mock.calls[0][0].seen).toEqual([STEUERUNG_INTRO_KEY]);
  });

  it('ein gescheitertes Merken lässt ihn trotzdem verschwinden (fail-soft)', async () => {
    const merken = vi.fn().mockRejectedValue(new Error('offline'));
    render(<SteuerungIntro quelle={{ laden: () => Promise.resolve(LEER), merken }} />);
    await screen.findByText(/Drei Zonen/);
    fireEvent.click(screen.getByRole('button', { name: 'Verstanden' }));
    expect(screen.queryByText(/Drei Zonen/)).toBeNull();
  });

  it('ohne Antwort (älteres Backend) behauptet er NICHTS und rendert nicht', async () => {
    const merken = vi.fn();
    const { container } = render(
      <SteuerungIntro quelle={{ laden: () => Promise.reject(new Error('404')), merken }} />,
    );
    await waitFor(() => expect(container.querySelector('.vp-steuerung-intro')).toBeNull());
    expect(merken).not.toHaveBeenCalled();
  });
});
