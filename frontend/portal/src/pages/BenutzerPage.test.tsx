import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BenutzerPage } from './BenutzerPage';
import { benutzerApi, benutzerFehler, rechteVorschau } from '../benutzer';
import { ApiError } from '../api';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { benutzerFixture } from '../test/benutzerFixtures';
import { BenutzerEinladen } from '../components/BenutzerEinladen';
vi.mock('../benutzer', async original => ({ ...(await original<typeof import('../benutzer')>()), benutzerApi: {
  liste: vi.fn(), protokoll: vi.fn(), wechseln: vi.fn(), anlegen: vi.fn(), sperren: vi.fn(), entfernen: vi.fn(), entziehen: vi.fn(), startpasswort: vi.fn(),
} }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T08:15:30Z'));
  vi.clearAllMocks(); setSelbstauskunft(rechteSeed().me);
  vi.mocked(benutzerApi.liste).mockResolvedValue(benutzerFixture());
  vi.mocked(benutzerApi.protokoll).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
it('N1: eigener Eintrag ohne Änderungen, künftige Zuweisungen sichtbar', async () => {
  render(<BenutzerPage />);
  const jonas = await screen.findByText(/Jonas Wendlinger · Sie/);
  expect(within(jonas.closest('article')!).queryByRole('button')).toBeNull();
  expect(screen.getAllByText(/gültig ab/).length).toBeGreaterThan(0);
});
it('Energiemanager liest, Leser sieht die Fläche nicht', async () => {
  setSelbstauskunft(rechteSeed('IK').me);
  const { unmount } = render(<BenutzerPage />);
  await screen.findByText('Ines Kaltenbach · Sie');
  expect(screen.queryByRole('button')).toBeNull(); unmount();
  setSelbstauskunft(rechteSeed('CB').me); render(<BenutzerPage />);
  expect(screen.getByRole('alert')).toHaveTextContent('Diese Seite gibt es für Sie nicht.');
});
it('N2/N3 validiert Pflichtfelder und Standort vor der einmaligen Anlage', async () => {
  render(<BenutzerEinladen onClose={() => {}} onCreated={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  expect(screen.getByLabelText('Benutzername')).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent('Bitte geben Sie einen Benutzernamen ein.');
  fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'claudia' } });
  fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'claudia@ahrenberg.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  await screen.findByText(/Schritt 2 von 2/);
  fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen', exact: true }));
  expect(benutzerApi.anlegen).not.toHaveBeenCalled();
  expect(screen.getAllByText('Wählen Sie mindestens einen Standort.').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Alle aktuellen Standorte' }));
  vi.mocked(benutzerApi.anlegen).mockResolvedValue({ benutzer: benutzerFixture()[0], startpasswort: 'Test-24!' });
  fireEvent.click(screen.getByRole('button', { name: 'Benutzer anlegen', exact: true }));
  await screen.findByLabelText('Startpasswort');
  expect(benutzerApi.anlegen).toHaveBeenCalledWith(expect.objectContaining({ rolle: 'leser', standorte: rechteSeed().me.standorte.map(s => s.id) }));
});
it('Sperren bestätigt Folgen und zeigt den Serverfehler mit Weg', async () => {
  render(<BenutzerPage />); await screen.findByText(/Jonas Wendlinger · Sie/);
  vi.mocked(benutzerApi.sperren).mockRejectedValue(new ApiError(409, '', { code: 'letzter_kundenadministrator' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Sperren', exact: true })[0]);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('Gesetzte Handeingriffe bleiben');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sperren', exact: true }));
  await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Ernennen Sie zuerst eine weitere Person.'));
});
it('Fehlertabelle unterscheidet eigene Rechte, fremde E-Mail und fehlenden Standort', () => {
  expect(benutzerFehler(new ApiError(409, '', { code: 'eigene_zuweisung' }))).toContain('weiterer Kundenadministrator');
  expect(benutzerFehler(new ApiError(409, '', { code: 'email_fremder_kundenbereich' }))).toContain('Als Unterstützung gewähren?');
  expect(benutzerFehler(new ApiError(422, ''))).toContain('mindestens einen Standort');
  expect(benutzerFehler(new ApiError(403, ''))).toContain('Jonas Wendlinger');
});
it('Vorschau verwendet die Aktionsmatrix: Leser darf keine Schreibaktion', () => {
  const v = rechteVorschau('leser', ['ST-1']);
  expect(v.some(x => x.erlaubt)).toBe(true);
  expect(v.find(x => x.text.startsWith('Benutzer anlegen'))?.erlaubt).toBe(false);
});

it('Rollenänderung ersetzt nur die gewählte Zuweisung', async () => {
  const konto = benutzerFixture().find(b => b.sub === 'CB')!;
  const onCreated = vi.fn();
  vi.mocked(benutzerApi.wechseln).mockResolvedValue(undefined);
  render(<BenutzerEinladen bearbeiten={{ konto, zuweisung: konto.zuweisungen[0] }} onClose={() => {}} onCreated={onCreated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  expect(benutzerApi.wechseln).toHaveBeenCalledWith('CB', [konto.zuweisungen[0].id], 'leser', [konto.zuweisungen[0].standort_id]);
});


it('entzieht eine einzelne Zuweisung über den vorhandenen Weg und erhält das Konto', async () => {
  vi.mocked(benutzerApi.entziehen).mockResolvedValue(undefined);
  render(<BenutzerPage />); await screen.findByText(/Jonas Wendlinger · Sie/);
  fireEvent.click(screen.getAllByRole('button', { name: 'Zugriff beenden', exact: true })[0]);
  const dialog = screen.getByRole('dialog', { name: 'Zugriff beenden' });
  expect(dialog).toHaveTextContent('Andere Zuweisungen bleiben erhalten.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Zugriff beenden', exact: true }));
  await waitFor(() => expect(benutzerApi.entziehen).toHaveBeenCalledWith(benutzerFixture()[1].zuweisungen[0].id));
  expect(benutzerApi.sperren).not.toHaveBeenCalled(); expect(benutzerApi.entfernen).not.toHaveBeenCalled();
});


it.each([
  ['2026-03-28T23:30:00Z', '29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', '2026-03-29T01:15:00Z', '29.03.2026 03:15'],
  ['2026-10-24T22:30:00Z', '25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', '2026-10-25T02:15:00Z', '25.10.2026 03:15'],
  ['2027-01-14T23:30:00Z', '15', '2027-01-14T23:00:00.000Z', '2027-01-15T23:00:00.000Z', '2027-01-15T09:15:00Z', '15.01.2027 10:15'],
])('N8: Berliner Kalendertag und Zeitgrenzen bei %s, unabhängig von der Browserzone', async (jetzt, tag, von, bis, zeit, anzeige) => {
  vi.setSystemTime(new Date(jetzt));
  vi.mocked(benutzerApi.protokoll).mockResolvedValue([{ id: 1, zeit, betroffener: 'Claudia Berger', aktion: 'zuweisen', rolle: 'leser', standort: 'Werk Lindach', urheber: 'Jonas Wendlinger', grund: null }]);
  render(<BenutzerPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Zugriffsprotokoll', exact: true }));
  await screen.findByText(anzeige);
  expect(benutzerApi.protokoll).toHaveBeenLastCalledWith(expect.any(String), bis);
  fireEvent.click(screen.getByRole('combobox', { name: 'Von', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Nächster Monat' }));
  fireEvent.click(screen.getByRole('gridcell', { name: tag, exact: true }));
  await waitFor(() => expect(benutzerApi.protokoll).toHaveBeenLastCalledWith(von, bis));
  const protokoll = screen.getByRole('region', { name: 'Zugriffsprotokoll' });
  expect(within(protokoll).getAllByText(/Europe\/Berlin/)).toHaveLength(1);
  expect(protokoll).not.toHaveTextContent('UTC');
  expect(within(protokoll).getByText(anzeige)).toHaveAttribute('datetime', zeit);
});
