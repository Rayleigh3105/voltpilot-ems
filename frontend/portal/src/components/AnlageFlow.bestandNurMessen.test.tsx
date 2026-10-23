import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api } from '../api';
import { standortMessstellenRoute } from '../nav';
import { ahrenbergFunktionen, funktionWerkLindach } from '../test/funktionenFixtures';
import { ahrenbergHeute, werkLindach } from '../test/standorteFixtures';
import { flussHtml, leereKomponenten, neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';

/**
 * Bestandsschutz des Modus „nur messen" (PR 806) für den Knopf „Messanlage anlegen"
 * im Assistenten „Messen & Auswerten": wer den Anlege-Fluss wie bisher öffnet — ohne
 * vorbelegten Standort und ohne Rückkehr —, sieht Zeichen für Zeichen denselben Fluss:
 * Schritt 1, Box, Anlage, und am Ende geht es ohne Umweg zu den Messstellen.
 *
 * Anlage-Flow a1, Paket 2 hat die Stände BEWUSST neu aufgenommen (Leiste Adresse · Box · Anlage, kein
 * Register-Schritt, kein Fertig- und kein Warte-Bildschirm); `register`, `fertig` und `erste-daten` gibt
 * es nicht mehr.
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
  const marker = { addTo: vi.fn(() => marker), on: vi.fn(), setLatLng: vi.fn(), getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })) };
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    marker: vi.fn(() => marker),
    divIcon: vi.fn(() => ({})),
    latLng: vi.fn((a: number, b: number) => ({ lat: a, lng: b })),
  };
  return { default: L };
});

/** Ein Kunde, der nur misst: sein einziger Standort Werk Lindach spricht nicht von Steuern. */
function messkunde() {
  vi.spyOn(api, 'standorte').mockResolvedValue({ ...ahrenbergHeute(), standorte: [werkLindach()] });
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen({ standorte: [funktionWerkLindach()] }));
  vi.spyOn(api, 'createSite').mockResolvedValue(neueAnlage);
  vi.spyOn(api, 'claimDevice').mockResolvedValue(neueBox);
  vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
  vi.spyOn(api, 'siteEntities').mockResolvedValue(leereKomponenten);
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

describe('Anlege-Fluss eines Messkunden ohne Vorbelegung — Zeichen für Zeichen (Stand Paket 2)', () => {
  it('Schritt 1, Box, Anlage - und am Ende zu den Messstellen', async () => {
    messkunde();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={onDone} />);
    await ruhe();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-schritt1.html');
    const { box, anlage } = await bisZurAnlage();
    await expect(box).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-geraet.html');
    await expect(anlage).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-anlage.html');
    fireEvent.click(screen.getByRole('button', { name: 'Stimmt so' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(standortMessstellenRoute(werkLindach().id)));
    // Die Karte „Ihre Anlage ist live“ spricht von Ersparnis - ein Messkunde bekommt sie nicht.
    expect(localStorage.getItem('vp.erste-werte.s-neu')).toBeNull();
  });
});
