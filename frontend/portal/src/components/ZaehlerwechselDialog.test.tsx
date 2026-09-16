import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from '../test/standorteFixtures';
import { vorherEinstellungen, vorherGeraet, wechselAntwort, wechselKanaele, WECHSEL_JETZT } from '../test/zaehlerwechselFixtures';
import { ZaehlerwechselDialog } from './ZaehlerwechselDialog';

afterEach(() => vi.restoreAllMocks());
function zeigen(art: 'geraet' | 'messstelle' = 'messstelle') {
  vi.spyOn(api, 'uemsGeraete').mockResolvedValue({ geraete: [vorherGeraet()] });
  vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
  vi.spyOn(api, 'datenquellen').mockResolvedValue({ datenquellen: [] });
  vi.spyOn(api, 'geraetEinstellungen').mockResolvedValue(vorherEinstellungen());
  vi.spyOn(api, 'komponenteMesskanaele').mockResolvedValue(wechselKanaele());
  const schreiben = vi.spyOn(api, 'messstelleZaehlerwechsel').mockResolvedValue(wechselAntwort());
  const austausch = vi.spyOn(api, 'geraetAustauschen').mockResolvedValue(wechselAntwort());
  const onGewechselt = vi.fn();
  render(<ZaehlerwechselDialog ziel={art === 'messstelle'
    ? { art, id: 'ms06', kennzeichen: 'MS-06', geraetId: 'g-z5a', anlageId: FIXTURE_IDS.an1 }
    : { art, geraet: vorherGeraet(), anlageId: FIXTURE_IDS.an1 }} jetzt={WECHSEL_JETZT} onClose={vi.fn()} onGewechselt={onGewechselt} />);
  return { schreiben, austausch, onGewechselt };
}
async function ausfuellen() {
  await screen.findByLabelText('Seriennummer (optional)');
  fireEvent.change(screen.getByLabelText('Seriennummer (optional)'), { target: { value: '88231' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Uhrzeit' }), { target: { value: '10:40' } });
  fireEvent.blur(screen.getByRole('combobox', { name: 'Uhrzeit' }));
  fireEvent.change(screen.getByLabelText('Endstand bisheriger Zähler (kWh)'), { target: { value: '1.083.415,2' } });
  fireEvent.change(screen.getByLabelText('Anfangsstand neuer Zähler (kWh)'), { target: { value: '0,0' } });
}
describe('Zählerwechsel als ein Vorgang', () => {
  it.each(['messstelle', 'geraet'] as const)('%s: schreibt erst nach der Folgen-Karte und genau einmal', async art => {
    const spies = zeigen(art); await ausfuellen();
    fireEvent.click(screen.getByRole('button', { name: 'Folgen prüfen' }));
    expect(screen.getByRole('region', { name: 'Folgen des Zählerwechsels' })).toHaveTextContent('rückwirkend (25 min)');
    expect(spies.schreiben).not.toHaveBeenCalled(); expect(spies.austausch).not.toHaveBeenCalled();
    const speichern = screen.getByRole('button', { name: 'Zählerwechsel eintragen' });
    fireEvent.click(speichern); fireEvent.click(speichern);
    await screen.findByRole('status', { name: 'Gespeicherte Folgen' });
    const send = art === 'messstelle' ? spies.schreiben : spies.austausch;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ zeitpunkt: '2026-11-18T10:40:00+01:00', neues_geraet: { seriennummer: '88231' },
      endstand_vorgaenger: { wert: 1083415.2, einheit: 'kWh' } });
    expect(spies.onGewechselt).toHaveBeenCalledWith(wechselAntwort());
  });
  it('sperrt rückwirkend bei fehlendem Zusatzrecht und reagiert auf Rechteentzug', async () => {
    zeigen(); await ausfuellen();
    const seed = rechteSeed().me;
    const ohne = { ...seed, unternehmen_rechte: seed.unternehmen_rechte.filter(r => r !== 'aenderung.rueckwirkend'),
      standorte: seed.standorte.map(s => ({ ...s, rechte: s.rechte.filter(r => r !== 'aenderung.rueckwirkend') })) };
    act(() => setSelbstauskunft(ohne));
    expect(screen.getByRole('button', { name: 'Folgen prüfen' })).toBeDisabled();
  });
  it('behält Eingaben bei Ablehnung und erlaubt eine gezielte Korrektur', async () => {
    const { schreiben } = zeigen(); schreiben.mockRejectedValue(new Error('Der Zeitpunkt liegt vor dem Einbau.'));
    await ausfuellen(); fireEvent.click(screen.getByRole('button', { name: 'Folgen prüfen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zählerwechsel eintragen' }));
    await screen.findByText('Der Zeitpunkt liegt vor dem Einbau.');
    expect(screen.getByRole('alert')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    expect(screen.getByLabelText('Seriennummer (optional)')).toHaveValue('88231');
  });
  it('fokussiert einen unzulässigen Ablesestand', async () => {
    zeigen(); await ausfuellen();
    const feld = screen.getByLabelText('Endstand bisheriger Zähler (kWh)');
    fireEvent.change(feld, { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Folgen prüfen' }));
    await waitFor(() => expect(feld).toHaveFocus());
  });
});
