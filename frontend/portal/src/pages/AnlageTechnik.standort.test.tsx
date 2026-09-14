import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TechnikSection } from './AnlageTechnik';
import { api, ApiError, type Site, type StandorteAmStichtag } from '../api';
import { DIALOG_TITEL } from '../standorte';
import { ahrenbergHeute, ahrenbergUnternehmen, bestandEineAnlage, FIXTURE_IDS } from '../test/standorteFixtures';

/**
 * UEMS AP-02 IP-8 — Bestandsschutz der Karte „Meine Anlage“: ein Kunde, dessen
 * Anlage KEIN Standort-Objekt hat, sieht die Karte Zeichen für Zeichen wie vor
 * dem Paket. Die Dateien unter `__snapshots__/` wurden auf dem Stand VOR IP-8
 * aufgenommen (eigener Commit) — ändert sich hier ein Byte, ist das kein neuer
 * Snapshot, sondern ein Bruch.
 */

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

/** Ein Einzel-Anlagen-Kunde: genau diese eine Anlage. */
const hof: Site = {
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

const ohneKarte: Site = { ...hof, latitude: null, longitude: null };

/** Die Antworten von `GET /api/v1/standorte`, in denen DIESE Anlage kein Standort-Objekt hat. */
const OHNE_STANDORT: Record<string, () => Promise<StandorteAmStichtag>> = {
  'der Kundenbereich hat keinen Standort (noch nicht zugeordnet)': async () => ({
    stichtag: '2026-09-20',
    standorte: [],
    nichtGezeigt: [],
    nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: 's-1', name: 'Hof Sonnenfeld' }] },
  }),
  'die Standorte tragen andere Anlagen, nicht diese': async () => ahrenbergHeute(),
  'die Standorte lassen sich nicht lesen': async () => {
    throw new ApiError(403, 'verboten');
  },
};

/**
 * React zählt `useId` über ALLE Tests einer Datei — die Nummer sagt etwas über die
 * Reihenfolge der Tests, nicht über die Karte. Sie wird in der Reihenfolge ihres
 * Auftretens ersetzt, `for`/`id` bleiben gepaart.
 */
function ohneReactIds(html: string): string {
  const ids = new Map<string, string>();
  return html.replace(/:r[0-9a-z]+:/g, (id) => {
    if (!ids.has(id)) ids.set(id, `:id${ids.size + 1}:`);
    return ids.get(id)!;
  });
}

async function karte(site: Site, standorte: () => Promise<StandorteAmStichtag>) {
  vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
  vi.spyOn(api, 'siteDeletionPreview').mockRejectedValue(new Error('n/a'));
  vi.spyOn(api, 'supplyPrice').mockResolvedValue(null as never);
  vi.spyOn(api, 'schedule').mockRejectedValue(new Error('kein Plan'));
  vi.spyOn(api, 'standorte').mockImplementation(standorte);
  render(
    <TechnikSection
      site={site}
      devices={[]}
      sites={[site]}
      onReload={() => {}}
      onSiteSaved={() => {}}
      onSiteDeleted={() => {}}
    />,
  );
  await waitFor(() => expect(document.getElementById('technik-anlage')).not.toBeNull());
  // Jeder Abruf der Karte darf zu Ende laufen, bevor verglichen wird.
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const el = document.getElementById('technik-anlage');
  expect(el).not.toBeNull();
  return ohneReactIds(el!.outerHTML);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Meine Anlage ohne Standort-Objekt — byte-identisch (AP-02 IP-8)', () => {
  for (const [fall, standorte] of Object.entries(OHNE_STANDORT)) {
    it(`mit Karte: ${fall}`, async () => {
      await expect(await karte(hof, standorte)).toMatchFileSnapshot(
        './__snapshots__/meine-anlage-ohne-standort-mit-karte.html',
      );
    });
    it(`ohne Karte: ${fall}`, async () => {
      await expect(await karte(ohneKarte, standorte)).toMatchFileSnapshot(
        './__snapshots__/meine-anlage-ohne-standort-ohne-karte.html',
      );
    });
  }
});

describe('Meine Anlage mit Standort-Objekt — beide Zeilen benannt (AP-02 IP-8, T6a, W4)', () => {
  it('„Standort“ (das Objekt) und darunter „Standort auf der Karte“ (die Koordinaten)', async () => {
    const halle2: Site = { ...hof, id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' };
    await karte(halle2, async () => ahrenbergHeute());
    const el = document.getElementById('technik-anlage')!;
    const labels = [...el.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(labels.slice(0, 3)).toEqual(['Name', 'Standort', 'Standort auf der Karte']);
    const objekt = el.querySelectorAll('.vp-kv-row')[1] as HTMLElement;
    expect(within(objekt).getByText('Werk Ahrenberg (ST-1)')).toBeInTheDocument();
    expect(within(objekt).getByText('Gewerbering 7, Ahrenberg · seit 01.10.2026')).toBeInTheDocument();
    expect(within(el).queryByRole('button', { name: /Adresse nachtragen/ })).toBeNull();
  });

  it('der automatisch angelegte Standort sagt, was fehlt, und bietet „Adresse nachtragen“ an', async () => {
    const halle1: Site = { ...hof, id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1' };
    vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen());
    await karte(halle1, async () => bestandEineAnlage());
    const el = document.getElementById('technik-anlage')!;
    expect(within(el).getByText(/Noch nicht eingerichtet — es fehlt: Adresse/)).toBeInTheDocument();
    fireEvent.click(within(el).getByRole('button', { name: 'Adresse nachtragen: Werk Ahrenberg – Halle 1' }));
    expect(await screen.findByText(DIALOG_TITEL.vervollstaendigen)).toBeInTheDocument();
  });
});
