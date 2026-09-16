import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ahrenbergRegister } from '../test/messstellenRegisterFixtures';
import { MessstelleSeite } from './MessstelleSeite';

/**
 * UEMS AP-13 IP-11 (D1) — eine Adresse aus einer Herkunfts-Zeile nennt das KENNZEICHEN (`…/messstellen/MS-12`),
 * nie eine UUID: in der Herkunft einer Kennzahl, eines Berichts und einer berechneten Zahl steht genau das.
 * Die Seite löst es an EINER Stelle auf — sonst führte jeder Sprung der Kette auf eine 400.
 */
describe('MessstelleSeite · das Kennzeichen in der Adresse (AP-13 IP-11)', () => {
  afterEach(() => vi.restoreAllMocks());

  const register = ahrenbergRegister();
  const ms12 = register.register.find((z) => z.kennzeichen === 'MS-12')!;

  it('löst MS-12 über das Register auf und lädt danach MIT der ID — nie mit dem Kennzeichen', async () => {
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(register);
    const eine = vi.spyOn(api, 'messstelle').mockRejectedValue(new Error('nicht Teil dieser Prüfung'));
    vi.spyOn(api, 'messstelleProzesse').mockRejectedValue(new Error('—'));
    vi.spyOn(api, 'messstelleVerteilung').mockRejectedValue(new Error('—'));
    render(<MessstelleSeite id="MS-12" onListe={() => undefined} />);
    await waitFor(() => expect(eine).toHaveBeenCalled());
    expect(eine.mock.calls[0][0]).toBe(ms12.id);
    expect(eine.mock.calls.some((c) => c[0] === 'MS-12')).toBe(false);
  });

  it('ein unbekanntes Kennzeichen sagt „gibt es nicht“ — kein leerer Bildschirm und keine Anfrage mit MS-99', async () => {
    vi.spyOn(api, 'messstellenRegister').mockResolvedValue(register);
    const eine = vi.spyOn(api, 'messstelle').mockRejectedValue(new Error('—'));
    render(<MessstelleSeite id="MS-99" onListe={() => undefined} />);
    expect(await screen.findByText(/gibt es nicht|nicht gefunden/i)).toBeInTheDocument();
    expect(eine).not.toHaveBeenCalled();
  });

  it('eine ID in der Adresse geht wie bisher direkt durch — kein zusätzlicher Umweg über das Register', async () => {
    const liste = vi.spyOn(api, 'messstellenRegister').mockResolvedValue(register);
    const eine = vi.spyOn(api, 'messstelle').mockRejectedValue(new Error('—'));
    vi.spyOn(api, 'messstelleProzesse').mockRejectedValue(new Error('—'));
    vi.spyOn(api, 'messstelleVerteilung').mockRejectedValue(new Error('—'));
    render(<MessstelleSeite id={ms12.id} onListe={() => undefined} />);
    await waitFor(() => expect(eine).toHaveBeenCalledWith(ms12.id));
    // Das Register liest die Seite ohnehin für Zustand und Quelle — aber nicht ZWEIMAL.
    expect(liste.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
