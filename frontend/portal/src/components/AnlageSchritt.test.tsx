import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageFlow } from './AnlageFlow';
import { api, ApiError, type OrtTreffer, type Site, type StandortAmStichtag } from '../api';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { bestandEineAnlage } from '../test/standorteFixtures';

/**
 * Schritt 1 des Anlege-Flusses nach Konzept a1 (Paket 1): die Adresse einmal - Standort und Anlage
 * entstehen aus EINEM Formular, beide mit der Anfrage-Kennung des Formulars (B3). F1: der Ort wurde
 * zweimal erfasst; F5: ein getippter Ort ohne Wahl wurde still verworfen; F4: jede Ablehnung hieß
 * „Bitte prüfen Sie den Namen“.
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
  return {
    default: {
      map: vi.fn(() => map),
      tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
      marker: vi.fn(() => marker),
      divIcon: vi.fn(() => ({})),
      latLng: vi.fn((a: number, b: number) => ({ lat: a, lng: b })),
    },
  };
});

const HAUS: OrtTreffer = {
  text: 'Hauptstraße 12, 91710 Gunzenhausen',
  strasse: 'Hauptstraße',
  hausnummer: '12',
  plz: '91710',
  ort: 'Gunzenhausen',
  land: 'DE',
  breitengrad: 49.1159,
  laengengrad: 10.7155,
  genau: 'haus',
};
const ORT: OrtTreffer = { ...HAUS, text: '91710 Gunzenhausen', strasse: null, hausnummer: null, genau: 'ort' };

const anlage: Site = {
  id: 's-neu',
  name: 'Zuhause',
  biddingZone: 'DE-LU',
  latitude: 49.1159,
  longitude: 10.7155,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

function neuerStandort(name: string): StandortAmStichtag {
  return { ...bestandEineAnlage().standorte[0], id: 'st-neu', name, kurzzeichen: 'ST-2', anlagen: [] };
}

/** Bis die Vorschläge (250 ms nach dem letzten Tastendruck) da sind. */
async function tippe(feld: HTMLElement, text: string) {
  fireEvent.change(feld, { target: { value: text } });
  fireEvent.focus(feld);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen({ standorte: [] }));
  vi.spyOn(api, 'unternehmen').mockResolvedValue(null as never);
  vi.spyOn(api, 'siteAssets').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('Erste Anlage eines Privatkunden: „Wo steht Ihre Anlage?"', () => {
  beforeEach(() => {
    vi.spyOn(api, 'tenantContext').mockResolvedValue({ tenantId: 'kb', name: 'Erika Kaiser', segment: 'B2C', betriebsart: 'endkunde' });
    vi.spyOn(api, 'standorte').mockResolvedValue({ stichtag: '2026-10-23', standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null } as never);
  });

  it('eine Adresse - Standort „Zuhause“ mit Lage und Anlage in einem Zug, beide mit der Kennung des Formulars', async () => {
    const suche = vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [HAUS, ORT], quelle: '© OpenStreetMap-Mitwirkende' });
    const standortAnlegen = vi.spyOn(api, 'standortAnlegen').mockResolvedValue(neuerStandort('Zuhause'));
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(anlage);
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} />);

    expect(await screen.findByRole('heading', { name: 'Wo steht Ihre Anlage?' })).toBeInTheDocument();
    // Kein Standort-Dialog vorab (F1/R1), und der Name ist vorbelegt (R2).
    expect(screen.queryByText('Zuerst den Standort')).toBeNull();
    expect(screen.getByText('Zuhause')).toBeInTheDocument();
    // F2: ein Privatkunde läuft wie heute, mit „Betrieb“ in der Leiste - nie „nur messen“.
    expect(screen.getByText('Betrieb')).toBeInTheDocument();

    await tippe(screen.getByLabelText('Adresse'), 'Hauptstr 12 gun');
    expect(suche).toHaveBeenCalledWith('Hauptstr 12 gun', expect.anything());
    expect(screen.getByText('Adressen: © OpenStreetMap-Mitwirkende')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Hauptstraße 12, 91710 Gunzenhausen' }));
    expect(screen.getByLabelText('Adresse')).toHaveValue('Hauptstraße 12, 91710 Gunzenhausen');

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());
    expect(standortAnlegen).toHaveBeenCalledWith(
      {
        name: 'Zuhause',
        adresse: { strasse: 'Hauptstraße 12', plz: '91710', ort: 'Gunzenhausen', land: 'DE' },
        zeitzone: 'Europe/Berlin',
        lage: { breitengrad: 49.1159, laengengrad: 10.7155 },
      },
      expect.stringMatching(/^portal-.+:standort0$/),
    );
    const [eingabe, kennung] = createSite.mock.calls[0];
    expect(eingabe).toMatchObject({ name: 'Zuhause', standortId: 'st-neu', plantKind: 'eigenverbrauch', tarifArt: 'ohne' });
    // Die Anlage übernimmt Lage und Gebotszone des Standorts (die API) - der Ort wird nicht zweimal gesendet.
    expect(eingabe).not.toHaveProperty('latitude');
    expect(kennung).toBe(standortAnlegen.mock.calls[0][1]!.replace(':standort0', ':anlage'));
    expect(await screen.findByText('PV & Speicher aus dem Register')).toBeInTheDocument();
  });

  it('F5: getippt, aber nicht gewählt - der erste Vorschlag gilt, mit Pin zur Kontrolle, erst dann wird angelegt', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [ORT, HAUS], quelle: '© OpenStreetMap-Mitwirkende' });
    const standortAnlegen = vi.spyOn(api, 'standortAnlegen').mockResolvedValue(neuerStandort('Zuhause'));
    vi.spyOn(api, 'createSite').mockResolvedValue(anlage);
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Adresse'), { target: { value: 'Hauptstraße 12 Gunzenhausen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    // Der erste Vorschlag MIT Straße - ein Ort allein ist keine Adresse.
    expect(await screen.findByText(/Wir haben „Hauptstraße 12, 91710 Gunzenhausen“ gewählt/)).toBeInTheDocument();
    expect(standortAnlegen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(standortAnlegen).toHaveBeenCalledTimes(1));
  });

  it('ohne Adresse: der Satz am Feld, nichts wird angelegt', async () => {
    const standortAnlegen = vi.spyOn(api, 'standortAnlegen');
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} />);
    await screen.findByLabelText('Adresse');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Bitte geben Sie die Adresse Ihrer Anlage an.')).toBeInTheDocument();
    expect(standortAnlegen).not.toHaveBeenCalled();
  });

  it('B3: die Antwort geht verloren - „Weiter“ wiederholt mit DERSELBEN Kennung, der Server legt nichts doppelt an', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [HAUS], quelle: '© OpenStreetMap-Mitwirkende' });
    const standortAnlegen = vi.spyOn(api, 'standortAnlegen').mockResolvedValue(neuerStandort('Zuhause'));
    const createSite = vi
      .spyOn(api, 'createSite')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(anlage);
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} />);
    await tippe(await screen.findByLabelText('Adresse'), 'Hauptstr 12');
    fireEvent.mouseDown(screen.getByRole('option', { name: HAUS.text }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText(/nichts wird doppelt angelegt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(2));
    expect(createSite.mock.calls[1][1]).toBe(createSite.mock.calls[0][1]);
    expect(standortAnlegen.mock.calls[1][1]).toBe(standortAnlegen.mock.calls[0][1]);
  });
});

