import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { ahrenbergBezugsgroessen } from '../test/kennzahlAnlegenFixtures';
import { bezugswert, gasAblesungen } from '../test/werteEingabeFixtures';
import { BezugswertDialog } from './BezugswertDialog';
import { AblesungDialog } from './AblesungDialog';
import { Ablesungen } from './Ablesungen';
const bezug = ahrenbergBezugsgroessen().bezugsgroessen.find(b => b.kennzeichen === 'BZ-2')!;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T10:00:00Z')); setSelbstauskunft(rechteSeed('JW').me); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('sendet die Berichtigung nur mit Begründung und unverändertem Textbetrag', async () => {
  const speichern = vi.spyOn(api, 'bezugswertBerichtigen').mockResolvedValue({ urteil: 'vorschlag', satz: 'Vorschlag gesendet', kennung: 'BK-2026-0001', hinweise: [], wert: bezugswert() });
  const done = vi.fn();
  render(<BezugswertDialog bezug={bezug} werte={[bezugswert()]} alt={bezugswert()} zone="Europe/Berlin" standort={null} onClose={() => {}} onSaved={done} />);
  fireEvent.change(screen.getByLabelText('Wert (Stück)'), { target: { value: '48 200' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern', exact: true }));
  expect(speichern).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Tippfehler — eine Null fehlte' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern', exact: true }));
  await waitFor(() => expect(speichern).toHaveBeenCalledWith(bezug.id, '2026-10', { wert: '48.200', begruendung: 'Tippfehler — eine Null fehlte' }));
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ urteil: 'vorschlag' }));
});
it('Leser haben auch in direkt gerenderten Dialogen keinen Schreibhebel', () => {
  setSelbstauskunft(rechteSeed('CB').me);
  render(<BezugswertDialog bezug={bezug} werte={[]} alt={null} zone="Europe/Berlin" standort={null} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Speichern', exact: true })).not.toBeInTheDocument();
});
it('Ablesungen zeigen einen Ladefehler und bieten keinen Eingabeweg mit unbekanntem Bestand', async () => {
  vi.spyOn(api, 'ablesungen').mockRejectedValue(new Error('offline'));
  render(<Ablesungen kennzeichen="MS-21" einheit="m³" zone="Europe/Berlin" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('konnten nicht geladen');
  expect(screen.queryByRole('button', { name: 'Ablesung eintragen' })).not.toBeInTheDocument();
});
it('serverseitig abgelehnte Ablesung bleibt im Dialog mit ihrer Eingabe', async () => {
  const alle = gasAblesungen();
  vi.spyOn(api, 'ablesungBerichtigen').mockRejectedValue(new ApiError(422, 'Der Stand liegt unter der vorherigen Ablesung.'));
  render(<AblesungDialog kennzeichen="MS-21" einheit="m³" zone="Europe/Berlin" alle={alle} alt={alle[1]} onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByLabelText('Zählerstand (m³)'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Begründung'), { target: { value: 'Den Stand berichtigen.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('vorherigen Ablesung');
  expect(screen.getByLabelText('Zählerstand (m³)')).toHaveValue('1');
});
it('unlesbare Uhrzeit sendet niemals den zuvor gültigen Zeitpunkt', async () => {
  const schreiben = vi.spyOn(api, 'ablesungEintragen');
  render(<AblesungDialog kennzeichen="MS-21" einheit="m³" zone="Europe/Berlin" alle={gasAblesungen().slice(0, 1)} alt={null} onClose={() => {}} onSaved={() => {}} />);
  const zeit = screen.getByRole('combobox', { name: 'Uhrzeit', exact: true });
  fireEvent.change(zeit, { target: { value: 'kaputt' } }); fireEvent.blur(zeit);
  fireEvent.change(screen.getByLabelText('Zählerstand (m³)'), { target: { value: '49.451' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern', exact: true }));
  expect(schreiben).not.toHaveBeenCalled();
  expect(screen.getAllByRole('alert').some(e => e.textContent?.includes('Datum und Uhrzeit'))).toBe(true);
});
