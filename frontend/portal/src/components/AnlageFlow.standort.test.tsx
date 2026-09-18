import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, ApiError, type Site, type StandorteAmStichtag } from '../api';
import { standortWaehlenSatz } from '../anlageStandort';
import { ahrenbergHeute, bestandEineAnlage, FIXTURE_IDS } from '../test/standorteFixtures';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';

/**
 * UEMS AP-14 IP-4: ohne Standort UND ohne Anlage kommt zuerst der bestehende
 * Standort-Weg. Hat der Kundenbereich bereits eine Anlage, bleibt Schritt 1
 * Zeichen für Zeichen wie heute. Die Dateien unter `__snapshots__/` wurden auf
 * dem Stand VOR IP-8 aufgenommen (eigener Commit).
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
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen({ standorte: [] }));
  vi.spyOn(api, 'unternehmen').mockResolvedValue(null as never);
  // Das Anlegen bleibt offen: verglichen wird nur, was gesendet wird.
  const createSite = vi.spyOn(api, 'createSite').mockReturnValue(new Promise<Site>(() => {}));
  render(<AnlageFlow sites={[]} existingSites={existingSites} waitForFirstData={false} onDone={() => {}} />);
  await screen.findByText(existingSites?.length ? 'Wie heißt Ihre Anlage?' : 'Zuerst den Standort');
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

describe('Anlage-Assistent Schritt 1 ohne Standort — zuerst der Standort, Bestand bleibt wie heute', () => {
  for (const [fall, standorte] of Object.entries(OHNE_STANDORT)) {
    it(`Erst-Anlage: ${fall}`, async () => {
      const { html, createSite } = await schrittEins(undefined, standorte);
      expect(html).toContain('Zuerst den Standort');
      expect(html).toContain('danach geht es hier mit der Anlage weiter');
      expect(screen.getByRole('button', { name: 'Standort anlegen' })).toBeInTheDocument();
      expect(createSite).not.toHaveBeenCalled();
    });

    it(`weitere Anlage (gleicher Standort wie …): ${fall}`, async () => {
      const { html } = await schrittEins([vorhanden], standorte);
      await expect(html).toMatchFileSnapshot('./__snapshots__/anlage-schritt1-ohne-standort-weitere.html');
    });
  }
});

describe('Anlage-Assistent Schritt 1 · der Standort-Picker (AP-02 IP-8)', () => {
  async function schritt(standorte: () => Promise<StandorteAmStichtag>, anlegen?: () => Promise<Site>) {
    const lesen = vi.spyOn(api, 'standorte').mockImplementation(standorte);
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    const createSite = vi
      .spyOn(api, 'createSite')
      .mockImplementation(anlegen ?? (() => new Promise<Site>(() => {})));
    render(<AnlageFlow sites={[]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der Anlage'), { target: { value: 'Halle 3' } });
    return { lesen, createSite };
  }

  it('genau ein Standort: vorbelegt, und POST trägt seine standortId', async () => {
    const { createSite } = await schritt(async () => bestandEineAnlage());
    const picker = await screen.findByRole('combobox', { name: 'Standort *' });
    expect(picker).toHaveTextContent('Werk Ahrenberg – Halle 1 (ST-1)');
    expect(
      screen.getByText('Ihr einziger Standort ist vorbelegt: die neue Anlage gehört ab heute zu Werk Ahrenberg – Halle 1 (ST-1).'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(createSite).toHaveBeenCalledTimes(1);
    expect(createSite.mock.calls[0][0]).toMatchObject({ name: 'Halle 3', standortId: FIXTURE_IDS.st1 });
  });

  it('mehrere Standorte: zur Wahl — ohne Wahl der Satz des Servers und kein POST, gewählt mit standortId', async () => {
    const { createSite } = await schritt(async () => ahrenbergHeute());
    const picker = await screen.findByRole('combobox', { name: 'Standort *' });
    expect(picker).toHaveTextContent('Standort wählen');

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(screen.getByText(standortWaehlenSatz(2))).toBeInTheDocument();
    expect(createSite).not.toHaveBeenCalled();

    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: /Werk Lindach \(ST-2\)/ }));
    expect(screen.queryByText(standortWaehlenSatz(2))).toBeNull();
    expect(screen.getByText('Die neue Anlage gehört ab heute zu Werk Lindach (ST-2).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(createSite.mock.calls[0][0]).toMatchObject({ standortId: FIXTURE_IDS.st2 });
  });

  it('unlesbare Standorte und 422 standort_waehlen: der Satz des Servers am Picker, die Auswahl neu gelesen', async () => {
    const satz = standortWaehlenSatz(2);
    let runde = 0;
    const { lesen } = await schritt(
      async () => {
        runde += 1;
        if (runde === 1) throw new ApiError(503, 'kurz weg');
        return ahrenbergHeute();
      },
      async () => {
        throw new ApiError(422, satz, { code: 'standort_waehlen', message: satz });
      },
    );
    await waitFor(() => expect(lesen).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('combobox', { name: 'Standort *' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByRole('combobox', { name: 'Standort *' })).toBeInTheDocument();
    expect(screen.getByText(satz)).toBeInTheDocument();
    expect(lesen).toHaveBeenCalledTimes(2);
  });
});
