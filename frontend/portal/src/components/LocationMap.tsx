import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from '../../designsystem/components/core/Icon';
import { type OrtTreffer } from '../api';
import { api } from '../apiVoll';
import { fmtCoords } from '../format';
import { DACH_CENTER, DACH_ZOOM, PIN_ZOOM, roundCoord } from './geo';
import { KoordinatenManuellFelder } from './KoordinatenManuellFelder';

/** Hausgenau - so nah, dass der Pin aufs Dach gezogen werden kann. */
const HAUS_ZOOM = 18;

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
  readonly = false,
  kompakt = false,
  fokus = 0,
  ortAufloesen = false,
  onOrtAufgeloest,
  pflichtPunkt = false,
  manuellAusblenden = false,
}: {
  lat: number | null;
  lon: number | null;
  onChange: (lat: number | null, lon: number | null) => void;
  /**
   * Anlage-Flow a1: jeder neue Wert (eine gewählte Hausadresse) holt die Karte aufs Haus
   * ({@link HAUS_ZOOM}), damit der Pin aufs Dach gezogen werden kann. 0 = nie.
   */
  fokus?: number;
  /**
   * Display-only preview (the Technik "Meine Anlage" read-first view): the pin
   * is not draggable, the map does not accept clicks, and the coordinate
   * expander / "Entfernen" affordances are hidden. Default false keeps the full
   * interactive editor for the three site forms.
   */
  readonly?: boolean;
  /**
   * vp-standort-konzept E3: die winzige Karte (58×44 px) in der Standort-Zeile — nur die Kachel,
   * ohne Koordinaten-Zeile und ohne Attributions-Kontrolle (die liegt unleserlich in der Ecke; das
   * Blatt dahinter, das ein Tipp öffnet, zeigt die volle, attributierte Karte). Immer mit
   * {@code readonly}.
   */
  kompakt?: boolean;
  /**
   * Task vp-anlage-adresse-ux: ein Klick oder gezogener Pin löst sich zusätzlich in eine lesbare
   * Adresse auf (`GET /api/v1/orte/rueckwaerts`), wenn erreichbar - sonst bleibt nur der Punkt
   * stehen, ehrlich ohne Adresstext. Default aus, damit die anderen Verwender dieser gemeinsamen
   * Karte (Drawer, Standort-Bearbeiten) unverändert bleiben.
   */
  ortAufloesen?: boolean;
  /** Die aufgelöste Adresse - NIE ihren Punkt übernehmen, der Pin bleibt exakt, wo er gesetzt wurde. */
  onOrtAufgeloest?: (treffer: OrtTreffer) => void;
  /**
   * vp-standort-konzept §6.1 (Regel 5: nie ohne Punkt speichern): in der Zeile „Standort" gehören
   * Adresse und Punkt untrennbar zusammen - „Entfernen" hätte hier keine Wirkung (der Wirt lehnt
   * einen leeren Punkt ab) und bliebe ein totes Bedienelement. Blendet nur den Knopf aus, die
   * Koordinaten-Zeile und „Koordinaten manuell bearbeiten" bleiben.
   */
  pflichtPunkt?: boolean;
  /**
   * vp-standort-konzept §6.1 (captain-Korrektur): im Blatt „Ort berichtigen" steht „Koordinaten
   * manuell bearbeiten" unter „Details", nicht mehr direkt unter der Karte - diese Karte blendet
   * dann ihre eigene Kopie aus, der Wirt rendert {@link KoordinatenManuellFelder} selbst, wo er sie
   * haben will. Für alle anderen Verwender unverändert (Default aus).
   */
  manuellAusblenden?: boolean;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // Latest onChange without re-binding leaflet handlers every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const hasPin = lat != null && lon != null;

  // Rückwärts-Auflösung eines geklickten/gezogenen Pins (nie eines Sprungs aus der Suche - der
  // kennt die Adresse schon). Ehrlich: ein Fehlschlag lässt den Pin stehen und zeigt nur nichts.
  const [aufloesung, setAufloesung] = useState<{ laedt: boolean; text: string | null; ausfall: boolean }>({
    laedt: false,
    text: null,
    ausfall: false,
  });
  const aufloesungRunde = useRef(0);
  const onOrtAufgeloestRef = useRef(onOrtAufgeloest);
  onOrtAufgeloestRef.current = onOrtAufgeloest;

  function place(nextLat: number, nextLon: number) {
    const rLat = roundCoord(nextLat);
    const rLon = roundCoord(nextLon);
    onChangeRef.current(rLat, rLon);
    if (!ortAufloesen) return;
    const meine = ++aufloesungRunde.current;
    setAufloesung({ laedt: true, text: null, ausfall: false });
    api.orteRueckwaerts(rLat, rLon).then(
      (a) => {
        if (meine !== aufloesungRunde.current) return;
        const t = a.treffer[0];
        if (t) {
          setAufloesung({ laedt: false, text: t.text, ausfall: false });
          onOrtAufgeloestRef.current?.(t);
        } else {
          setAufloesung({ laedt: false, text: null, ausfall: false });
        }
      },
      () => {
        if (meine !== aufloesungRunde.current) return;
        setAufloesung({ laedt: false, text: null, ausfall: true });
      },
    );
  }

  // Init the map once.
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, {
      center: hasPin ? [lat as number, lon as number] : DACH_CENTER,
      zoom: hasPin ? PIN_ZOOM : DACH_ZOOM,
      scrollWheelZoom: false,
      attributionControl: !kompakt,
      ...(readonly
        ? { dragging: false, doubleClickZoom: false, zoomControl: false, keyboard: false }
        : {}),
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap',
    }).addTo(map);
    if (!readonly) {
      map.on('click', (e: L.LeafletMouseEvent) => {
        place(e.latlng.lat, e.latlng.lng);
      });
    }
    mapRef.current = map;
    // Leaflet needs a size recalculation once the container has laid out
    // (drawers/onboarding cards animate in). Guard against the map having
    // been removed before the timeout fires (drawer closed within the same
    // tick) - invalidateSize on a removed map throws inside Leaflet.
    setTimeout(() => {
      if (mapRef.current === map) map.invalidateSize();
    }, 0);
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
      // Kompakt (58×44 px, E3): die normale Pin-Spitze zeigt auf den Punkt und ragt mit ihrem
      // Körper nach oben aus der Kachel - in 44 px Höhe sieht das wie "am oberen Rand klebend"
      // aus (captain). Dort reicht ein kleiner, am Mittelpunkt verankerter Punkt.
      const icon = kompakt
        ? L.divIcon({
            className: 'vp-map-pin-icon',
            html:
              '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
              '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="#fff" stroke-width="2.5"/></svg>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          })
        : L.divIcon({
            className: 'vp-map-pin-icon',
            html:
              '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">' +
              '<path d="M12 2C7.86 2 4.5 5.36 4.5 9.5c0 5.13 6.2 11.4 6.86 12.06a.9.9 0 0 0 1.28 0C13.3 20.9 19.5 14.63 19.5 9.5 19.5 5.36 16.14 2 12 2z"/>' +
              '<circle cx="12" cy="9.5" r="2.8" fill="#fff"/></svg>',
            iconSize: [34, 34],
            iconAnchor: [17, 32],
          });
      const marker = L.marker(pos, { icon, draggable: !readonly, keyboard: false }).addTo(map);
      if (!readonly) {
        marker.on('dragend', () => {
          const p = marker.getLatLng();
          place(p.lat, p.lng);
        });
      }
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

  // Eine gewählte Adresse: aufs Haus, nicht nur auf den Ort. Eine stehende Klick-Auflösung gehört
  // dann nicht mehr zum neuen Punkt - ehrlich löschen statt stehen lassen.
  useEffect(() => {
    const map = mapRef.current;
    if (!fokus) return;
    aufloesungRunde.current++;
    setAufloesung({ laedt: false, text: null, ausfall: false });
    if (!map || lat == null || lon == null) return;
    map.setView(L.latLng(lat, lon), HAUS_ZOOM);
    // Nur der Anstoß zählt, nicht jeder gezogene Pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fokus]);

  const coordLine = fmtCoords(lat, lon);

  return (
    <div className={kompakt ? 'vp-map-field vp-map-field-kompakt' : 'vp-map-field'}>
      <div className="vp-map" ref={mapEl} role="application" aria-label="Standortkarte">
        {!hasPin && !readonly && (
          <div className="vp-map-hint" aria-hidden="true">
            <Icon name="map-pin" size={16} />
            <span>Tippen Sie auf die Karte, um den Standort zu setzen</span>
          </div>
        )}
      </div>
      {!kompakt && (
        <div className="vp-map-coords">
          <Icon name="map-pin" size={15} />
          {coordLine ? (
            <span>{coordLine}</span>
          ) : (
            <span className="vp-muted">Noch kein Standort gesetzt (optional)</span>
          )}
          {hasPin && !readonly && !pflichtPunkt && (
            <button
              type="button"
              className="vp-linklike"
              onClick={() => {
                aufloesungRunde.current++;
                setAufloesung({ laedt: false, text: null, ausfall: false });
                onChange(null, null);
              }}
              style={{ marginLeft: 'auto' }}
            >
              Entfernen
            </button>
          )}
        </div>
      )}
      {!kompakt && ortAufloesen && hasPin && (aufloesung.laedt || aufloesung.text || aufloesung.ausfall) && (
        <p className="vp-map-aufloesung" aria-live="polite">
          {aufloesung.laedt && <span className="vp-muted">Adresse zu diesem Punkt wird ermittelt …</span>}
          {!aufloesung.laedt && aufloesung.text && <span>{aufloesung.text}</span>}
          {!aufloesung.laedt && aufloesung.ausfall && (
            <span className="vp-muted">Adresse zu diesem Punkt gerade nicht ermittelbar - der Punkt bleibt gesetzt.</span>
          )}
        </p>
      )}
      {!readonly && !manuellAusblenden && (
        <KoordinatenManuellFelder lat={lat} lon={lon} onChange={onChange} />
      )}
    </div>
  );
}