describe('Weitere Anlage an einer anderen Adresse (D8)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'tenantContext').mockResolvedValue({ tenantId: 'kb', name: 'Erika Kaiser', segment: 'B2C', betriebsart: 'endkunde' });
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
  });

  it('„An einer anderen Adresse“ legt den Standort mit an - benannt nach der Straße, vergeben: Straße und Ort', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({ treffer: [HAUS], quelle: '© OpenStreetMap-Mitwirkende' });
    const standortAnlegen = vi
      .spyOn(api, 'standortAnlegen')
      .mockRejectedValueOnce(new ApiError(409, 'vergeben', { code: 'name_belegt', message: 'vergeben' }))
      .mockResolvedValueOnce(neuerStandort('Hauptstraße 12, Gunzenhausen'));
    const createSite = vi.spyOn(api, 'createSite').mockResolvedValue(anlage);
    render(<AnlageFlow sites={[]} existingSites={[anlage]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Garage' } });
    // Der einzige Standort ist vorgewählt - die andere Adresse ist eine ausdrückliche Wahl.
    expect(screen.getByRole('radio', { name: /Am selben Ort/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /An einer anderen Adresse/ }));
    expect(screen.getByText('Für die neue Adresse legen wir einen eigenen Standort an.')).toBeInTheDocument();
    await tippe(screen.getByLabelText('Adresse'), 'Hauptstr 12');
    fireEvent.mouseDown(screen.getByRole('option', { name: HAUS.text }));
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(createSite).toHaveBeenCalled());
    expect(standortAnlegen.mock.calls.map((c) => c[0].name)).toEqual(['Hauptstraße 12', 'Hauptstraße 12, Gunzenhausen']);
    expect(createSite.mock.calls[0][0]).toMatchObject({ name: 'Garage', standortId: 'st-neu' });
  });

  it('F4: eine Ablehnung landet am Feld, das sie meint - nie „Bitte prüfen Sie den Namen“', async () => {
    const satz = 'Höchstens zwei Nachkommastellen und unter 1.000.000 kW, z. B. 29,99.';
    vi.spyOn(api, 'createSite').mockRejectedValue(
      new ApiError(400, satz, { code: 'anfrage_ungueltig', feld: 'maxFeedInKw', message: satz }),
    );
    render(<AnlageFlow sites={[]} existingSites={[anlage]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Carport Ost' } });
    await screen.findByRole('radio', { name: /Am selben Ort/ });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    const feld = await screen.findByLabelText('Maximale Einspeiseleistung am Netzanschlusspunkt (kW)');
    expect(feld).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(satz)).toBeInTheDocument();
    expect(screen.queryByText('Bitte prüfen Sie den Namen Ihrer Anlage.')).toBeNull();
  });

  it('F4: das Portal prüft die Nachkommastellen wie der Server - „29,995“ wird gar nicht erst gesendet', async () => {
    const createSite = vi.spyOn(api, 'createSite');
    render(<AnlageFlow sites={[]} existingSites={[anlage]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Name der neuen Anlage'), { target: { value: 'Carport Ost' } });
    await screen.findByRole('radio', { name: /Am selben Ort/ });
    fireEvent.click(screen.getByText(/Feineinstellungen/));
    fireEvent.change(screen.getByLabelText('Maximale Einspeiseleistung am Netzanschlusspunkt (kW)'), { target: { value: '29,995' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Höchstens zwei Nachkommastellen und unter 1.000.000 kW, z. B. 29,99.')).toBeInTheDocument();
    expect(createSite).not.toHaveBeenCalled();
  });
});

describe('Unternehmen (D2): der Standort-Dialog bleibt', () => {
  it('ohne Standort: zuerst der Standort - die Leiste behält ihn nach dem Speichern (F7)', async () => {
    vi.spyOn(api, 'tenantContext').mockResolvedValue({ tenantId: 'kb', name: 'Sonnenhof GmbH', segment: 'CI', betriebsart: 'betreiber' });
    vi.spyOn(api, 'standorte').mockResolvedValue({ stichtag: '2026-10-23', standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null } as never);
    render(<AnlageFlow sites={[]} waitForFirstData onDone={() => {}} />);
    expect(await screen.findByText('Zuerst den Standort')).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll('.vp-step-label')).map((e) => e.textContent)).toEqual([
      'Standort',
      'Anlage',
      'Register',
      'Gerät',
    ]);
  });

  it('weitere Anlage: „Neuen Standort anlegen“ öffnet den Standort-Dialog', async () => {
    vi.spyOn(api, 'tenantContext').mockResolvedValue({ tenantId: 'kb', name: 'Sonnenhof GmbH', segment: 'CI', betriebsart: 'betreiber' });
    vi.spyOn(api, 'standorte').mockResolvedValue(bestandEineAnlage());
    vi.spyOn(api, 'standortKurzzeichenVorschlag').mockResolvedValue({ kurzzeichen: 'ST-2' });
    render(<AnlageFlow sites={[]} existingSites={[anlage]} waitForFirstData={false} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole('radio', { name: /Neuen Standort anlegen/ }));
    expect(await screen.findByRole('dialog', { name: 'Standort anlegen' })).toBeInTheDocument();
    // Die bisherige Wahl gilt, bis der Dialog speichert.
    expect(screen.getByRole('radio', { name: /Am selben Ort/ })).toBeChecked();
  });
});
