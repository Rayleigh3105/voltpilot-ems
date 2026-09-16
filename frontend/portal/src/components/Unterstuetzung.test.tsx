import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnterstuetzungDialog, UnterstuetzungBeenden } from './UnterstuetzungDialog';
import { UnterstuetzungBanner } from './UnterstuetzungBanner';
import { UnterstuetzungKarte } from './UnterstuetzungKarte';
import { bannerTexte, hoechstesEnde, pruefeUnterstuetzung, unterstuetzungApi } from '../unterstuetzung';
import { setSelbstauskunft, RechteStandort } from '../rollen';
import { rechteSeed, STANDORT_IDS } from '../test/rollenFixtures';
import { anfrageFixture, notfallFixture, unterstuetzungFixture } from '../test/unterstuetzungFixtures';
vi.mock('../unterstuetzung', async original => ({ ...await original<typeof import('../unterstuetzung')>(), unterstuetzungApi: {
  liste: vi.fn(), anfragen: vi.fn(), hinweise: vi.fn(), gewaehren: vi.fn(), verlaengern: vi.fn(), beenden: vi.fn(), ablehnen: vi.fn(), gelesen: vi.fn(), aktualisieren: vi.fn().mockResolvedValue(undefined),
} }));
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T08:15:00Z'));
  setSelbstauskunft(rechteSeed().me);
  vi.mocked(unterstuetzungApi.liste).mockResolvedValue([unterstuetzungFixture()]); vi.mocked(unterstuetzungApi.anfragen).mockResolvedValue([]); vi.mocked(unterstuetzungApi.hinweise).mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());
it('N5/N5b/A14: exakte Kunden-, Unterstützer- und Notfallwörter, Standortfilter und Ablauf', () => {
  const me = rechteSeed().me; me.unterstuetzungen.gewaehrte = [unterstuetzungFixture(), notfallFixture()];
  expect(bannerTexte(me, STANDORT_IDS['ST-1'])).toEqual([unterstuetzungFixture().banner, notfallFixture().banner]);
  expect(bannerTexte(me, STANDORT_IDS['ST-2'])).toEqual([]);
  expect(bannerTexte(me, null, Date.parse('2027-01-01'))).toEqual([]);
  me.zugang = 'unterstuetzung'; me.unterstuetzungen.eigene = [unterstuetzungFixture()];
  expect(bannerTexte(me, null)).toEqual(['Sie arbeiten im Kundenbereich Kunststoffwerk Ahrenberg GmbH · Werk Ahrenberg · Einrichten und Bedienen · bis 15.12.2026']);
});
it('N5: nur der Kundenadministrator sieht Beenden, fremde Standorte zeigen keinen Banner', async () => {
  const me = rechteSeed().me; me.unterstuetzungen.gewaehrte = [unterstuetzungFixture()]; setSelbstauskunft(me);
  const { rerender } = render(<UnterstuetzungBanner />); await screen.findByRole('button', { name: 'Beenden' });
  rerender(<RechteStandort.Provider value={STANDORT_IDS['ST-2']}><UnterstuetzungBanner /></RechteStandort.Provider>);
  expect(screen.queryByRole('status')).toBeNull();
});
it('N4: Standort ist Pflicht, 12 Kalendermonate einschließlich Schaltjahrgrenze', () => {
  expect(pruefeUnterstuetzung([], '2026-11-19')).toBe('Wählen Sie mindestens einen Standort.');
  expect(pruefeUnterstuetzung(['ST-1'], '2027-10-21')).toContain('höchstens 12 Monaten');
  expect(pruefeUnterstuetzung(['ST-1'], '2027-10-20')).toBeNull();
  expect(hoechstesEnde('2028-02-29')).toBe('2029-02-28');
  expect(pruefeUnterstuetzung(['ST-1'], '')).toContain('Enddatum');
  render(<UnterstuetzungDialog onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByLabelText('E-Mail-Adresse des Partners'), { target: { value: 'thomas@elektro-brunner.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unterstützung gewähren', exact: true }));
  expect(screen.getByRole('alert')).toHaveTextContent('Wählen Sie mindestens einen Standort.');
  expect(screen.getByRole('combobox', { name: 'Standorte' })).toHaveFocus(); expect(unterstuetzungApi.gewaehren).not.toHaveBeenCalled();
});
it('Anfrage: Bestätigung übergibt die gewählte Anfrage und zeigt kein Partnerpasswort', async () => {
  vi.mocked(unterstuetzungApi.gewaehren).mockResolvedValue({ ...unterstuetzungFixture(), art: 'voltpilot' });
  const onSaved = vi.fn(); render(<UnterstuetzungDialog anfrage={anfrageFixture()} onClose={() => {}} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Unterstützung bestätigen' })); await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(unterstuetzungApi.gewaehren).toHaveBeenCalledWith(expect.objectContaining({ anfrage_id: anfrageFixture().id, umfang: 'ansehen', standorte: [STANDORT_IDS['ST-1']] }));
  expect(screen.queryByLabelText('Startpasswort')).toBeNull();
});
it('N6: Folgen bleiben sichtbar und Beenden nutzt den Griff mit Grund', async () => {
  render(<UnterstuetzungBeenden zugriff={unterstuetzungFixture()} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('Gesetzte Handeingriffe bleiben');
  fireEvent.change(screen.getByLabelText('Grund (optional)'), { target: { value: 'Arbeit erledigt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zugriff beenden' })); await waitFor(() => expect(unterstuetzungApi.beenden).toHaveBeenCalledWith(unterstuetzungFixture().id, 'Arbeit erledigt'));
});
it('Notfallkarte: keine Verlängerung, keine behauptete E-Mail ohne Versandbeleg', async () => {
  vi.mocked(unterstuetzungApi.liste).mockResolvedValue([notfallFixture()]);
  vi.mocked(unterstuetzungApi.hinweise).mockResolvedValue([{ id: 'h', anlass: 'notfall', text: 'Notfall-Zugriff gewährt', unterstuetzung: 'u', anfrage: null, erzeugt_am: '2026-10-20', gelesen_am: null, email_versandt_am: null }]);
  render(<UnterstuetzungKarte />); await screen.findByText('Dieser Hinweis wurde im Portal zugestellt.');
  expect(screen.queryByRole('button', { name: 'Verlängern' })).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Unterstützung' })).getByRole('button', { name: 'Beenden' })).toBeVisible();
});
