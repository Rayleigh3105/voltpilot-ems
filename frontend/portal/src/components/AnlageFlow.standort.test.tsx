import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, ApiError, type Site, type StandorteAmStichtag } from '../api';

/**
 * UEMS AP-02 IP-8 — Bestandsschutz von Schritt 1 des Anlage-Assistenten: ohne
 * Standort-Objekt im Kundenbereich sieht der Schritt Zeichen für Zeichen aus wie
 * vor dem Paket, und `POST /api/v1/sites` trägt KEIN `standortId`. Die Dateien
 * unter `__snapshots__/` wurden auf dem Stand VOR IP-8 aufgenommen (eigener Commit).
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

const vorhanden: Site = {
  id: 's-1',
  name: 'Hof Sonnenfeld',
  biddingZone: 'DE-LU',
  latitude: 48.2612,
  longitude: 11.4355,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

/** `GET /api/v1/standorte` ohne ein einziges Standort-Objekt. */
const OHNE_STANDORT: Record<string, () => Promise<StandorteAmStichtag>> = {
  'der Kundenbereich hat keinen Standort': async () => ({
    stichtag: '2026-09-20',
    standorte: [],
    nichtGezeigt: [],
    nochNichtZugeordnet: null,
  }),
  'die Standorte lassen sich nicht lesen': async () => {
    throw new ApiError(403, 'verboten');
  },
};

/**
 * React zählt `useId` über ALLE Tests einer Datei (`:r0:` im ersten, `:r6:` im
 * zweiten) — die Nummer sagt etwas über die Reihenfolge der Tests, nicht über die
 * Fläche. Sie wird in der Reihenfolge ihres Auftretens ersetzt, `for`/`id` bleiben gepaart.
 */
function ohneReactIds(html: string): string {
  const ids = new Map<string, string>();
  return html.replace(/:r[0-9a-z]+:/g, (id) => {
    if (!ids.has(id)) ids.set(id, `:id${ids.size + 1}:`);
    return ids.get(id)!;
  });
}

async function schrittEins(existingSites: Site[] | undefined, standorte: () => Promise<StandorteAmStichtag>) {
  vi.spyOn(api, 'standorte').mockImplementation(standorte);
  // Das Anlegen bleibt offen: verglichen wird nur, was gesendet wird.
  const createSite = vi.spyOn(api, 'createSite').mockReturnValue(new Promise<Site>(() => {}));
  render(<AnlageFlow sites={[]} existingSites={existingSites} waitForFirstData={false} onDone={() => {}} />);
  expect(screen.getByText('Wie heißt Ihre Anlage?')).toBeInTheDocument();
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const html = ohneReactIds(document.querySelector('.vp-onboarding-step')!.outerHTML);
  return { html, createSite };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Anlage-Assistent Schritt 1 ohne Standort — unverändert wie heute (AP-02 IP-8)', () => {
  for (const [fall, standorte] of Object.entries(OHNE_STANDORT)) {
    it(`Erst-Anlage: ${fall}`, async () => {
      const { html, createSite } = await schrittEins(undefined, standorte);
      await expect(html).toMatchFileSnapshot('./__snapshots__/anlage-schritt1-ohne-standort.html');

      fireEvent.change(screen.getByLabelText('Name der Anlage'), { target: { value: 'Zuhause' } });
      fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
      expect(createSite).toHaveBeenCalledTimes(1);
      // Genau der Körper von heute — ohne `standortId`, auch nicht als `undefined`-Schlüssel.
      const body = createSite.mock.calls[0][0];
      expect(Object.keys(body)).not.toContain('standortId');
      expect(body).toStrictEqual({
        name: 'Zuhause',
        biddingZone: 'DE-LU',
        latitude: null,
        longitude: null,
        plantKind: 'eigenverbrauch',
        anzulegenderWertCtKwh: null,
        tarifArt: 'ohne',
        tarifParamCtKwh: null,
        netzladenErlaubt: false,
        maxFeedInKw: null,
      });
    });

    it(`weitere Anlage (gleicher Standort wie …): ${fall}`, async () => {
      const { html } = await schrittEins([vorhanden], standorte);
      await expect(html).toMatchFileSnapshot('./__snapshots__/anlage-schritt1-ohne-standort-weitere.html');
    });
  }
});
