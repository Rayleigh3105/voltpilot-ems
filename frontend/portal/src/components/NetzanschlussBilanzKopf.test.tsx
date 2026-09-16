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
