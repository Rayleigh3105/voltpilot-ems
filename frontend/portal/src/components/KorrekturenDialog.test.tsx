import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { FIXTURE_IDS } from '../test/standorteFixtures';
import { korrekturDetail } from '../test/korrekturFixtures';
import { KorrekturenDialog } from './KorrekturenDialog';
afterEach(() => vi.restoreAllMocks());
beforeEach(() => setSelbstauskunft(rechteSeed('JW').me));
async function zeigen(ersteller = false) {
  const k = korrekturDetail(ersteller);
  vi.spyOn(api, 'korrekturen').mockResolvedValue([k]); vi.spyOn(api, 'korrektur').mockResolvedValue(k);
  render(<KorrekturenDialog standort={FIXTURE_IDS.st1} zone="Europe/Berlin" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /K-2026-0007/ }));
  await screen.findByText(/Erstellt von Ines/); return k;
}
describe('Korrektur-Prüfung', () => {
  it('Ersteller liest die Ursache der Vier-Augen-Sperre', async () => {
    await zeigen(true);
    expect(screen.getByText(/zweite Person erforderlich/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Freigeben', exact: true })).toBeNull();
  });
  it('ein ungültiger Grund verhindert Schreiben und erhält die Eingabe', async () => {
    const frei = vi.spyOn(api, 'korrekturFreigeben'); await zeigen();
    fireEvent.change(screen.getByLabelText('Begründung der Entscheidung'), { target: { value: 'kurz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Freigeben', exact: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('10 bis 500'); expect(frei).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Begründung der Entscheidung')).toHaveFocus());
  });
  it('verhindert doppeltes Freigeben bei ausstehender Antwort', async () => {
    let antwort!: () => void;
    const frei = vi.spyOn(api, 'korrekturFreigeben').mockImplementation(() => new Promise<void>(r => { antwort = r; }));
    await zeigen(); const b = screen.getByRole('button', { name: 'Freigeben', exact: true });
    fireEvent.click(b); fireEvent.click(b); expect(frei).toHaveBeenCalledTimes(1);
    vi.mocked(api.korrektur).mockResolvedValue(korrekturDetail(false, 'freigegeben'));
    antwort(); await screen.findByLabelText('Grund für den Widerruf');
  });
  it('erhält bei 403 die Begründung und nennt den Fehler', async () => {
    vi.spyOn(api, 'korrekturFreigeben').mockRejectedValue(new ApiError(403, 'Freigabe durch eine zweite Person erforderlich.', {}));
    await zeigen(); fireEvent.click(screen.getByRole('button', { name: 'Freigeben', exact: true }));
    await screen.findByRole('alert'); expect(screen.getByLabelText('Begründung der Entscheidung')).toHaveValue(korrekturDetail().begruendung);
  });
});
