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
  type PlantKind,
  type Site,
  type SiteAsset,
  type SiteDeletionPreview,
} from '../api';
import { BATTERY_NO_DEVICE_WARNING, parsePremiumInput, premiumInputText } from '../fleet';
import { deviceKindLabel, fmtCoords, fmtNum, fmtRelative, plantKindLabel, zoneLabel } from '../format';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { LocationMap } from '../components/LocationMap';
import { DangerZone } from '../components/DangerZone';
import { DeviceStatusBadge } from '../components/DeviceDrawers';
import { NetzladenBadge } from '../components/NetzladenBadge';
import { MastrDrawer } from '../components/MastrDrawer';
import { ErrorState, TextSkeleton } from '../components/States';

/**
 * Standorte: the repeatable entity pattern - list-in-card, "＋ anlegen" opens
 * the add drawer, a row click opens the detail drawer (site facts + Anlage +
 * devices). The Anlage section is the optional MaStR link step.
 */
export function StandortePage({
  sites,
  devices,
  onReload,
  isAdmin = false,
}: {
  sites: Site[];
  devices: Device[];
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<Site | null>(null);
  const [mastrOpen, setMastrOpen] = useState(false);
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  const [assetsError, setAssetsError] = useState(false);
  const [assetsReloadKey, setAssetsReloadKey] = useState(0);
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
      setAssetsError(false);
      return;
    }
    let cancelled = false;
    setAssets(null);
    setAssetsError(false);
    api
      .siteAssets(detail.id)
      .then((a) => {
        if (!cancelled) setAssets(a);
      })
      .catch(() => {
        // Distinguish "couldn't load" from "you have none" (D3): a backend/RLS
        // failure must not masquerade as an empty Anlage section.
        if (!cancelled) setAssetsError(true);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, assetsReloadKey]);

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
  // The battery is sourced from ALL assets (not just registry-linked): a plant
  // not in the MaStR keeps its battery by hand, and its control-path warning
  // must show regardless of provenance.
  const batteryAsset = (assets ?? []).find((a) => a.type === 'battery') ?? null;
  const siteDevices = detail ? devices.filter((d) => d.siteId === detail.id) : [];
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
            <h3>{isAdmin ? 'Dieser Mandant hat noch keine Standorte' : 'Noch kein Standort'}</h3>
            <p>
              {isAdmin
                ? 'Sobald für diesen Mandanten ein Standort angelegt ist, erscheint er hier. Sie können im Namen des Mandanten einen Standort anlegen.'
                : 'Legen Sie Ihren ersten Standort an - danach können Sie ihm Geräte zuordnen.'}
            </p>
            <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
              {isAdmin ? 'Standort anlegen' : 'Ersten Standort anlegen'}
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
                    <Badge variant="tint">{zoneLabel(s.biddingZone)}</Badge>
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
            <Badge variant="tint">{zoneLabel(detail.biddingZone)}</Badge>
            <Badge variant="tint">{plantKindLabel(detail.plantKind)}</Badge>
            <NetzladenBadge erlaubt={detail.netzladenErlaubt} />
            {detail.plantKind === 'direktvermarktung' && detail.marktpraemieCtKwh != null && (
              <Badge variant="tint">Marktprämie {fmtNum(detail.marktpraemieCtKwh, 'ct/kWh', 2)}</Badge>
            )}
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
          {assetsError ? (
            <ErrorState
              message="Die Anlagendaten konnten nicht geladen werden."
              onRetry={() => setAssetsReloadKey((k) => k + 1)}
            />
          ) : assets === null ? (
            <TextSkeleton lines={2} />
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

          {assets !== null && !assetsError && (
            <BatteryControlSection
              siteId={detail.id}
              battery={batteryAsset}
              devices={siteDevices}
              onSaved={(a) => setAssets(a)}
            />
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
 * The grid-charging switch ("Netzladen des Speichers") is editable by the
 * site owner too (captain revision 2026-07-07 of decision 3 - not only the
 * Portal-Admin); the Ausschließlichkeitsprinzip warning stays so nobody
 * flips it uninformed.
 */
export function SiteEditForm({
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
  const [plantKind, setPlantKind] = useState<PlantKind>(site.plantKind ?? 'eigenverbrauch');
  const [netzladen, setNetzladen] = useState<boolean>(site.netzladenErlaubt);
  const [praemie, setPraemie] = useState(premiumInputText(site.marktpraemieCtKwh ?? null));
  const [lat, setLat] = useState<number | null>(site.latitude ?? null);
  const [lon, setLon] = useState<number | null>(site.longitude ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    const praemieValue = plantKind === 'direktvermarktung' ? parsePremiumInput(praemie) : null;
    if (praemieValue === undefined) {
      setError('Bitte geben Sie die Marktprämie als Zahl in ct/kWh an, z. B. 0,60.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateSite(site.id, {
        name: name.trim(),
        biddingZone,
        latitude: lat,
        longitude: lon,
        plantKind,
        marktpraemieCtKwh: praemieValue,
        netzladenErlaubt: netzladen,
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="edit-site-plant-kind" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Anlagentyp
          </label>
          <select
            id="edit-site-plant-kind"
            className="vp-select"
            value={plantKind}
            onChange={(e) => setPlantKind(e.target.value as PlantKind)}
          >
            <option value="eigenverbrauch">Eigenverbrauch (Haushalt/Gewerbe)</option>
            <option value="direktvermarktung">Direktvermarktung (Einspeisung am Markt)</option>
          </select>
        </div>
        {plantKind === 'direktvermarktung' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <Input
              label="Marktprämie (ct/kWh)"
              placeholder="z. B. 0,60"
              inputMode="decimal"
              value={praemie}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPraemie(e.target.value)}
            />
            <p className="vp-note" style={{ margin: 0 }}>
              Steht in Ihrem Direktvermarktungsvertrag. Optional - wenn angegeben,
              rechnen wir sie in Ihren Mehrerlös ein; bei negativen Börsenpreisen
              entfällt sie.
            </p>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="edit-site-netzladen" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Netzladen des Speichers
          </label>
          <select
            id="edit-site-netzladen"
            className="vp-select"
            value={netzladen ? 'erlaubt' : 'verboten'}
            onChange={(e) => setNetzladen(e.target.value === 'erlaubt')}
          >
            <option value="verboten">Verboten - EEG-Anlage (nur Solarladen)</option>
            <option value="erlaubt">Erlaubt - Speicher darf aus dem Netz laden</option>
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden
            (Ausschließlichkeitsprinzip). Nur aktivieren, wenn Ihre Anlage keine
            EEG-Vergütung bezieht.
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
            Verschieben Sie den Pin auf Ihren Standort - nötig für die Wettervorhersage. Optional.
          </p>
        </div>
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

/**
 * "Speicher & Steuerung": the battery master data (the optimizer's inputs) and
 * the controlling-device link, editable by hand - the inverter-centric surface
 * the captain asked for ("Ihr Wechselrichter steuert diesen Speicher"). It is
 * also the only place a plant NOT in the Marktstammdatenregister can maintain
 * its battery at all. When the battery has no controlling device it shows the
 * plain-German warning that the plan cannot be executed, and offers the fix.
 */
export function BatteryControlSection({
  siteId,
  battery,
  devices,
  onSaved,
}: {
  siteId: string;
  battery: SiteAsset | null;
  devices: Device[];
  onSaved: (assets: SiteAsset[]) => void;
}) {
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setEditing(false);
  }, [siteId]);

  const controllingDevice = battery?.deviceId
    ? devices.find((d) => d.id === battery.deviceId)
    : null;
  const needsDevice = battery != null && battery.deviceId == null;

  return (
    <>
      <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
        <h2 style={{ fontSize: '1.05rem' }}>Speicher &amp; Steuerung</h2>
      </div>

      {needsDevice && !editing && (
        <div className="vp-alert vp-alert-warn" style={{ marginTop: 0 }}>
          {BATTERY_NO_DEVICE_WARNING}
        </div>
      )}

      {editing ? (
        <BatteryEditForm
          siteId={siteId}
          battery={battery}
          devices={devices}
          onCancel={() => setEditing(false)}
          onSaved={(a) => {
            setEditing(false);
            onSaved(a);
          }}
        />
      ) : battery == null ? (
        <>
          <p className="vp-muted">
            Kein Speicher hinterlegt. Tragen Sie die Speicherdaten ein, damit der
            Fahrplan Ihren Speicher optimal lädt und entlädt.
          </p>
          <Button
            variant="outline"
            iconLeft={<Icon name="battery" size={16} />}
            onClick={() => setEditing(true)}
            style={{ marginBottom: 'var(--vp-space-5)' }}
          >
            Speicher hinzufügen
          </Button>
        </>
      ) : (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Ihr Wechselrichter steuert diesen Speicher - er führt den Fahrplan aus.
          </p>
          <table className="vp-table" style={{ marginBottom: 'var(--vp-space-3)' }}>
            <tbody>
              <tr>
                <th scope="row">Kapazität</th>
                <td>{battery.capacityKwh != null ? fmtNum(battery.capacityKwh, 'kWh', 1) : '-'}</td>
              </tr>
              <tr>
                <th scope="row">Lade-/Entladeleistung</th>
                <td>
                  {battery.maxChargeKw != null ? fmtNum(battery.maxChargeKw, 'kW', 2) : '-'}
                  {' / '}
                  {battery.maxDischargeKw != null ? fmtNum(battery.maxDischargeKw, 'kW', 2) : '-'}
                </td>
              </tr>
              <tr>
                <th scope="row">Wirkungsgrad</th>
                <td>
                  {battery.roundtripEfficiencyPct != null
                    ? fmtNum(battery.roundtripEfficiencyPct, '%', 0)
                    : 'Standard (92 %)'}
                </td>
              </tr>
              <tr>
                <th scope="row">Steuerndes Gerät</th>
                <td>
                  {controllingDevice ? (
                    controllingDevice.name || controllingDevice.externalRef
                  ) : (
                    <span className="vp-muted">nicht zugeordnet</span>
                  )}
                </td>
              </tr>
              {battery.registryUnitId && (
                <tr>
                  <th scope="row">MaStR-Nummer Speicher</th>
                  <td className="vp-mono">{battery.registryUnitId}</td>
                </tr>
              )}
            </tbody>
          </table>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Icon name="pencil" size={16} />}
            onClick={() => setEditing(true)}
            style={{ marginBottom: 'var(--vp-space-5)' }}
          >
            Speicher bearbeiten
          </Button>
        </>
      )}
    </>
  );
}

/**
 * Inline editor for the battery params + controlling device. Numbers accept
 * German comma decimals; the device select offers "Automatisch" (auto-link the
 * site's single device) plus every device at the site so a multi-device plant
 * can pick the inverter that controls the battery.
 */
function BatteryEditForm({
  siteId,
  battery,
  devices,
  onCancel,
  onSaved,
}: {
  siteId: string;
  battery: SiteAsset | null;
  devices: Device[];
  onCancel: () => void;
  onSaved: (assets: SiteAsset[]) => void;
}) {
  const [capacity, setCapacity] = useState(numText(battery?.capacityKwh));
  const [maxCharge, setMaxCharge] = useState(numText(battery?.maxChargeKw));
  const [maxDischarge, setMaxDischarge] = useState(numText(battery?.maxDischargeKw));
  const [efficiency, setEfficiency] = useState(numText(battery?.roundtripEfficiencyPct));
  const [deviceId, setDeviceId] = useState(battery?.deviceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cap = parseNum(capacity);
    const chg = parseNum(maxCharge);
    const dis = parseNum(maxDischarge);
    const eff = efficiency.trim() === '' ? null : parseNum(efficiency);
    if (cap == null || cap <= 0 || chg == null || chg <= 0 || dis == null || dis <= 0) {
      setError('Bitte geben Sie Kapazität, Lade- und Entladeleistung als positive Zahlen an.');
      return;
    }
    if (eff !== null && (eff == null || eff <= 0 || eff > 100)) {
      setError('Der Wirkungsgrad muss zwischen 1 und 100 % liegen.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const assets = await api.saveBattery(siteId, {
        capacityKwh: cap,
        maxChargeKw: chg,
        maxDischargeKw: dis,
        roundtripEfficiencyPct: eff,
        deviceId: deviceId || null,
      });
      onSaved(assets);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie die Werte.'
          : 'Die Speicherdaten konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 'var(--vp-space-5)' }}>
      <div className="vp-form-stack">
        <Input
          label="Kapazität (kWh) *"
          placeholder="z. B. 10"
          inputMode="decimal"
          value={capacity}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCapacity(e.target.value)}
        />
        <Input
          label="Max. Ladeleistung (kW) *"
          placeholder="z. B. 5"
          inputMode="decimal"
          value={maxCharge}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxCharge(e.target.value)}
        />
        <Input
          label="Max. Entladeleistung (kW) *"
          placeholder="z. B. 5"
          inputMode="decimal"
          value={maxDischarge}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMaxDischarge(e.target.value)}
        />
        <Input
          label="Wirkungsgrad (%)"
          placeholder="Standard 92"
          inputMode="decimal"
          value={efficiency}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEfficiency(e.target.value)}
          hint="Round-Trip-Wirkungsgrad. Leer lassen für den Standardwert (92 %)."
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="battery-device" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Steuerndes Gerät
          </label>
          <select
            id="battery-device"
            className="vp-select"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          >
            <option value="">Automatisch (einziges Gerät des Standorts)</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || d.externalRef}
              </option>
            ))}
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            Der Wechselrichter, der den Speicher steuert und den Fahrplan ausführt.
            Bei nur einem Gerät genügt „Automatisch“.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', justifyContent: 'flex-end', marginTop: 'var(--vp-space-4)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy}>
          {busy ? 'Wird gespeichert…' : 'Speicher speichern'}
        </Button>
      </div>
    </div>
  );
}

/** German decimal text for a form field (empty for null). */
function numText(value: number | null | undefined): string {
  return value == null ? '' : String(value).replace('.', ',');
}

/** Parse a German-or-plain decimal; null when not a finite number. */
function parseNum(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
