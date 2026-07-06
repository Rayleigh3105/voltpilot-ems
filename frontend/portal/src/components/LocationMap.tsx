import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { fmtCoords } from '../format';
import {
  coordFieldValue,
  DACH_CENTER,
  DACH_ZOOM,
  parseCoordInput,
  PIN_ZOOM,
  roundCoord,
  syncFromFields,
} from './geo';

/** Does a manual field string already represent this (rounded) coordinate? */
function fieldMatches(str: string, num: number | null): boolean {
  const parsed = parseCoordInput(str);
  if (num == null) return parsed == null; // both empty
  if (parsed == null || Number.isNaN(parsed)) return false;
  return roundCoord(parsed) === num;
}

/**
 * The site location input IS a map with a draggable pin (captain: "Mach einfach
 * eine Karte mit verschiebbarem Pin"). One shared, controlled component for all
 * three site forms (create drawer, edit form, onboarding). Parents keep the
 * coordinates as `number | null` and this component owns the map, the readable
 * coordinate line, and an expert "manuell bearbeiten" field pair kept in sync
 * with the pin.
 *
 * - No pin yet: a DACH-level view invites a tap to place the pin (click-to-place).
 * - Pin placed: a brand-blue marker the customer can drag to fine-tune.
 * - Search result (onboarding): the parent just sets lat/lon and the map flies
 *   there; the customer can then fine-drag.
 *
 * Keyless OpenStreetMap tiles; the pin is a CSS/SVG DivIcon (no image assets, so
 * nothing breaks under the bundler). Scroll-wheel zoom is off so the page keeps
 * scrolling over the map; +/- buttons and one-finger touch drag handle zoom/pan.
 */
export function LocationMap({
  lat,
  lon,
  onChange,
}: {
  lat: number | null;
  lon: number | null;
  onChange: (lat: number | null, lon: number | null) => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // Latest onChange without re-binding leaflet handlers every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [manualOpen, setManualOpen] = useState(false);
  const [latStr, setLatStr] = useState(coordFieldValue(lat));
  const [lonStr, setLonStr] = useState(coordFieldValue(lon));
  const [latError, setLatError] = useState<string | null>(null);
  const [lonError, setLonError] = useState<string | null>(null);
  // Latest field text without adding it to the sync effect's deps (which would
  // reformat the field on every keystroke).
  const latStrRef = useRef(latStr);
  latStrRef.current = latStr;
  const lonStrRef = useRef(lonStr);
  lonStrRef.current = lonStr;

  const hasPin = lat != null && lon != null;

  function place(nextLat: number, nextLon: number) {
    onChangeRef.current(roundCoord(nextLat), roundCoord(nextLon));
  }

  // Init the map once.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, {
      center: hasPin ? [lat as number, lon as number] : DACH_CENTER,
      zoom: hasPin ? PIN_ZOOM : DACH_ZOOM,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      place(e.latlng.lat, e.latlng.lng);
    });
    mapRef.current = map;
    // Leaflet needs a size recalculation once the container has laid out
    // (drawers/onboarding cards animate in).
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the current lat/lon onto the marker + view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (lat == null || lon == null) {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      return;
    }

    const pos = L.latLng(lat, lon);
    if (!markerRef.current) {
      const icon = L.divIcon({
        className: 'vp-map-pin-icon',
        html:
          '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">' +
          '<path d="M12 2C7.86 2 4.5 5.36 4.5 9.5c0 5.13 6.2 11.4 6.86 12.06a.9.9 0 0 0 1.28 0C13.3 20.9 19.5 14.63 19.5 9.5 19.5 5.36 16.14 2 12 2z"/>' +
          '<circle cx="12" cy="9.5" r="2.8" fill="#fff"/></svg>',
        iconSize: [34, 34],
        iconAnchor: [17, 32],
      });
      const marker = L.marker(pos, { icon, draggable: true, keyboard: false }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        place(p.lat, p.lng);
      });
      markerRef.current = marker;
      map.setView(pos, Math.max(map.getZoom(), PIN_ZOOM));
    } else {
      markerRef.current.setLatLng(pos);
      // Recenter only on a jump the user can't see (e.g. an address search),
      // never on a small in-view drag - that would fight the drag.
      if (!map.getBounds().contains(pos)) {
        map.setView(pos, Math.max(map.getZoom(), PIN_ZOOM));
      }
    }
  }, [lat, lon]);

  // Keep the manual fields in step with external changes (pin drag, search,
  // clear). We only rewrite a field when its text no longer represents the
  // incoming coordinate, so the value the user is actively typing is never
  // reformatted under the cursor - and there is no stale suppression flag to get
  // stuck when a manual edit resolves to the same coordinate (a no-op onChange).
  useEffect(() => {
    if (!fieldMatches(latStrRef.current, lat)) {
      setLatStr(coordFieldValue(lat));
      setLatError(null);
    }
    if (!fieldMatches(lonStrRef.current, lon)) {
      setLonStr(coordFieldValue(lon));
      setLonError(null);
    }
  }, [lat, lon]);

  function editField(which: 'lat' | 'lon', value: string) {
    const nextLat = which === 'lat' ? value : latStr;
    const nextLon = which === 'lon' ? value : lonStr;
    if (which === 'lat') setLatStr(value);
    else setLonStr(value);
    const sync = syncFromFields(nextLat, nextLon);
    setLatError(sync.latError);
    setLonError(sync.lonError);
    if (sync.ok) {
      // Nullable-safe: a half-filled pair must not round null into 0. The sync
      // effect leaves the field text the user is typing untouched (fieldMatches).
      onChangeRef.current(
        sync.lat == null ? null : roundCoord(sync.lat),
        sync.lon == null ? null : roundCoord(sync.lon),
      );
    }
  }

  const coordLine = fmtCoords(lat, lon);

  return (
    <div className="vp-map-field">
      <div className="vp-map" ref={mapEl} role="application" aria-label="Standortkarte">
        {!hasPin && (
          <div className="vp-map-hint" aria-hidden="true">
            <Icon name="map-pin" size={16} />
            <span>Tippen Sie auf die Karte, um den Standort zu setzen</span>
          </div>
        )}
      </div>
      <div className="vp-map-coords">
        <Icon name="map-pin" size={15} />
        {coordLine ? (
          <span>{coordLine}</span>
        ) : (
          <span className="vp-muted">Noch kein Standort gesetzt (optional)</span>
        )}
        {hasPin && (
          <button
            type="button"
            className="vp-linklike"
            onClick={() => onChange(null, null)}
            style={{ marginLeft: 'auto' }}
          >
            Entfernen
          </button>
        )}
      </div>
      <button
        type="button"
        className="vp-linklike vp-map-manual-toggle"
        aria-expanded={manualOpen}
        onClick={() => setManualOpen((o) => !o)}
      >
        <Icon name={manualOpen ? 'chevron-down' : 'chevron-right'} size={14} />
        Koordinaten manuell bearbeiten
      </button>
      {manualOpen && (
        <div className="vp-map-manual">
          <Input
            label="Breitengrad"
            placeholder="z. B. 52,52"
            inputMode="decimal"
            value={latStr}
            error={latError}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => editField('lat', e.target.value)}
          />
          <Input
            label="Längengrad"
            placeholder="z. B. 13,405"
            inputMode="decimal"
            value={lonStr}
            error={lonError}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => editField('lon', e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
