import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { ApiError, type CreateSiteInput, type PlantKind, type Site } from '../api';
import { LocationMap } from './LocationMap';

/**
 * "Standort anlegen" as a right drawer (the repeatable entity pattern). The
 * actual create call comes in via `onCreate` so the same drawer serves the
 * customer path (POST /api/v1/sites - tenant from the JWT) and the admin path
 * (POST /api/v1/admin/tenants/{id}/sites - tenant from the route).
 */
export function CreateSiteDrawer({
  open,
  onClose,
  onCreate,
  onCreated,
  contextNote,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateSiteInput) => Promise<Site>;
  onCreated: (site: Site) => void;
  /** Optional context line, e.g. which tenant the site is created for. */
  contextNote?: string;
}) {
  const [name, setName] = useState('');
  const [biddingZone, setBiddingZone] = useState('DE-LU');
  const [plantKind, setPlantKind] = useState<PlantKind>('eigenverbrauch');
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setLat(null);
    setLon(null);
    setBiddingZone('DE-LU');
    setPlantKind('eigenverbrauch');
    setError(null);
  }

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const site = await onCreate({
        name: name.trim(),
        biddingZone,
        latitude: lat,
        longitude: lon,
        plantKind,
      });
      reset();
      onCreated(site);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie Name und Koordinaten.'
          : 'Der Standort konnte nicht angelegt werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Standort anlegen"
      icon={
        <IconTile category="home" size={40}>
          <Icon name="map-pin" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Wird angelegt…' : 'Standort anlegen'}
          </Button>
        </>
      }
    >
      {contextNote && <p className="vp-note" style={{ marginTop: 0 }}>{contextNote}</p>}
      <div className="vp-form-stack">
        <Input
          label="Name *"
          placeholder="z. B. Werk Nord"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="site-zone" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Gebotszone
          </label>
          <select
            id="site-zone"
            className="vp-select"
            value={biddingZone}
            onChange={(e) => setBiddingZone(e.target.value)}
          >
            <option value="DE-LU">DE-LU (Deutschland/Luxemburg)</option>
            <option value="AT">AT (Österreich)</option>
            <option value="CH">CH (Schweiz)</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="site-plant-kind" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Anlagentyp
          </label>
          <select
            id="site-plant-kind"
            className="vp-select"
            value={plantKind}
            onChange={(e) => setPlantKind(e.target.value as PlantKind)}
          >
            <option value="eigenverbrauch">Eigenverbrauch (Haushalt/Gewerbe)</option>
            <option value="direktvermarktung">Direktvermarktung (Einspeisung am Markt)</option>
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            Bestimmt, wie Ihr Vorteil erzählt wird: „gespart" beim Eigenverbrauch,
            „mehr verdient" bei der Direktvermarktung.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label style={{ fontSize: '0.9rem', fontWeight: 600 }}>Standort auf der Karte</label>
          <LocationMap
            lat={lat}
            lon={lon}
            onChange={(la, lo) => {
              setLat(la);
              setLon(lo);
            }}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            Setzen Sie den Pin auf Ihren Standort - nötig für die Wettervorhersage. Optional.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
  );
}
