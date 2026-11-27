import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TechnikSection } from './AnlageTechnik';
import { ApiError, type Site, type StandorteAmStichtag } from '../api';
import { api } from '../apiVoll';
import { DIALOG_TITEL } from '../standorte';
import { ahrenbergHeute, ahrenbergUnternehmen, bestandEineAnlage, FIXTURE_IDS } from '../test/standorteFixtures';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';

/**
 * UEMS AP-02 IP-8 — Bestandsschutz der Gruppe „Anlage“: ein Kunde, dessen Anlage
 * KEIN Standort-Objekt hat, sieht sie Zeichen für Zeichen wie ohne UEMS. Die
 * Dateien unter `__snapshots__/` wurden zuerst auf dem Stand VOR IP-8 aufgenommen
 * (eigener Commit); mit dem Nachzug von `main` (Konzept „Anlage – neu gedacht“,
 * 41ed67c26, live seit 25.09.2026) ist der Bestand die kurze Liste — die Dateien
 * sind darum im Nachzug-Merge aus der REINEN main-Fassung von `AnlageTechnik.tsx`
 * neu aufgenommen, nicht aus der vereinigten. Ändert sich hier ein Byte, ist das
 * kein neuer Snapshot, sondern ein Bruch.
 *
 * **„Ein Ort fürs Laden" Scheibe 4 (27.10.2026, E5 = A):** beide Dateien bekommen genau EINE neue
 * Zeile „Anschlussgrenze" direkt nach „Einspeisegrenze" (Konzept-Entscheid, nicht gefunden) - mit
 * `vitest -u` gegen den aktuellen Produktstand neu geschrieben; der Zeichenvergleich alt/neu zeigt
 * nur das eine eingefügte `<li>`.
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

describe('Meine Anlage mit vollständigem Standort — EINE Zeile (vp-standort-konzept §6.1/§6.2, B1/B3/B6, E3)', () => {
  it('„Standort“ zeigt Standortname und Adresse in einem Zug - keine zweite Koordinaten-Zeile mehr', async () => {
    const halle2: Site = { ...hof, id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' };
    await karte(halle2, async () => ahrenbergHeute());
    const el = document.getElementById('technik-anlage')!;
    // Seit der kurzen Liste (E5): jede Zeile ein Eintrag; die vollständige Adresse (Werk
    // Ahrenberg hat eine Adresse UND eine Lage) ersetzt das Objekt und die Koordinaten-Zeile
    // durch GENAU eine Zeile (B3: kein Auseinanderlaufen zwischen Objekt und Kartenpunkt mehr).
    const labels = [...el.querySelectorAll('.vp-einst-liste > li')].map(
      (li) => li.querySelector('.vp-einst-lab > b, dt')?.textContent,
    );
    expect(labels.filter((l) => l === 'Standort')).toHaveLength(1);
    expect(labels).not.toContain('Standort auf der Karte');
    // §6.2: bei mehreren Standorten (hier: Ahrenberg + Lindach) steht zuerst der Standortname.
    expect(within(el).getByText('Werk Ahrenberg · Gewerbering 7, Ahrenberg')).toBeInTheDocument();
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

  it('E2 = A: „Standort bearbeiten" braucht anlage.ort_berichtigen, nicht mehr anlage.verwalten', async () => {
    const halle2: Site = { ...hof, id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' };
    const me = rechteSeed('JW').me;
    const ohne = (kennung: string) => (rechte: readonly string[]) => rechte.filter((r) => r !== kennung);
    // Kundenadministrator OHNE das neue Recht: der Knopf wird zum Hinweis.
    setSelbstauskunft({
      ...me,
      unternehmen_rechte: ohne('anlage.ort_berichtigen')(me.unternehmen_rechte),
      standorte: me.standorte.map((s) => ({ ...s, rechte: ohne('anlage.ort_berichtigen')(s.rechte) })),
    });
    await karte(halle2, async () => ahrenbergHeute());
    let el = document.getElementById('technik-anlage')!;
    expect(within(el).queryByRole('button', { name: /^Standort bearbeiten/ })).toBeNull();
    expect(within(el).getByRole('note')).toBeInTheDocument();
    cleanup();

    // Energiemanager OHNE anlage.verwalten, aber MIT dem neuen Recht (E2 = A): der Knopf bleibt.
    setSelbstauskunft({
      ...me,
      unternehmen_rechte: ohne('anlage.verwalten')(rechteSeed('IK').me.unternehmen_rechte),
      standorte: rechteSeed('IK').me.standorte.map((s) => ({ ...s, rechte: ohne('anlage.verwalten')(s.rechte) })),
    });
    await karte(halle2, async () => ahrenbergHeute());
    el = document.getElementById('technik-anlage')!;
    expect(within(el).getByRole('button', { name: /^Standort bearbeiten/ })).toBeInTheDocument();
    setSelbstauskunft(rechteSeed('JW').me);
  });
});

describe('Umzug-Merkzettel auf "Meine Anlage" (§7, Bericht 6.6 Punkt 7)', () => {
  it('zeigt den offenen Merkzettel als eigene Zeile über den Einstellungsgruppen', async () => {
    const halle2: Site = { ...hof, id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' };
    vi.spyOn(api, 'umzugMerkzettelLesen').mockResolvedValue({
      seit: '2026-11-27T10:00:00Z', solaranlageErledigt: false, stromtarifErledigt: true, einspeiseverguetungErledigt: false,
    });
    await karte(halle2, async () => ahrenbergHeute());

    const banner = await screen.findByTestId('umzug-merkzettel');
    expect(within(banner).getByText('Neues Haus? Bitte prüfen')).toBeInTheDocument();
    expect(within(banner).getByText('Solaranlage')).toBeInTheDocument();
    expect(within(banner).queryByText('Stromtarif')).toBeNull();
    expect(within(banner).getByText('Einspeisevergütung')).toBeInTheDocument();
  });

  it('bleibt ohne Umzug ganz weg', async () => {
    const halle2: Site = { ...hof, id: FIXTURE_IDS.an2, name: 'Werk Ahrenberg – Halle 2' };
    vi.spyOn(api, 'umzugMerkzettelLesen').mockResolvedValue(null);
    await karte(halle2, async () => ahrenbergHeute());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId('umzug-merkzettel')).toBeNull();
  });
});
