import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateSiteDrawer } from './CreateSiteDrawer';
import type { Site } from '../api';

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

const createdSite: Site = {
  id: 's-1',
  name: 'Werk Nord',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  marktpraemieCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: true,
  maxFeedInKw: null,
};

describe('CreateSiteDrawer (netzladen switch, captain revision 2026-07-07)', () => {
  it('shows the grid-charging switch WITH the Ausschließlichkeitsprinzip warning for customers', () => {
    render(
      <CreateSiteDrawer
        open
        onClose={() => {}}
        onCreate={vi.fn()}
        onCreated={() => {}}
      />,
    );
    // The field renders without any admin flag - site owners may set it too.
    expect(screen.getByLabelText('Netzladen des Speichers')).toBeInTheDocument();
    // The responsibility-carrying warning stays so nobody flips it uninformed.
    expect(screen.getByText(/Ausschließlichkeitsprinzip/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nur aktivieren, wenn Ihre Anlage keine\s+EEG-Vergütung bezieht/),
    ).toBeInTheDocument();
  });

  it('sends the selected netzladenErlaubt value on create', async () => {
    const onCreate = vi.fn().mockResolvedValue(createdSite);
    render(
      <CreateSiteDrawer open onClose={() => {}} onCreate={onCreate} onCreated={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Werk Nord' } });
    fireEvent.change(screen.getByLabelText('Netzladen des Speichers'), {
      target: { value: 'erlaubt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: 'Werk Nord',
      netzladenErlaubt: true,
    });
  });

  it('defaults the switch to the compliant FALSE ("Nur Solarladen")', async () => {
    const onCreate = vi.fn().mockResolvedValue({ ...createdSite, netzladenErlaubt: false });
    render(
      <CreateSiteDrawer open onClose={() => {}} onCreate={onCreate} onCreated={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Hof Sonnenfeld' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlage anlegen' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({ netzladenErlaubt: false });
  });
});
