import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, ApiError, type Site, type StandorteAmStichtag } from '../api';
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
  render(<AnlageFlow sites={[]} existingSites={existingSites} wirt="dialog" onDone={() => {}} />);
  await screen.findByText(existingSites?.length ? 'Wo steht die neue Anlage?' : 'Zuerst den Standort');
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

/** Der Satz des Servers bei mehreren Standorten ohne Wahl (422 `standort_waehlen`, `AnlageStandortService`). */
const STANDORT_WAEHLEN = 'Ihr Unternehmen hat 2 Standorte. Bitte wählen Sie, zu welchem Standort die neue Anlage gehört.';

describe('Anlage-Assistent Schritt 1 · „Wo steht die neue Anlage?" (D8, F16)', () => {
  async function schritt(standorte: () => Promise<StandorteAmStichtag>, anlegen?: () => Promise<Site>) {
    const lesen = vi.spyOn(api, 'standorte').mockImplementation(standorte);
    vi.spyOn(api, 'unternehmen').mockResolvedValue(null as never);
    vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
    const createSite = vi
      .spyOn(api, 'createSite')
      .mockImplementation(anlegen ?? (() => new Promise<Site>(() => {})));
    render(<AnlageFlow sites={[]} wirt="dialog" onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Halle 3' } });
    return { lesen, createSite };
  }

  it('genau ein Standort: vorgewählt mit seiner Folge, und POST trägt seine standortId - ohne eigene Lage', async () => {
    const { createSite } = await schritt(async () => bestandEineAnlage());
    const karte = await screen.findByRole('radio', { name: /Am selben Ort wie „Werk Ahrenberg – Halle 1“/ });
    expect(karte).toBeChecked();
    expect(
      screen.getByText('Die neue Anlage gehört ab heute zu Werk Ahrenberg – Halle 1. Bilanz und Netzanschluss des Standorts zählen sie mit.'),
    ).toBeInTheDocument();
    // Ein Weg zu einem neuen Ort steht immer daneben (F16: die Auswahl hatte genau diese eine Zeile).
    expect(screen.getByRole('radio', { name: /An einer anderen Adresse/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(1));
    expect(createSite.mock.calls[0][0]).toMatchObject({ name: 'Halle 3', standortId: FIXTURE_IDS.st1 });
    expect(createSite.mock.calls[0][0]).not.toHaveProperty('latitude');
    // B3: die Anfrage trägt die Kennung des Formulars.
    expect(createSite.mock.calls[0][1]).toMatch(/^portal-.+:anlage$/);
  });

  it('mehrere Standorte: nichts vorgewählt - ohne Wahl der Satz am Feld und kein POST, gewählt mit standortId', async () => {
    const { createSite } = await schritt(async () => ahrenbergHeute());
    await screen.findByRole('radio', { name: /Werk Lindach/ });
    expect(screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Bitte wählen Sie, wo die neue Anlage steht.')).toBeInTheDocument();
    expect(createSite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: /Am selben Ort wie „Werk Lindach“/ }));
    expect(screen.queryByText('Bitte wählen Sie, wo die neue Anlage steht.')).toBeNull();
    expect(screen.getByText(/^Die neue Anlage gehört ab heute zu Werk Lindach\./)).toBeInTheDocument();
    // Werk Lindach hat eine Adresse, aber keinen Punkt auf der Karte: ohne ihn kein Wetter - der Weg steht an der Wahl.
    expect(screen.getByRole('button', { name: 'Punkt auf der Karte setzen' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());
    expect(createSite.mock.calls[0][0]).toMatchObject({ standortId: FIXTURE_IDS.st2 });
  });

  it('unlesbare Standorte und 422 standort_waehlen: der Satz des Servers an der Wahl, die Standorte neu gelesen', async () => {
    let runde = 0;
    const { lesen } = await schritt(
      async () => {
        runde += 1;
        if (runde === 1) throw new ApiError(503, 'kurz weg');
        return ahrenbergHeute();
      },
      async () => {
        throw new ApiError(422, STANDORT_WAEHLEN, { code: 'standort_waehlen', message: STANDORT_WAEHLEN });
      },
    );
    await waitFor(() => expect(lesen).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByRole('radio', { name: /Werk Lindach/ })).toBeInTheDocument();
    expect(screen.getByText(STANDORT_WAEHLEN)).toBeInTheDocument();
    expect(lesen).toHaveBeenCalledTimes(2);
  });
});
