import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SiteEditForm } from './StandortePage';
import { api, type Site } from '../api';

// Leaflet (pulled in via LocationMap) needs real layout that jsdom lacks -
// mock it like LocationMap.test.tsx does; the map itself is not under test.
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

const eegSite: Site = {
  id: 's-1',
  name: 'Hof Sonnenfeld',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  marktpraemieCtKwh: null,
  netzladenErlaubt: false,
};

describe('SiteEditForm (netzladen switch, captain revision 2026-07-07)', () => {
  it('renders the editable switch for site owners - no read-only admin note anymore', () => {
    render(<SiteEditForm site={eegSite} onCancel={() => {}} onSaved={() => {}} />);
    const select = screen.getByLabelText('Netzladen des Speichers') as HTMLSelectElement;
    expect(select.value).toBe('verboten');
    // The Ausschließlichkeitsprinzip warning stays, carrying the responsibility.
    expect(screen.getByText(/Ausschließlichkeitsprinzip/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nur aktivieren, wenn Ihre Anlage keine\s+EEG-Vergütung bezieht/),
    ).toBeInTheDocument();
    // The former customer read-only note is gone.
    expect(screen.queryByText(/Änderung nur durch den Betreiber/)).not.toBeInTheDocument();
  });

  it('sends the flipped netzladenErlaubt value on save', async () => {
    const updateSite = vi
      .spyOn(api, 'updateSite')
      .mockResolvedValue({ ...eegSite, netzladenErlaubt: true });
    const onSaved = vi.fn();
    render(<SiteEditForm site={eegSite} onCancel={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Netzladen des Speichers'), {
      target: { value: 'erlaubt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Änderungen speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateSite).toHaveBeenCalledWith(
      eegSite.id,
      expect.objectContaining({ netzladenErlaubt: true }),
    );
    updateSite.mockRestore();
  });
});
