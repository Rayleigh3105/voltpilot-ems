import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UmzugMerkzettelKarte } from './UmzugMerkzettelKarte';
import type { UmzugMerkzettel } from '../api';
import { api } from '../apiVoll';

/**
 * Der Merkzettel "Neues Haus? Bitte prüfen" (§7, Bericht 6.6 Punkt 7), geteilt zwischen dem
 * Umzug-Ergebnis (`AnlageOrtBlatt`) und "Meine Anlage" (`AnlageTechnik`). "Geprüft" und
 * "weggeklickt" sind dieselbe Handlung.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function merkzettel(over: Partial<UmzugMerkzettel> = {}): UmzugMerkzettel {
  return {
    seit: '2026-11-27T10:00:00Z',
    solaranlageErledigt: false,
    stromtarifErledigt: false,
    einspeiseverguetungErledigt: false,
    ...over,
  };
}

describe('UmzugMerkzettelKarte', () => {
  it('zeigt nur die noch offenen Teile', () => {
    render(
      <UmzugMerkzettelKarte
        siteId="s-1"
        merkzettel={merkzettel({ stromtarifErledigt: true })}
        onGeaendert={() => {}}
      />,
    );
    expect(screen.getByText('Neues Haus? Bitte prüfen')).toBeInTheDocument();
    expect(screen.getByText('Solaranlage')).toBeInTheDocument();
    expect(screen.queryByText('Stromtarif')).toBeNull();
    expect(screen.getByText('Einspeisevergütung')).toBeInTheDocument();
  });

  it('zeigt nichts, wenn schon alle drei erledigt sind', () => {
    const { container } = render(
      <UmzugMerkzettelKarte
        siteId="s-1"
        merkzettel={merkzettel({ solaranlageErledigt: true, stromtarifErledigt: true, einspeiseverguetungErledigt: true })}
        onGeaendert={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ein Tipp erledigt nur diesen Teil und meldet den Rest zurück', async () => {
    const erledigen = vi.spyOn(api, 'umzugMerkzettelErledigen').mockResolvedValue(undefined);
    const onGeaendert = vi.fn();
    render(<UmzugMerkzettelKarte siteId="s-1" merkzettel={merkzettel()} onGeaendert={onGeaendert} />);

    fireEvent.click(screen.getByRole('button', { name: 'Stromtarif: geprüft' }));

    await waitFor(() => expect(erledigen).toHaveBeenCalledWith('s-1', 'stromtarif'));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalledWith(merkzettel({ stromtarifErledigt: true })));
  });

  it('der letzte offene Teil meldet null zurück (die Karte verschwindet)', async () => {
    vi.spyOn(api, 'umzugMerkzettelErledigen').mockResolvedValue(undefined);
    const onGeaendert = vi.fn();
    render(
      <UmzugMerkzettelKarte
        siteId="s-1"
        merkzettel={merkzettel({ solaranlageErledigt: true, stromtarifErledigt: true })}
        onGeaendert={onGeaendert}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Einspeisevergütung: geprüft' }));

    await waitFor(() => expect(onGeaendert).toHaveBeenCalledWith(null));
  });
});
