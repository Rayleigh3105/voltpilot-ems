import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { coordFieldValue, parseCoordInput, roundCoord, syncFromFields } from './geo';

/** Does a manual field string already represent this (rounded) coordinate? */
function fieldMatches(str: string, num: number | null): boolean {
  const parsed = parseCoordInput(str);
  if (num == null) return parsed == null;
  if (parsed == null || Number.isNaN(parsed)) return false;
  return roundCoord(parsed) === num;
}

/**
 * Der Umschalter "Koordinaten manuell bearbeiten" + Breiten-/Längengrad-Felder - aus
 * {@link LocationMap} herausgezogen (vp-standort-konzept §6.1, captain-Korrektur), damit ihn
 * {@link AnlageOrtBlatt} unter "Details" zeigen kann statt direkt unter der Karte. `LocationMap`
 * rendert dasselbe Stück für ihre anderen Verwender unverändert selbst (`manuellAusblenden`
 * unterdrückt dort nur ihre eigene Kopie).
 */
export function KoordinatenManuellFelder({
  lat,
  lon,
  onChange,
}: {
  lat: number | null;
  lon: number | null;
  onChange: (lat: number | null, lon: number | null) => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [latStr, setLatStr] = useState(coordFieldValue(lat));
  const [lonStr, setLonStr] = useState(coordFieldValue(lon));
  const [latError, setLatError] = useState<string | null>(null);
  const [lonError, setLonError] = useState<string | null>(null);
  // Latest field text without adding it to the sync effect's deps (die Effekt-Abhängigkeit wäre
  // sonst der getippte Text selbst - der sich beim Tippen nicht unter dem Cursor reformatieren darf).
  const latStrRef = useRef(latStr);
  latStrRef.current = latStr;
  const lonStrRef = useRef(lonStr);
  lonStrRef.current = lonStr;

  // Die Felder einer äußeren Änderung nachziehen (gezogener Pin, Adresssuche) - nur, wenn ihr
  // Text die ankommende Koordinate nicht mehr darstellt, sonst reformatierte das die Eingabe.
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
      onChange(sync.lat == null ? null : roundCoord(sync.lat), sync.lon == null ? null : roundCoord(sync.lon));
    }
  }

  return (
    <>
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
    </>
  );
}
