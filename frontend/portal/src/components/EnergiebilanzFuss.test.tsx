import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ahrenbergHeute, FIXTURE_IDS as I } from '../test/standorteFixtures';
import { ahrenbergNetzanschluesse } from '../test/netzanschlussFixtures';
import { EnergiebilanzFuss } from './EnergiebilanzFuss';

/**
 * Konzept Auswerten a1 §6.9: der Fuß der Energiebilanz nennt Netzanschluss und vereinbarte Leistung und die Zeitzone
 * EINMAL, mit dem Standort. MaLo, Netzbetreiber, Anschluss-kVA und „Grenze … nicht belegt“ stehen nicht mehr da; nur ein
 * überschrittener Grenz-Nachweis (AP-15 IP-31) bleibt, weil er eine Handlung verlangt.
 */
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
const nachweis = (urteil: 'ueberschritten' | 'eingehalten' | 'nicht_belegt') => ({
  netzanschluss_id: 'na-NA-1',
  kennzeichen: 'NA-1',
  monat: '2026-10',
  von: '2026-10-01',
  bis: '2026-10-19',
  zeitzone: 'Europe/Berlin',
  grenze_geprueft: true,
  grund: null,
  urteil,
  richtungen: [],
});

it('Netzanschluss, vereinbarte Leistung und die Zeitzone mit dem Standort - am ersten Tag des Zeitraums gelesen', async () => {
  stelle(bezug);
  render(<EnergiebilanzFuss anlage={I.an1} am="2026-10-01" zone="Europe/Berlin" />);
  const fuss = screen.getByTestId('energiebilanz-fuss');
  await waitFor(() => expect(fuss).toHaveTextContent('Netzanschluss NA-1 · vereinbart 550 kW · Zeiten: Europe/Berlin (Werk Ahrenberg)'));
  expect(api.standorte).toHaveBeenCalledWith('2026-10-01');
  expect(api.netzanschluesse).toHaveBeenCalledWith(I.st1, '2026-10-01');
  expect(fuss).not.toHaveTextContent('MaLo');
  expect(fuss).not.toHaveTextContent('Anschluss 630');
});

it('die Zeitzone steht sofort; was nicht lädt, steht nicht da', async () => {
  vi.spyOn(api, 'standorte').mockRejectedValue(new Error('weg'));
  render(<EnergiebilanzFuss anlage={I.an1} am="2026-10-01" zone="Europe/Berlin" />);
  expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent('Zeiten: Europe/Berlin');
  await waitFor(() => expect(api.standorte).toHaveBeenCalled());
  expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent(/^Zeiten: Europe\/Berlin$/);
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
  render(<EnergiebilanzFuss anlage={I.an1} am="2026-10-20" zone="Europe/Berlin" />);
  await waitFor(() => expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent(/^Netzanschluss NA-1 · Zeiten: Europe\/Berlin/));
});

it('null heißt nicht angelegt; eine fehlende Angabe sagt nichts', async () => {
  stelle(null);
  const r = render(<EnergiebilanzFuss anlage={I.an1} am="2026-10-20" zone="Europe/Berlin" />);
  await waitFor(() => expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent('Netzanschluss: nicht angelegt · Zeiten'));
  expect(api.netzanschluesse).not.toHaveBeenCalled();
  stelle(undefined);
  r.rerender(<EnergiebilanzFuss anlage={I.an1} am="2026-10-21" zone="Europe/Berlin" />);
  await waitFor(() => expect(api.standorte).toHaveBeenCalledWith('2026-10-21'));
  await waitFor(() => expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent(/^Zeiten: Europe\/Berlin \(Werk Ahrenberg\)$/));
});

it('nur ein überschrittener Grenz-Nachweis steht am Fuß (AP-15 IP-31); eingehalten und nicht belegt schweigen', async () => {
  stelle(bezug);
  vi.mocked(api.netzanschlussGrenznachweis).mockResolvedValue(nachweis('ueberschritten'));
  const r = render(<EnergiebilanzFuss anlage={I.an1} am="2026-10-01" zone="Europe/Berlin" />);
  await waitFor(() => expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent('Grenze im Oktober 2026 überschritten'));
  expect(api.netzanschlussGrenznachweis).toHaveBeenCalledWith(I.st1, 'na-NA-1', '2026-10');
  for (const urteil of ['eingehalten', 'nicht_belegt'] as const) {
    vi.mocked(api.netzanschlussGrenznachweis).mockResolvedValue(nachweis(urteil));
    r.rerender(<EnergiebilanzFuss anlage={I.an1} am={urteil === 'eingehalten' ? '2026-10-02' : '2026-10-03'} zone="Europe/Berlin" />);
    await waitFor(() => expect(screen.getByTestId('energiebilanz-fuss')).toHaveTextContent('vereinbart'));
    expect(screen.getByTestId('energiebilanz-fuss')).not.toHaveTextContent('Grenze im');
  }
});
