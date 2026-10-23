import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AnlageHinweise from './AnlageHinweise';
import { api, type Site, type StandortAmStichtag } from '../api';
import { ersteWerteOffen, merkeErsteWerte } from '../ersteWerte';

vi.mock('leaflet', () => {
  const map = { on: vi.fn(), setView: vi.fn(), removeLayer: vi.fn(), invalidateSize: vi.fn(), getZoom: () => 13,
    getBounds: () => ({ contains: () => true }), remove: vi.fn() };
  const marker = { addTo: vi.fn(() => marker), on: vi.fn(), setLatLng: vi.fn(), getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })) };
  return { default: { map: vi.fn(() => map), tileLayer: vi.fn(() => ({ addTo: vi.fn() })), marker: vi.fn(() => marker),
    divIcon: vi.fn(() => ({})), latLng: vi.fn((a: number, b: number) => ({ lat: a, lng: b })) } };
});

const site: Site = {
  id: 's-1', name: 'Zuhause', biddingZone: 'DE-LU', latitude: null, longitude: null, plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null,
};

const ENTWURF = { id: 'st-1', name: 'Simulation', kurzzeichen: 'ST-1', gueltigAb: '2026-09-11', adresseFehlt: true };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = '';
});

describe('„Ihre Anlage ist live“ - einmal, mit genau einem nächsten Schritt (D7)', () => {
  it('ohne Strompreis: „Strompreis angeben“ führt zu Strom & Geld, und die Karte ist erledigt', () => {
    merkeErsteWerte('s-1');
    render(<AnlageHinweise site={site} ersteWerte standort={null} onGespeichert={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Ihre Anlage ist live.' })).toBeInTheDocument();
    expect(screen.getByText('Ein nächster Schritt: Strompreis angeben, dann zeigen wir Ihre Ersparnis in Euro.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Strompreis angeben' }));
    expect(window.location.hash).toBe('#/anlage/s-1/technik?abschnitt=geld');
    expect(ersteWerteOffen('s-1')).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Ihre Anlage ist live.' })).toBeNull();
  });

  it('mit Strompreis kein Schritt, nur Schließen - und danach nie wieder', () => {
    merkeErsteWerte('s-1');
    render(<AnlageHinweise site={{ ...site, tarifArt: 'fest', tarifParamCtKwh: 32 }} ersteWerte standort={null} onGespeichert={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Strompreis angeben' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hinweis schließen' }));
    expect(ersteWerteOffen('s-1')).toBe(false);
  });
});

describe('„Wo steht …?“ - die Adresse eines automatischen Standorts (D9)', () => {
  it('eine Eingabe vervollständigt den Standort - der Name bleibt, den Rest benennt der Server', async () => {
    vi.spyOn(api, 'orteSuche').mockResolvedValue({
      treffer: [{ strasse: 'Hauptstraße', hausnummer: '12', plz: '91710', ort: 'Gunzenhausen', land: 'DE', breitengrad: 49.11, laengengrad: 10.75 }],
      quelle: '© OpenStreetMap-Mitwirkende',
    } as never);
    const standort = {
      id: 'st-1', kurzzeichen: 'ST-1', name: 'Simulation', adresse: null, zeitzone: 'Europe/Berlin', zustand: 'entwurf',
      esFehlt: ['adresse'], nutzung: null, notiz: null,
    } as unknown as StandortAmStichtag;
    vi.spyOn(api, 'standorte').mockResolvedValue({ stichtag: '2026-10-23', standorte: [standort] } as never);
    const bearbeiten = vi.spyOn(api, 'standortBearbeiten').mockResolvedValue(standort);
    const onGespeichert = vi.fn();
    render(<AnlageHinweise site={site} ersteWerte={false} standort={ENTWURF} onGespeichert={onGespeichert} />);

    expect(screen.getByRole('heading', { name: 'Wo steht Simulation?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adresse angeben' }));
    // Ohne Eingabe: der Satz am Feld, nichts gesendet.
    fireEvent.click(screen.getByRole('button', { name: 'Adresse speichern' }));
    expect(await screen.findByText('Bitte geben Sie die Adresse an - Straße und Hausnummer genügen.')).toBeInTheDocument();
    // Getippt, nicht gewählt: der erste Vorschlag gilt, mit Pin zur Kontrolle (F5) - erst der zweite Klick speichert.
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: 'Hauptstr 12 gun' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adresse speichern' }));
    await waitFor(() => expect(screen.getByLabelText('Adresse')).toHaveValue('Hauptstraße 12, 91710 Gunzenhausen'));
    expect(bearbeiten).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Adresse speichern' }));
    await waitFor(() => expect(onGespeichert).toHaveBeenCalled());
    expect(bearbeiten).toHaveBeenCalledWith('st-1', {
      name: 'Simulation',
      kurzzeichen: 'ST-1',
      adresse: { strasse: 'Hauptstraße 12', plz: '91710', ort: 'Gunzenhausen', land: 'DE' },
      zeitzone: 'Europe/Berlin',
      nutzung: null,
      notiz: null,
      lage: { breitengrad: 49.11, laengengrad: 10.75 },
    });
  });
});
