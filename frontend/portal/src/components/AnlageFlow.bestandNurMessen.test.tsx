import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, type TelemetryPoint } from '../api';
import { ahrenbergFunktionen, funktionWerkLindach } from '../test/funktionenFixtures';
import { ahrenbergHeute, werkLindach } from '../test/standorteFixtures';
import { flussHtml, neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';

/**
 * Bestandsschutz des Modus „nur messen" (PR 806) für den Knopf „Messanlage anlegen"
 * im Assistenten „Messen & Auswerten": wer den Anlege-Fluss wie bisher öffnet — ohne
 * vorbelegten Standort und ohne Rückkehr —, sieht Zeichen für Zeichen denselben Fluss:
 * Schritt 1, Register, Gerät, Fertig mit „Zu den Messstellen" + „Zur Anlage" und die
 * Bestätigung der ersten Daten.
 *
 * Die Dateien `__snapshots__/anlage-nur-messen-bestand-*.html` wurden auf dem Stand VOR
 * dem Knopf aufgenommen (eigener Commit).
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
  vi.spyOn(api, 'telemetry').mockResolvedValue([{ ts: '2026-10-20T08:15:00Z' } as unknown as TelemetryPoint]);
}

async function bisZumGeraet() {
  fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Halle 3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  expect(await screen.findByText('PV & Speicher aus dem Register')).toBeInTheDocument();
  await ruhe();
  const register = flussHtml();
  fireEvent.click(screen.getByRole('button', { name: 'Überspringen - später nachtragen' }));
  expect(await screen.findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
  const geraet = flussHtml();
  fireEvent.change(screen.getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
  return { register, geraet };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Anlege-Fluss eines Messkunden ohne Vorbelegung — Zeichen für Zeichen wie vor dem Knopf „Messanlage anlegen"', () => {
  it('Schritt 1, Register, Gerät und Fertig mit „Zu den Messstellen"', async () => {
    messkunde();
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    await ruhe();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-schritt1.html');
    const { register, geraet } = await bisZumGeraet();
    await expect(register).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-register.html');
    await expect(geraet).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-geraet.html');
    expect(await screen.findByText(/„Halle 3“ ist da/)).toBeInTheDocument();
    await ruhe();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-fertig.html');
  });

  it('Einrichtungs-Assistent: die Bestätigung der ersten Daten', async () => {
    messkunde();
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} onSkipAll={() => {}} />);
    await ruhe();
    await bisZumGeraet();
    expect(await screen.findByText('Ihre Anlage ist verbunden')).toBeInTheDocument();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-nur-messen-bestand-erste-daten.html');
  });
});
