import { useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { api, type Device, type Site } from '../api';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { DeviceStatusBadge } from '../components/DeviceDrawers';

/**
 * Standorte: the repeatable entity pattern - list-in-card, "＋ anlegen" opens
 * the add drawer, a row click opens the detail drawer (site facts + devices).
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

  const deviceCount = (siteId: string) => devices.filter((d) => d.siteId === siteId).length;

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Standorte</h1>
          <p>Ihre Standorte mit Gebotszone, Koordinaten und Geräten.</p>
        </div>
        <div className="actions">
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            ＋ Standort anlegen
          </Button>
        </div>
      </div>

      {sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="home" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>⌂</IconTile>
            <h3>Noch kein Standort</h3>
            <p>Legen Sie Ihren ersten Standort an - danach können Sie Geräte hineinbeanspruchen.</p>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              ＋ Ersten Standort anlegen
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
                  <td data-label="Koordinaten" className="vp-mono">
                    {s.latitude != null && s.longitude != null
                      ? `${s.latitude}, ${s.longitude}`
                      : '-'}
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
          icon={<IconTile category="home" size={40}>⌂</IconTile>}
          footer={
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Schließen
            </Button>
          }
        >
          <div style={{ display: 'flex', gap: 'var(--vp-space-2)', flexWrap: 'wrap', marginBottom: 'var(--vp-space-5)' }}>
            <Badge variant="tint">{detail.biddingZone}</Badge>
            {detail.latitude != null && detail.longitude != null && (
              <span className="vp-mono" style={{ alignSelf: 'center' }}>
                {detail.latitude}, {detail.longitude}
              </span>
            )}
          </div>

          {detail.latitude == null && (
            <div className="vp-alert vp-alert-info" style={{ marginTop: 0, marginBottom: 'var(--vp-space-4)' }}>
              Ohne Koordinaten gibt es keine Wettervorhersage für diesen Standort.
            </div>
          )}

          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
            <h2 style={{ fontSize: '1.05rem' }}>Geräte an diesem Standort</h2>
          </div>
          {deviceCount(detail.id) === 0 ? (
            <p className="vp-muted">Noch keine Geräte. Fügen Sie unter „Geräte" eines per Edge-Referenz hinzu.</p>
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
                      <td>{d.kind}</td>
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
    </>
  );
}
