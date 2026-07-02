import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { api, type Device, type Site, type SiteAsset } from '../api';
import { deviceKindLabel, fmtCoords, fmtNum, fmtRelative } from '../format';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
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

  const deviceCount = (siteId: string) => devices.filter((d) => d.siteId === siteId).length;

  useEffect(() => {
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
    return () => {
      cancelled = true;
    };
  }, [detail]);

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
          </div>

          {detail.latitude == null && (
            <div className="vp-alert vp-alert-info" style={{ marginTop: 0, marginBottom: 'var(--vp-space-4)' }}>
              Ohne Koordinaten gibt es keine Wettervorhersage für diesen Standort.
            </div>
          )}

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
