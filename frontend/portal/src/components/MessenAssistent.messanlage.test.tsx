import { sichtbareListe } from '../test/rollenFixtures';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Device, type EdgeVersion, type Site, type SiteComponents } from '../api';
import { steuerGeldWoerter, ZU_DEN_MESSSTELLEN } from '../anlegeNurMessen';
import { MESSANLAGE_ANLEGEN, MESSANLAGE_RUECKKEHR, type EntwurfSpeicher } from '../messenAssistent';
import {
  ahrenbergFunktionen,
  funktionMessenEntwurf,
  funktionWerkAhrenberg,
  funktionWerkLindach,
} from '../test/funktionenFixtures';
import { neueAnlage, neueBox, ruhe } from '../test/anlegeFlussFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg, werkLindach } from '../test/standorteFixtures';
import { MessenAssistent } from './MessenAssistent';

/**
 * Der Knopf „Messanlage anlegen" im Assistenten „Messen & Auswerten" (Captain 15.09.2026,
 * Empfehlung A: ein Modus „nur messen" im BESTEHENDEN Anlege-Fluss). Ahrenberg steuert an
 * Werk Ahrenberg; an Werk Lindach hängt noch keine Anlage. Der Knopf öffnet denselben
 * Anlage-Assistenten mit Werk Lindach vorbelegt — kein Wort über Steuern, Geld oder Erlöse
 * in irgendeinem Schritt —, und sein Ende führt zurück auf Schritt 2, der die neue Anlage zeigt.
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

const LINDACH = FIXTURE_IDS.st2;

function speicher(): EntwurfSpeicher {
  const daten = new Map<string, string>();
  return {
    getItem: (k) => daten.get(k) ?? null,
    setItem: (k, v) => void daten.set(k, v),
    removeItem: (k) => void daten.delete(k),
  };
}

/** Lindach ohne Anlage — bis `POST /sites` die neue Anlage an diesen Standort hängt. */
let angelegt = false;
let createSite: ReturnType<typeof vi.spyOn<typeof api, 'createSite'>>;
let claimDevice: ReturnType<typeof vi.spyOn<typeof api, 'claimDevice'>>;

