import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ahrenbergHeute, FIXTURE_IDS as I } from '../test/standorteFixtures';
import { ahrenbergNetzanschluesse } from '../test/netzanschlussFixtures';
import { NetzanschlussBilanzKopf } from './NetzanschlussBilanzKopf';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function stelle(bezug: { id: string; kennzeichen: string; gueltigAb: string; gueltigBis: null } | null | undefined) {
  const orte = ahrenbergHeute();
  orte.standorte[0].anlagen[0].netzanschluss = bezug;
  vi.spyOn(api, 'standorte').mockResolvedValue(orte);
  vi.spyOn(api, 'netzanschluesse').mockResolvedValue({
    standort: { id: I.st1, kurzzeichen: 'ST-1' },
    stichtag: '2026-10-20',
    kennzeichen_vorschlag: 'NA-0004',
    netzanschluesse: ahrenbergNetzanschluesse(),
  });
  vi.spyOn(api, 'netzanschlussGrenznachweis').mockRejectedValue(new Error('kein Nachweis'));
}
const bezug = { id: 'na-NA-1', kennzeichen: 'NA-1', gueltigAb: '2024-03-12', gueltigBis: null };
it('liest Standort und Anschluss zum ausgewiesenen Bilanztag', async () => {
  stelle(bezug);
  render(<NetzanschlussBilanzKopf anlage={I.an1} am="2026-10-20" />);
  await waitFor(() => expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent('vereinbart'));
  expect(api.standorte).toHaveBeenCalledWith('2026-10-20');
  expect(api.netzanschluesse).toHaveBeenCalledWith(I.st1, '2026-10-20');
  expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent('Stand am 20.10.2026');
});
it.each(['fehlt_am_neuen_standort', 'lesefehler'])('ein bekannter Anschluss bleibt bei %s sichtbar', async (art) => {
  stelle(bezug);
  if (art === 'lesefehler') vi.mocked(api.netzanschluesse).mockRejectedValue(new Error());
  else
    vi.mocked(api.netzanschluesse).mockResolvedValue({
      standort: { id: I.st1, kurzzeichen: 'ST-1' },
      stichtag: null,
      kennzeichen_vorschlag: 'NA-0004',
      netzanschluesse: [],
    });
  render(<NetzanschlussBilanzKopf anlage={I.an1} am="2026-10-20" />);
  await waitFor(() =>
    expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent(
      'Netzanschluss NA-1 · Weitere Angaben nicht abrufbar.',
    ),
  );
});
it('null heißt nicht angelegt; fehlende Antwort ist unbekannt', async () => {
  stelle(null);
  const r = render(<NetzanschlussBilanzKopf anlage={I.an1} am="2026-10-20" />);
  await waitFor(() =>
    expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent('Netzanschluss: nicht angelegt'),
  );
  expect(api.netzanschluesse).not.toHaveBeenCalled();
  stelle(undefined);
  r.rerender(<NetzanschlussBilanzKopf anlage={I.an1} am="2026-10-21" />);
  await waitFor(() =>
    expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent('Netzanschluss konnte nicht geladen werden.'),
  );
});
it('trägt das Urteil des Grenz-Nachweises im Monat des Stichtags (AP-15 IP-31)', async () => {
  stelle(bezug);
  vi.mocked(api.netzanschlussGrenznachweis).mockResolvedValue({
    netzanschluss_id: 'na-NA-1',
    kennzeichen: 'NA-1',
    monat: '2026-10',
    von: '2026-10-01',
    bis: '2026-10-19',
    zeitzone: 'Europe/Berlin',
    grenze_geprueft: true,
    grund: null,
    urteil: 'ueberschritten',
    richtungen: [],
  });
  render(<NetzanschlussBilanzKopf anlage={I.an1} am="2026-10-20" />);
  await waitFor(() =>
    expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent('Grenze im Oktober 2026 überschritten'),
  );
  expect(api.netzanschlussGrenznachweis).toHaveBeenCalledWith(I.st1, 'na-NA-1', '2026-10');
});
it('ohne Grenze oder Hauptzähler bleibt die Kopfzeile, wie sie war', async () => {
  stelle(bezug);
  vi.mocked(api.netzanschlussGrenznachweis).mockResolvedValue({
    netzanschluss_id: 'na-NA-1',
    kennzeichen: 'NA-1',
    monat: '2026-10',
    von: '2026-10-01',
    bis: '2026-10-19',
    zeitzone: 'Europe/Berlin',
    grenze_geprueft: false,
    grund: 'keine_grenze',
    urteil: null,
    richtungen: [],
  });
  render(<NetzanschlussBilanzKopf anlage={I.an1} am="2026-10-20" />);
  await waitFor(() => expect(screen.getByTestId('bilanz-netzanschluss')).toHaveTextContent('vereinbart'));
  expect(screen.getByTestId('bilanz-netzanschluss')).not.toHaveTextContent('Grenze im');
});
