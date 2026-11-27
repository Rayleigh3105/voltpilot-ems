import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageOrtBlatt } from './AnlageOrtBlatt';
import type { AnlageOrtUmzugErgebnis, OrtTreffer } from '../api';
import { api } from '../apiVoll';
import { ahrenbergHeute, FIXTURE_IDS, werkAhrenberg } from '../test/standorteFixtures';
import { ortsbaumAhrenberg } from '../test/ortsbaumFixtures';

/**
 * „Umzug" (vp-standort-konzept §7, E1 = B): eine über die Adresssuche gewählte Adresse mehr als
 * 2 km vom ursprünglichen Punkt fragt erst „Ist Ihre Anlage umgezogen?" — „Nein" bleibt die
 * Berichtigung (siehe `AnlageOrtBlatt.test.tsx`/`AnlageTechnik.standort.test.tsx`), „Ja" fragt den
 * Umzugstag und speichert über `api.anlageOrtUmziehen`. Der neue Standort entsteht still; die
 * Ergebnis-Sätze kommen aus der WIEDERVERWENDETEN `folgenKarte()` (wie „Gehört zu"), danach bietet
 * das Blatt — wie bei „Zuordnung korrigieren" — das Archivieren des jetzt leeren alten Standorts an.
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIEN: OrtTreffer = {
  text: 'Hauptplatz 1, Wien',
  strasse: 'Hauptplatz 1',
  hausnummer: null,
  plz: null,
  ort: 'Wien',
  land: 'AT',
  breitengrad: 48.2085,
  laengengrad: 16.3738,
};

async function tippe(el: HTMLElement, text: string) {
  fireEvent.change(el, { target: { value: text } });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

function antwort() {
  const standort = werkAhrenberg({ anlagen: [{ id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1', gueltigAb: '2024-03-12', gueltigBis: null }], anlagenZahl: 1 });
  return { standort, antwort: { stichtag: '2026-11-27', standorte: [standort], nichtGezeigt: [], nochNichtZugeordnet: null } };
}

function umzugErgebnisFixture(): AnlageOrtUmzugErgebnis {
  return {
    site: { id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1', biddingZone: 'AT', latitude: 48.2085, longitude: 16.3738 } as never,
    neuerStandort: { id: 'st-neu', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg – Halle 1', adresse: werkAhrenberg().adresse } as never,
    umzug: {
      anlageId: FIXTURE_IDS.an1,
      anlageName: 'Werk Ahrenberg – Halle 1',
      bisher: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' },
      neu: { id: 'st-neu', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg – Halle 1' },
      gueltigAb: '2026-11-27',
      gueltigBis: null,
      danach: null,
      rueckwirkung: { art: 'ab_heute', tage: 0, abzeichen: null },
      zuordnungen: [
        { standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1', name: 'Werk Ahrenberg' }, gueltigAb: '2024-03-12', gueltigBis: '2026-11-26', zustand: 'beendet' },
        { standort: { id: 'st-neu', kurzzeichen: 'ST-3', name: 'Werk Ahrenberg – Halle 1' }, gueltigAb: '2026-11-27', gueltigBis: null, zustand: 'gueltig' },
      ],
      bleibt: ['box', 'topics', 'freigaben', 'betriebsmodell', 'ladepark_rahmen', 'fahrplaene', 'messstellen'],
      boxen: 1,
      netzanschluss: null,
      steuern: null,
      befehle: 0,
      begruendung: null,
      protokoll: [],
    },
    boxZugestellt: true,
    wetterNachholungAngestossen: true,
  };
}

describe('AnlageOrtBlatt › Umzug (§7, E1 = B)', () => {
  it('eine weit entfernte Wahl fragt erst „Ist Ihre Anlage umgezogen?" statt sofort zu übernehmen', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [WIEN], quelle: '© OpenStreetMap-Mitwirkende' });
    const { standort, antwort: ant } = antwort();
    render(
      <AnlageOrtBlatt siteId={FIXTURE_IDS.an1} standort={standort} antwort={ant} mehrereStandorte={false} onClose={() => {}} onGespeichert={() => {}} />,
    );

    await tippe(screen.getByLabelText('Adresse'), 'Hauptplatz 1 wien');
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hauptplatz 1, Wien' }));

    expect(await screen.findByText('Ist Ihre Anlage umgezogen?')).toBeInTheDocument();
    expect(screen.getByText(/Hauptplatz 1, Wien ist .* km entfernt\./)).toBeInTheDocument();
    // Die Frage ersetzt das Formular - die Adresse ist NICHT schon übernommen.
    expect(screen.queryByLabelText('Adresse')).toBeNull();
  });

  it('„Nein, die Adresse war falsch" übernimmt die Adresse wie eine normale Berichtigung', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [WIEN], quelle: '© OpenStreetMap-Mitwirkende' });
    const berichtigen = vi.spyOn(api, 'anlageOrtBerichtigen').mockResolvedValue({
      site: { id: FIXTURE_IDS.an1 } as never,
      standort: werkAhrenberg({ adresse: { strasse: 'Hauptplatz 1', plz: null, ort: 'Wien', land: 'AT' } }),
    } as never);
    const { standort, antwort: ant } = antwort();
    render(
      <AnlageOrtBlatt siteId={FIXTURE_IDS.an1} standort={standort} antwort={ant} mehrereStandorte={false} onClose={() => {}} onGespeichert={() => {}} />,
    );

    await tippe(screen.getByLabelText('Adresse'), 'Hauptplatz 1 wien');
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hauptplatz 1, Wien' }));
    await screen.findByText('Ist Ihre Anlage umgezogen?');
    fireEvent.click(screen.getByRole('radio', { name: /Nein, die Adresse war falsch/ }));

    expect(screen.queryByText('Ist Ihre Anlage umgezogen?')).toBeNull();
    expect(screen.getByLabelText('Adresse')).toHaveValue('Hauptplatz 1, Wien');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(berichtigen).toHaveBeenCalled());
  });

  it('„Ja, wir sind umgezogen" fragt den Umzugstag und speichert über api.anlageOrtUmziehen', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [WIEN], quelle: '© OpenStreetMap-Mitwirkende' });
    const umziehen = vi.spyOn(api, 'anlageOrtUmziehen').mockResolvedValue(umzugErgebnisFixture());
    vi.spyOn(api, 'standortOrte').mockResolvedValue({ ...ortsbaumAhrenberg(), aktionen: { archivieren: { erlaubt: true, text: null, gruende: [], letzterTag: '2026-11-26', mitarchiviert: [] }, wiederherstellen: null } } as never);
    const { standort, antwort: ant } = antwort();
    render(
      <AnlageOrtBlatt siteId={FIXTURE_IDS.an1} standort={standort} antwort={ant} mehrereStandorte={false} onClose={() => {}} onGespeichert={() => {}} />,
    );

    await tippe(screen.getByLabelText('Adresse'), 'Hauptplatz 1 wien');
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hauptplatz 1, Wien' }));
    await screen.findByText('Ist Ihre Anlage umgezogen?');
    fireEvent.click(screen.getByRole('radio', { name: /Ja, wir sind umgezogen/ }));

    expect(await screen.findByRole('combobox', { name: 'Seit wann?' })).toHaveTextContent('27.11.2026');
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(umziehen).toHaveBeenCalledWith(FIXTURE_IDS.an1, {
      adresse: { strasse: 'Hauptplatz 1', plz: null, ort: 'Wien', land: 'AT' },
      lage: { breitengrad: 48.2085, laengengrad: 16.3738 },
      gueltigAb: '2026-11-27',
    }));

    expect(await screen.findByText(/Werk Ahrenberg – Halle 1 gehört ab 27\.11\.2026 zu Werk Ahrenberg – Halle 1\./)).toBeInTheDocument();
    expect(screen.getByText('Neues Haus? Bitte prüfen')).toBeInTheDocument();
    expect(screen.getByText('Solaranlage')).toBeInTheDocument();
    expect(screen.getByText('Stromtarif')).toBeInTheDocument();
    expect(screen.getByText('Einspeisevergütung')).toBeInTheDocument();

    // Wie bei „Zuordnung korrigieren": der jetzt leere, bisherige Standort wird zum Archivieren angeboten.
    expect(await screen.findByTestId('standort-archiv-angebot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Standort archivieren' })).toBeInTheDocument();
  });

  it('der Umzugstag darf nicht in der Zukunft liegen (max = heute)', async () => {
    vi.setSystemTime(new Date('2026-11-27T10:00:00'));
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [WIEN], quelle: '© OpenStreetMap-Mitwirkende' });
    const { standort, antwort: ant } = antwort();
    render(
      <AnlageOrtBlatt siteId={FIXTURE_IDS.an1} standort={standort} antwort={ant} mehrereStandorte={false} onClose={() => {}} onGespeichert={() => {}} />,
    );

    await tippe(screen.getByLabelText('Adresse'), 'Hauptplatz 1 wien');
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hauptplatz 1, Wien' }));
    await screen.findByText('Ist Ihre Anlage umgezogen?');
    fireEvent.click(screen.getByRole('radio', { name: /Ja, wir sind umgezogen/ }));

    const feld = await screen.findByRole('combobox', { name: 'Seit wann?' });
    fireEvent.click(feld);
    expect(document.querySelector('[data-iso="2026-11-28"]')).toBeDisabled();
    vi.useRealTimers();
  });
});
