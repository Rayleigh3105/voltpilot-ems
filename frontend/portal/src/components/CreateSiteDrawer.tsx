import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { ApiError, type CreateSiteInput, type Site } from '../api';

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
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latError, setLatError] = useState<string | null>(null);
  const [lonError, setLonError] = useState<string | null>(null);

  function parseCoord(v: string): number | null | undefined {
    if (!v.trim()) return undefined;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  function reset() {
    setName('');
    setLatitude('');
    setLongitude('');
    setBiddingZone('DE-LU');
    setError(null);
    setLatError(null);
    setLonError(null);
  }

  async function submit() {
    if (!name.trim()) return;
    const lat = parseCoord(latitude);
    const lon = parseCoord(longitude);
    const latBad = Number.isNaN(lat) || (lat != null && (lat < -90 || lat > 90));
    const lonBad = Number.isNaN(lon) || (lon != null && (lon < -180 || lon > 180));
    setLatError(latBad ? 'Bitte eine Zahl zwischen -90 und 90 eingeben, z. B. 52,52 - oder leer lassen.' : null);
    setLonError(lonBad ? 'Bitte eine Zahl zwischen -180 und 180 eingeben, z. B. 13,405 - oder leer lassen.' : null);
    if (latBad || lonBad) return;
    setBusy(true);
    setError(null);
    try {
      const site = await onCreate({
        name: name.trim(),
        biddingZone,
        latitude: lat ?? null,
        longitude: lon ?? null,
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
        <Input
          label="Breitengrad"
          placeholder="z. B. 52,52"
          inputMode="decimal"
          value={latitude}
          error={latError}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setLatitude(e.target.value);
            setLatError(null);
          }}
        />
        <Input
          label="Längengrad"
          placeholder="z. B. 13,405"
          inputMode="decimal"
          value={longitude}
          error={lonError}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setLongitude(e.target.value);
            setLonError(null);
          }}
          hint="Koordinaten sind optional, aber nötig für die Wettervorhersage."
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
  );
}
