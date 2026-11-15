import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ladeSummenwertAssistent, useSummenwertAssistent } from './useSummenwertAssistent';

/**
 * Der Summenwert-Assistent kommt mit dem Klick (Performance Welle 3): vor dem Öffnen steht nichts von ihm auf der
 * Seite, nach dem Öffnen derselbe Dialog wie vorher - mit Titel, Gerät und Schließen.
 */
function Karte() {
  const { oeffneSummenwertAssistent, assistent } = useSummenwertAssistent();
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          oeffneSummenwertAssistent({ siteId: 's1', geraetName: 'Wechselrichter', kontext: { art: 'geraet', boxId: 'b1', geraetId: 'g1' } })
        }
      >
        öffnen
      </button>
      {assistent}
    </div>
  );
}

// Das nachgeladene Stück vorab holen (wie die Seiten-Tests): unter Last reißt ein kalter Import sonst die 5-s-Grenze.
beforeAll(() => ladeSummenwertAssistent(), 60_000);
afterEach(() => vi.restoreAllMocks());

it('vor dem Öffnen kein Dialog; das Öffnen lädt ihn nach und zeigt den Assistenten wie bisher', async () => {
  const quellen = vi.spyOn(api, 'summenwertQuellen').mockResolvedValue([]);
  render(<Karte />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(quellen).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'öffnen' }));

  expect(await screen.findByRole('dialog', { name: /Wechselrichter/ }, { timeout: 10_000 })).toBeVisible();
  await waitFor(() => expect(quellen).toHaveBeenCalledWith('s1', { art: 'geraet', boxId: 'b1', geraetId: 'g1' }));
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  });
});

it('das Vorladen holt dasselbe Stück, das der Klick öffnet', async () => {
  const m = await ladeSummenwertAssistent();
  expect(typeof m.SummenwertAssistent).toBe('function');
});
