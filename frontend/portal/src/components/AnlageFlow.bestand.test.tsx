import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api } from '../api';
import { anlageRoute } from '../nav';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { bestandEineAnlage, FIXTURE_IDS } from '../test/standorteFixtures';
import { flussHtml, leereKomponenten, neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';

/**
 * Bestandsschutz des Anlege-Flusses eines Kunden MIT Steuern (Werk Ahrenberg spricht von Steuern, Halle 1
 * nimmt teil): Schrittleiste, Schritt 1 mit Feineinstellungen, Box und Anlage, Zeichen für Zeichen.
 *
 * Anlage-Flow a1, Paket 2 hat die Stände BEWUSST neu aufgenommen: die Leiste heißt Adresse · Box · Anlage
 * (R4: das Register ist ein Link in „Anlage“, D6: „Betrieb“ ist entfallen), und der Fluss endet ohne
 * Warte-Bildschirm und ohne Zusammenfassung im Cockpit der neuen Anlage (D7). Die Stände `register`,
 * `betrieb`, `fertig` und `erste-daten` gibt es deshalb nicht mehr.
 */

vi.mock('../auth', () => ({ isPlatformAdmin: () => false }));

vi.mock('leaflet', () => {
  const map = {
    on: vi.fn(),
    setView: vi.fn(),
    removeLayer: vi.fn(),
    invalidateSize: vi.fn(),
    getZoom: () => 13,
    getBounds: () => ({ contains: () => true }),
    remove: vi.fn(),
  };
  const marker = {
    addTo: vi.fn(() => marker),
    on: vi.fn(),
    setLatLng: vi.fn(),
    getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })),
  };
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    marker: vi.fn(() => marker),
    divIcon: vi.fn(() => ({})),
    latLng: vi.fn((a: number, b: number) => ({ lat: a, lng: b })),
  };
  return { default: L };
});

/** Die Cloud eines Kunden mit Steuern: EIN Standort (Werk Ahrenberg), der von Steuern spricht. */
function kundeMitSteuern() {
  vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
  const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
  vi.spyOn(api, 'claimDevice').mockResolvedValue(neueBox);
  vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
  vi.spyOn(api, 'siteEntities').mockResolvedValue(leereKomponenten);
  return { createSite };
}

async function bisZurAnlage() {
  fireEvent.change(screen.getByLabelText('Name der neuen Anlage'), { target: { value: 'Halle 3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  expect(await screen.findByText('Ihre VoltPilot-Box')).toBeInTheDocument();
  await ruhe();
  const box = flussHtml();
  fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'edge-k7m2xq3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Box verbinden' }));
  expect(await screen.findByText('Ihre Box meldet gerade ihre Geräte …')).toBeInTheDocument();
  await ruhe();
  return { box, anlage: flussHtml() };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('Anlege-Fluss eines Kunden mit Steuern — Zeichen für Zeichen (Stand Paket 2)', () => {
  it('Schrittleiste, Schritt 1 (auch aufgeklappt), Box, Anlage - und ins Cockpit', async () => {
    const { createSite } = kundeMitSteuern();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await ruhe();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-schritt1.html');

    fireEvent.click(screen.getByText(/Feineinstellungen/));
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-schritt1-fein.html');

    const { box, anlage } = await bisZurAnlage();
    // Lage und Gebotszone übernimmt die Anlage von ihrem Standort (Anlage-Flow a1).
    expect(createSite.mock.calls[0][0]).toStrictEqual({
      name: 'Halle 3',
      plantKind: 'eigenverbrauch',
      anzulegenderWertCtKwh: null,
      tarifArt: 'ohne',
      tarifParamCtKwh: null,
      netzladenErlaubt: false,
      maxFeedInKw: null,
      standortId: FIXTURE_IDS.st1,
    });
    await expect(box).toMatchFileSnapshot('./__snapshots__/anlage-bestand-geraet.html');
    await expect(anlage).toMatchFileSnapshot('./__snapshots__/anlage-bestand-anlage.html');

    fireEvent.click(screen.getByRole('button', { name: 'Stimmt so' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(anlageRoute('s-neu')));
  });
});
