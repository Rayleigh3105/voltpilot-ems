import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { LocationMap } from './LocationMap';

// Leaflet needs real layout (offsetWidth/height) that jsdom lacks, so we mock it
// and assert the React logic the component actually owns: the readable coordinate
// line, the "manuell bearbeiten" expander, and the pin<->field synchronisation.
// The map rendering itself is covered by the real-browser verification.
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

describe('LocationMap', () => {
  it('prompts to place a pin when no coordinates are set', () => {
    render(<LocationMap lat={null} lon={null} onChange={() => {}} />);
    expect(screen.getByText(/Tippen Sie auf die Karte/)).toBeInTheDocument();
    expect(screen.getByText(/Noch kein Standort gesetzt/)).toBeInTheDocument();
  });

  it('shows the resolved coordinates as a readable line when a pin exists', () => {
    render(<LocationMap lat={52.52} lon={13.405} onChange={() => {}} />);
    // fmtCoords: "52,5200° N · 13,4050° O"
    expect(screen.getByText(/52,5200° N/)).toBeInTheDocument();
    expect(screen.getByText(/13,4050° O/)).toBeInTheDocument();
    // The place-prompt hint is gone once a pin is set.
    expect(screen.queryByText(/Tippen Sie auf die Karte/)).not.toBeInTheDocument();
  });

  it('reveals expert fields prefilled from the pin when "manuell bearbeiten" is opened', () => {
    render(<LocationMap lat={52.52} lon={13.405} onChange={() => {}} />);
    fireEvent.click(screen.getByText(/manuell bearbeiten/));
    expect((screen.getByLabelText('Breitengrad') as HTMLInputElement).value).toBe('52.52');
    expect((screen.getByLabelText('Längengrad') as HTMLInputElement).value).toBe('13.405');
  });

  it('propagates a manual field edit back to the parent (fields -> pin)', () => {
    const onChange = vi.fn();
    render(<LocationMap lat={52.52} lon={13.405} onChange={onChange} />);
    fireEvent.click(screen.getByText(/manuell bearbeiten/));
    fireEvent.change(screen.getByLabelText('Breitengrad'), { target: { value: '48,1' } });
    expect(onChange).toHaveBeenLastCalledWith(48.1, 13.405);
  });

  it('shows an inline error and does not propagate an out-of-range coordinate', () => {
    const onChange = vi.fn();
    render(<LocationMap lat={52.52} lon={13.405} onChange={onChange} />);
    fireEvent.click(screen.getByText(/manuell bearbeiten/));
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText('Breitengrad'), { target: { value: '999' } });
    expect(screen.getByText(/zwischen -90 und 90/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still reflects an external change after a manual edit that resolved to the same coordinate', () => {
    // A controlled parent, so a manual edit round-trips through props exactly
    // like the real forms. Regression: a manual edit equal to the current value
    // (a no-op onChange) must not stop a later external change from syncing.
    function Parent() {
      const [lat, setLat] = useState<number | null>(52.52);
      const [lon, setLon] = useState<number | null>(13.405);
      return (
        <>
          <LocationMap lat={lat} lon={lon} onChange={(la, lo) => { setLat(la); setLon(lo); }} />
          <button type="button" onClick={() => { setLat(48.1); setLon(11.6); }}>
            extern
          </button>
        </>
      );
    }
    render(<Parent />);
    fireEvent.click(screen.getByText(/manuell bearbeiten/));
    // Re-type the same latitude -> onChange is a no-op (props unchanged).
    fireEvent.change(screen.getByLabelText('Breitengrad'), { target: { value: '52.52' } });
    // An external change (e.g. a pin drag or address search) must now sync.
    fireEvent.click(screen.getByText('extern'));
    expect((screen.getByLabelText('Breitengrad') as HTMLInputElement).value).toBe('48.1');
    expect((screen.getByLabelText('Längengrad') as HTMLInputElement).value).toBe('11.6');
  });

  it('clears the location via "Entfernen"', () => {
    const onChange = vi.fn();
    render(<LocationMap lat={52.52} lon={13.405} onChange={onChange} />);
    fireEvent.click(screen.getByText('Entfernen'));
    expect(onChange).toHaveBeenCalledWith(null, null);
  });
});
