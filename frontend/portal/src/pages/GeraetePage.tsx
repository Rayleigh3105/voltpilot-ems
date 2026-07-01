import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { IconTile } from '../../designsystem/components/core/IconTile';
import type { Device, Site } from '../api';
import { fmtRelative } from '../format';
import {
  AddDeviceDrawer,
  DeviceDetailDrawer,
  DeviceStatusBadge,
} from '../components/DeviceDrawers';

const POLL_MS = 30_000;

/**
 * Geräte: list-in-card + zero-touch add drawer + row detail drawer. The list
 * polls while mounted so a freshly claimed device visibly flips from
 * "wartet auf erste Daten" to "online" as soon as telemetry arrives.
 */
export function GeraetePage({
  sites,
  devices,
  onReload,
}: {
  sites: Site[];
  devices: Device[];
  onReload: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(onReload, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const detail = devices.find((d) => d.id === detailId) ?? null;

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Geräte</h1>
          <p>Beanspruchte Edge-Geräte Ihres Mandanten - Referenz, Standort und Verbindungsstatus.</p>
        </div>
        <div className="actions">
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            ＋ Gerät hinzufügen
          </Button>
        </div>
      </div>

      {devices.length === 0 ? (
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="battery" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>⚡</IconTile>
            <h3>Noch keine Geräte</h3>
            <p>
              Fügen Sie ein Gerät mit seiner Edge-Referenz hinzu - es verbindet sich
              selbst, sobald es eingeschaltet ist. Keine IDs, kein Kopieren.
            </p>
            <Button variant="primary" onClick={() => setAddOpen(true)} disabled={sites.length === 0}>
              ＋ Gerät hinzufügen
            </Button>
            {sites.length === 0 && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                Legen Sie zuerst unter „Standorte" einen Standort an.
              </p>
            )}
          </div>
        </Card>
      ) : (
        <>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table className="vp-table responsive">
              <thead>
                <tr>
                  <th>Referenz</th>
                  <th>Typ</th>
                  <th>Standort</th>
                  <th>Status</th>
                  <th>Zuletzt gesehen</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => setDetailId(d.id)}>
                    <td data-label="Referenz" className="vp-mono">
                      {d.externalRef}
                    </td>
                    <td data-label="Typ">{d.kind}</td>
                    <td data-label="Standort">{siteName(d.siteId)}</td>
                    <td data-label="Status">
                      <DeviceStatusBadge device={d} />
                    </td>
                    <td data-label="Zuletzt gesehen" className="vp-note">
                      {fmtRelative(d.lastSeenAt)}
                    </td>
                    <td data-label="">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setDetailId(d.id);
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
          <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
            Ein Gerät gilt als <b>online</b>, sobald Telemetrie über den Ingest-Pfad
            eintrifft. <Badge variant="warn" dot style={{ fontSize: '0.7rem' }}>wartet auf erste Daten</Badge>{' '}
            heißt: beansprucht, aber noch keine Daten - einfach einschalten.
          </p>
        </>
      )}

      <AddDeviceDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        sites={sites}
        onClaimed={onReload}
      />
      <DeviceDetailDrawer device={detail} sites={sites} onClose={() => setDetailId(null)} />
    </>
  );
}
