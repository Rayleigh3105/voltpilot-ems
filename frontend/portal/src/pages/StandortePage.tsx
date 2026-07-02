import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import {
  api,
  ApiError,
  type Device,
  type Site,
  type SiteAsset,
  type SiteDeletionPreview,
} from '../api';
import { deviceKindLabel, fmtCoords, fmtNum, fmtRelative } from '../format';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { DangerZone } from '../components/DangerZone';
import { DeviceStatusBadge } from '../components/DeviceDrawers';
import { MastrDrawer } from '../components/MastrDrawer';

/**
 * Standorte: the repeatable entity pattern - list-in-card, "＋ anlegen" opens
 * the add drawer, a row click opens the detail drawer (site facts + Anlage +
 * devices). The Anlage section is the optional MaStR link step.
 */
export function StandortePage({
  sites,
  devices,
  onReload,
}: {
  sites: Site[];
  devices: Device[];
  onReload: (selectSiteId?: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<Site | null>(null);
  const [mastrOpen, setMastrOpen] = useState(false);
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<SiteDeletionPreview | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deviceCount = (siteId: string) => devices.filter((d) => d.siteId === siteId).length;

  useEffect(() => {
    setEditing(false);
    setPreview(null);
    setDeleteError(null);
    if (!detail) {
      setAssets(null);
      return;
    }
    let cancelled = false;
    api
      .siteAssets(detail.id)
      .then((a) => {
        if (!cancelled) setAssets(a);
      })
      .catch(() => {
        if (!cancelled) setAssets([]);
      });
    api
      .siteDeletionPreview(detail.id)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        // The delete stays available; the consequence list just shows less detail.
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.id]);

  async function deleteSite(site: Site) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteSite(site.id);
      setDetail(null);
      onReload();
    } catch (e) {
      setDeleteError(
        e instanceof ApiError && e.status === 409
          ? 'Der Standort hat noch Geräte. Bitte entfernen Sie zuerst alle Geräte dieses Standorts.'
          : 'Der Standort konnte nicht gelöscht werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

  function deleteConsequences(site: Site): string[] {
    const items = [`Der Standort „${site.name}" mit allen Anlagendaten`];
    if (preview && preview.telemetryCount > 0 && preview.telemetryFrom && preview.telemetryTo) {
      items.push(
        `Alle Messdaten (${fmtNum(preview.telemetryCount, '', 0)} Messpunkte vom ${fmtDay(preview.telemetryFrom)} bis ${fmtDay(preview.telemetryTo)})`,
      );
    } else {
      items.push('Alle aufgezeichneten Messdaten dieses Standorts');
    }
    if (preview && (preview.forecastCount > 0 || preview.scheduleCount > 0)) {
      items.push('Alle Prognosen und Fahrpläne dieses Standorts');
    }
    if (preview && preview.weatherCount > 0) {
      items.push('Die gespeicherten Wetterdaten dieses Standorts');
    }
    return items;
  }

  const linkedAssets = (assets ?? []).filter((a) => a.registry != null);
  const pvAsset = linkedAssets.find((a) => a.type === 'pv');
  const batteryAsset = linkedAssets.find((a) => a.type === 'battery');
  const lastFetched = linkedAssets
    .map((a) => a.registryFetchedAt)
    .filter((t): t is string => t != null)
    .sort()
    .pop();

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Standorte</h1>
          <p>Ihre Standorte mit Gebotszone, Koordinaten und Geräten.</p>
        </div>
        <div className="actions">
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
            Standort anlegen
          </Button>
        </div>
      </div>

      {sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="home" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="map-pin" size={24} />
            </IconTile>
            <h3>Noch kein Standort</h3>
            <p>Legen Sie Ihren ersten Standort an - danach können Sie ihm Geräte zuordnen.</p>
            <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
              Ersten Standort anlegen
            </Button>
          </div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Name</th>
                <th>Gebotszone</th>
                <th>Koordinaten</th>
                <th>Geräte</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => setDetail(s)}>
                  <td data-label="Name">
                    <b>{s.name}</b>
                  </td>
                  <td data-label="Gebotszone">
                    <Badge variant="tint">{s.biddingZone}</Badge>
                  </td>
                  <td data-label="Koordinaten">
                    {fmtCoords(s.latitude, s.longitude) ?? <span className="vp-muted">-</span>}
                  </td>
                  <td data-label="Geräte">{deviceCount(s.id)}</td>
                  <td data-label="">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        setDetail(s);
                      }}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CreateSiteDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreate={(input) => api.createSite(input)}
        onCreated={(s) => onReload(s.id)}
      />

      {detail && (
        <Drawer
          open
          onClose={() => setDetail(null)}
          title={detail.name}
          icon={
            <IconTile category="home" size={40}>
              <Icon name="map-pin" size={20} />
            </IconTile>
          }
          footer={
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Schließen
            </Button>
          }
        >
          <div style={{ display: 'flex', gap: 'var(--vp-space-2)', flexWrap: 'wrap', marginBottom: 'var(--vp-space-5)' }}>
            <Badge variant="tint">{detail.biddingZone}</Badge>
            {linkedAssets.length > 0 && (
              <Badge variant="ok" dot>
                MaStR verknüpft
              </Badge>
            )}
            {fmtCoords(detail.latitude, detail.longitude) && (
              <span className="vp-note" style={{ alignSelf: 'center' }}>
                {fmtCoords(detail.latitude, detail.longitude)}
              </span>
            )}
            {!editing && (
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<Icon name="pencil" size={16} />}
                onClick={() => setEditing(true)}
                style={{ marginLeft: 'auto' }}
              >
                Bearbeiten
              </Button>
            )}
          </div>

          {editing && (
            <SiteEditForm
              site={detail}
              onCancel={() => setEditing(false)}
              onSaved={(updated) => {
                setDetail(updated);
                setEditing(false);
                onReload(updated.id);
              }}
            />
          )}

          {!editing && detail.latitude == null && (
            <div className="vp-alert vp-alert-info" style={{ marginTop: 0, marginBottom: 'var(--vp-space-4)' }}>
              Ohne Koordinaten gibt es keine Wettervorhersage für diesen Standort.
            </div>
          )}

          {!editing && (
          <>
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
            <h2 style={{ fontSize: '1.05rem' }}>Anlage</h2>
          </div>
          {assets === null ? (
            <p className="vp-muted">Anlagendaten werden geladen…</p>
          ) : linkedAssets.length === 0 ? (
            <>
              <p className="vp-muted">
                Optional: Verknüpfen Sie Ihre PV-Anlage (und ggf. den Speicher) mit dem
                Marktstammdatenregister, damit Prognose und Optimierung mit den amtlich
                registrierten Werten rechnen.
              </p>
              <Button
                variant="outline"
                iconLeft={<Icon name="sun" size={16} />}
                onClick={() => setMastrOpen(true)}
                style={{ marginBottom: 'var(--vp-space-5)' }}
              >
                Anlage verknüpfen
              </Button>
            </>
          ) : (
            <>
              <table className="vp-table" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <tbody>
                  {pvAsset && (
                    <>
                      <tr>
                        <th scope="row">PV-Leistung</th>
                        <td>
                          {pvAsset.pvCapacityKwp != null ? fmtNum(pvAsset.pvCapacityKwp, 'kWp', 2) : '-'}
                          {pvAsset.moduleCount != null ? ` · ${pvAsset.moduleCount} Module` : ''}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Ausrichtung / Neigung</th>
                        <td>
                          {pvAsset.azimuthDeg != null ? fmtNum(pvAsset.azimuthDeg, '°', 0) : 'Standard (Süd)'}
                          {' / '}
                          {pvAsset.tiltDeg != null ? fmtNum(pvAsset.tiltDeg, '°', 0) : 'Standard (30°)'}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">MaStR-Nummer PV</th>
                        <td className="vp-mono">{pvAsset.registryUnitId}</td>
                      </tr>
                    </>
                  )}
                  {batteryAsset && (
                    <>
                      <tr>
                        <th scope="row">Speicher</th>
                        <td>
                          {batteryAsset.capacityKwh != null ? fmtNum(batteryAsset.capacityKwh, 'kWh', 1) : '-'}
                          {batteryAsset.maxDischargeKw != null
                            ? ` · ${fmtNum(batteryAsset.maxDischargeKw, 'kW', 2)}`
                            : ''}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">MaStR-Nummer Speicher</th>
                        <td className="vp-mono">{batteryAsset.registryUnitId}</td>
                      </tr>
                    </>
                  )}
                  {lastFetched && (
                    <tr>
                      <th scope="row">Zuletzt abgerufen</th>
                      <td>{fmtRelative(lastFetched)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMastrOpen(true)}
                style={{ marginBottom: 'var(--vp-space-5)' }}
              >
                Neu aus dem Register abrufen
              </Button>
            </>
          )}

          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
            <h2 style={{ fontSize: '1.05rem' }}>Geräte an diesem Standort</h2>
          </div>
          {deviceCount(detail.id) === 0 ? (
            <p className="vp-muted">Noch keine Geräte. Fügen Sie unter „Geräte“ eines per Edge-Referenz hinzu.</p>
          ) : (
            <table className="vp-table">
              <thead>
                <tr>
                  <th>Referenz</th>
                  <th>Typ</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {devices
                  .filter((d) => d.siteId === detail.id)
                  .map((d) => (
                    <tr key={d.id}>
                      <td className="vp-mono">{d.externalRef}</td>
                      <td>{deviceKindLabel(d.kind)}</td>
                      <td>
                        <DeviceStatusBadge device={d} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          <DangerZone
            actionLabel="Standort löschen"
            description="Ein gelöschter Standort kann nicht wiederhergestellt werden."
            consequences={deleteConsequences(detail)}
            confirmLabel="Standort endgültig löschen"
            disabledReason={
              deviceCount(detail.id) > 0
                ? `Der Standort kann nicht gelöscht werden, solange ihm Geräte zugeordnet sind (${deviceCount(detail.id)} Gerät${deviceCount(detail.id) === 1 ? '' : 'e'}). Entfernen Sie zuerst die Geräte unter „Geräte".`
                : null
            }
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void deleteSite(detail)}
          />
          </>
          )}
        </Drawer>
      )}

      {detail && (
        <MastrDrawer
          site={detail}
          open={mastrOpen}
          onClose={() => setMastrOpen(false)}
          onApplied={(a) => setAssets(a)}
        />
      )}
    </>
  );
}

/**
 * Inline edit form of the site detail drawer: name, bidding zone and
 * coordinates - the same fields and client-side checks as CreateSiteDrawer.
 */
function SiteEditForm({
  site,
  onCancel,
  onSaved,
}: {
  site: Site;
  onCancel: () => void;
  onSaved: (updated: Site) => void;
}) {
  const [name, setName] = useState(site.name);
  const [biddingZone, setBiddingZone] = useState(site.biddingZone);
  const [latitude, setLatitude] = useState(site.latitude != null ? String(site.latitude) : '');
  const [longitude, setLongitude] = useState(site.longitude != null ? String(site.longitude) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latError, setLatError] = useState<string | null>(null);
  const [lonError, setLonError] = useState<string | null>(null);

  function parseCoord(v: string): number | null | undefined {
    if (!v.trim()) return undefined;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  async function save() {
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
      const updated = await api.updateSite(site.id, {
        name: name.trim(),
        biddingZone,
        latitude: lat ?? null,
        longitude: lon ?? null,
      });
      onSaved(updated);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie Name und Koordinaten.'
          : 'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 'var(--vp-space-5)' }}>
      <div className="vp-form-stack">
        <Input
          label="Name *"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="edit-site-zone" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Gebotszone
          </label>
          <select
            id="edit-site-zone"
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
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', justifyContent: 'flex-end', marginTop: 'var(--vp-space-4)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </Button>
      </div>
    </div>
  );
}
