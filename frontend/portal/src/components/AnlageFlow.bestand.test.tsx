import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, type TelemetryPoint } from '../api';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { bestandEineAnlage, FIXTURE_IDS } from '../test/standorteFixtures';
import { flussHtml, leereKomponenten, neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';

/**
 * Bestandsschutz des Modus „nur messen" (Steuern-Regel im Anlege-Fluss, Captain
 * 15.09.2026): ein Kunde MIT Steuern sieht den Fluss Zeichen für Zeichen wie vorher.
 * Werk Ahrenberg spricht von Steuern (Halle 1 nimmt teil) — Schrittleiste, Schritt 1
 * mit Feineinstellungen, Register, Gerät, Betrieb, Fertig und die Bestätigung der
 * ersten Daten.
 *
 * Die Dateien `__snapshots__/anlage-bestand-*.html` wurden auf dem Stand VOR dem
 * Paket aufgenommen (eigener Commit); der Fluss las `GET /funktionen` damals nicht.
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
  vi.spyOn(api, 'siteProfiles').mockResolvedValue({ profiles: [] });
  vi.spyOn(api, 'telemetry').mockResolvedValue([{ ts: '2026-10-20T08:15:00Z' } as unknown as TelemetryPoint]);
  return { createSite };
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

describe('Anlege-Fluss eines Kunden mit Steuern — Zeichen für Zeichen wie vor dem Modus „nur messen"', () => {
  it('Schrittleiste, Schritt 1 (auch aufgeklappt), Register, Gerät, Betrieb und Fertig', async () => {
    const { createSite } = kundeMitSteuern();
    const onDone = vi.fn();
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={onDone} />);
    await ruhe();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-schritt1.html');

    fireEvent.click(screen.getByText(/Feineinstellungen/));
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-schritt1-fein.html');

    const { register, geraet } = await bisZumGeraet();
    expect(createSite.mock.calls[0][0]).toStrictEqual({
      name: 'Halle 3',
      biddingZone: 'DE-LU',
      latitude: null,
      longitude: null,
      plantKind: 'eigenverbrauch',
      anzulegenderWertCtKwh: null,
      tarifArt: 'ohne',
      tarifParamCtKwh: null,
      netzladenErlaubt: false,
      maxFeedInKw: null,
      standortId: FIXTURE_IDS.st1,
    });
    await expect(register).toMatchFileSnapshot('./__snapshots__/anlage-bestand-register.html');
    await expect(geraet).toMatchFileSnapshot('./__snapshots__/anlage-bestand-geraet.html');

    expect(await screen.findByText('Wofür ist diese Anlage?')).toBeInTheDocument();
    await ruhe();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-betrieb.html');

    fireEvent.click(screen.getByRole('button', { name: 'Überspringen - später festlegen' }));
    expect(await screen.findByText(/„Halle 3“ ist da/)).toBeInTheDocument();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-fertig.html');
    fireEvent.click(screen.getByRole('button', { name: 'Zur Anlage' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('der Einrichtungs-Assistent bestätigt die ersten Daten wie vorher', async () => {
    kundeMitSteuern();
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} onSkipAll={() => {}} />);
    await ruhe();
    await bisZumGeraet();
    expect(await screen.findByText('Wofür ist diese Anlage?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Überspringen - später festlegen' }));
    expect(await screen.findByText('Ihre Anlage ist verbunden')).toBeInTheDocument();
    await expect(flussHtml()).toMatchFileSnapshot('./__snapshots__/anlage-bestand-erste-daten.html');
  });
});