beforeEach(() => {
  angelegt = false;
  vi.spyOn(api, 'standorte').mockImplementation(async () => ({
    ...ahrenbergHeute(),
    standorte: [
      werkAhrenberg(),
      werkLindach(
        angelegt
          ? { anlagen: [{ id: neueAnlage.id, name: neueAnlage.name, gueltigAb: '2026-10-20', gueltigBis: null }], anlagenZahl: 1 }
          : { anlagen: [], anlagenZahl: 0 },
      ),
    ],
  }));
  vi.spyOn(api, 'unternehmen').mockResolvedValue(ahrenbergUnternehmen());
  vi.spyOn(api, 'funktionen').mockResolvedValue(
    ahrenbergFunktionen({
      standorte: [funktionWerkAhrenberg('bestand'), funktionMessenEntwurf(funktionWerkLindach('bestand'))],
    }),
  );
  vi.spyOn(api, 'listSites').mockResolvedValue(sichtbareListe([] as Site[]));
  vi.spyOn(api, 'siteComponents').mockResolvedValue({ componentAuthority: 'cloud', components: [] } as unknown as SiteComponents);
  vi.spyOn(api, 'listDevices').mockResolvedValue(sichtbareListe([] as Device[]));
  vi.spyOn(api, 'edgeVersions').mockResolvedValue(sichtbareListe([] as EdgeVersion[]));
  createSite = vi.spyOn(api, 'createSite').mockImplementation(async () => {
    angelegt = true;
    return neueAnlage;
  });
  claimDevice = vi.spyOn(api, 'claimDevice').mockResolvedValue(neueBox);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

/** Alles, was der Kunde lesen kann: Text, Beschriftungen, Platzhalter, Titel. */
function lesbar(): string {
  const merkmale = [...document.body.querySelectorAll('[aria-label],[placeholder],[title],[alt]')].flatMap((el) =>
    ['aria-label', 'placeholder', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''),
  );
  return [document.body.textContent ?? '', ...merkmale].join('\n');
}

function schweigt(stelle: string) {
  expect(steuerGeldWoerter(lesbar()), stelle).toEqual([]);
}

const leiste = () => [...document.querySelectorAll('.vp-step-label')].map((l) => l.textContent);
const schritt2 = () => screen.findByRole('heading', { name: 'Womit wird gemessen?' });

describe('MessenAssistent — „Messanlage anlegen" öffnet den Anlege-Fluss im Modus „nur messen" und kehrt zurück', () => {
  it('Werk Lindach vorbelegt, kein Steuer-/Geld-/Erlös-/Betriebsmodell-Wort bis zum Ende, danach wieder Schritt 2 mit der neuen Anlage', async () => {
    window.location.hash = '#/messen-start';
    render(<MessenAssistent standortId={LINDACH} speicher={speicher()} onClose={() => {}} />);
    await schritt2();
    const leer = screen.getByTestId('messen-keine-anlage');
    schweigt('Schritt 2 · ohne Anlage');
    fireEvent.click(within(leer).getByRole('button', { name: MESSANLAGE_ANLEGEN }));

    // Der Unterablauf ERSETZT die Schale (Haus-Modal Ebene 60 unter dem Anlege-Dialog 61).
    const fluss = await screen.findByRole('dialog', { name: 'Anlage anlegen' }, { timeout: 5000 });
    expect(screen.queryByRole('dialog', { name: /^Messen & Auswerten/ })).toBeNull();
    await ruhe();

    // Schritt 1: vorbelegt ist der Standort aus dem Assistenten — obwohl Ahrenberg steuert,
    // spricht der Fluss an Werk Lindach von Anfang an still (derselbe Fakt, kein Schalter).
    expect(within(fluss).getByRole('combobox', { name: 'Standort *' })).toHaveTextContent('Werk Lindach (ST-2)');
    expect(leiste()).toEqual(['Anlage', 'Register', 'Gerät']);
    expect(within(fluss).queryByRole('combobox', { name: 'Veräußerungsform' })).toBeNull();
    expect(within(fluss).queryByText(/Feineinstellungen/)).toBeNull();
    schweigt('Schritt 1 · Anlage');
    fireEvent.change(within(fluss).getByLabelText('Name der Anlage'), { target: { value: 'Halle 3' } });
    fireEvent.click(within(fluss).getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(1));
    expect(createSite.mock.calls[0][0]).toMatchObject({ name: 'Halle 3', standortId: LINDACH, netzladenErlaubt: false, maxFeedInKw: null });

    // Schritt 2: Register.
    fireEvent.click(await within(fluss).findByRole('button', { name: 'Überspringen - später nachtragen' }));
    // Schritt 3: Gerät.
    expect(await within(fluss).findByText('Verbinden Sie Ihr VoltPilot-Gerät')).toBeInTheDocument();
    schweigt('Schritt 3 · Gerät');
    fireEvent.change(within(fluss).getByLabelText('Geräte-ID'), { target: { value: 'vp-demo-0001' } });
    fireEvent.click(within(fluss).getByRole('button', { name: 'Anlage anlegen' }));
    await waitFor(() => expect(claimDevice).toHaveBeenCalledTimes(1));

    // Fertig: EIN Knopf zurück — weder „Zu den Messstellen" noch „Zur Anlage", kein „Betrieb".
    expect(await within(fluss).findByText(/„Halle 3“ ist da/)).toBeInTheDocument();
    expect(within(fluss).getByText(MESSANLAGE_RUECKKEHR.satz)).toBeInTheDocument();
    expect(within(fluss).queryByRole('button', { name: ZU_DEN_MESSSTELLEN })).toBeNull();
    expect(within(fluss).queryByRole('button', { name: 'Zur Anlage' })).toBeNull();
    expect(within(fluss).queryByText('Wofür ist diese Anlage?')).toBeNull();
    schweigt('Fertig');
    fireEvent.click(within(fluss).getByRole('button', { name: MESSANLAGE_RUECKKEHR.knopf }));

    // Zurück im Assistenten auf Schritt 2 — die neue Anlage steht da, keine Adresse gewechselt.
    await schritt2();
    expect(screen.queryByRole('dialog', { name: 'Anlage anlegen' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Datenquelle anlegen für Halle 3' })).toBeInTheDocument();
    expect(screen.queryByTestId('messen-keine-anlage')).toBeNull();
    expect(window.location.hash).toBe('#/messen-start');
  });

  it('Schließen mitten im Fluss führt ebenso zurück — ohne neue Anlage bleibt der Hinweis mit dem Knopf', async () => {
    render(<MessenAssistent standortId={LINDACH} speicher={speicher()} onClose={() => {}} />);
    await schritt2();
    fireEvent.click(screen.getByRole('button', { name: MESSANLAGE_ANLEGEN }));
    const fluss = await screen.findByRole('dialog', { name: 'Anlage anlegen' }, { timeout: 5000 });
    fireEvent.click(within(fluss).getByRole('button', { name: 'Schließen' }));
    await schritt2();
    expect(within(screen.getByTestId('messen-keine-anlage')).getByRole('button', { name: MESSANLAGE_ANLEGEN })).toBeInTheDocument();
    expect(createSite).not.toHaveBeenCalled();
  });
});
