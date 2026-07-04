import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import type { Device, Site } from '../api';
import { deviceKindLabel, fmtRelative } from '../format';
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
  onPoll,
}: {
  sites: Site[];
  devices: Device[];
  onReload: () => void;
  /** Background refresh for the 30 s poll: fails silently, no app-wide banner (m5). */
  onPoll?: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Keep the poll firing the LATEST callback without tearing down/recreating the
  // 30 s interval on every render: stash it in a ref updated each render and
  // read it from a stable interval. (Before, `[]` deps captured the first
  // render's callbacks - benign only as long as they kept reading live globals.)
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = onPoll ?? onReload;
  useEffect(() => {
    const timer = setInterval(() => tickRef.current(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const detail = devices.find((d) => d.id === detailId) ?? null;

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Geräte</h1>
          <p>Ihre verbundenen Geräte - Referenz, Standort und Verbindungsstatus.</p>
        </div>
        <div className="actions">
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
            Gerät hinzufügen
          </Button>
        </div>
      </div>

      {devices.length === 0 ? (
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="battery" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="zap" size={24} />
            </IconTile>
            <h3>Noch keine Geräte</h3>
            <p>
              Fügen Sie ein Gerät mit seiner Edge-Referenz hinzu - es verbindet sich
              selbst, sobald es eingeschaltet ist. Keine IDs, kein Kopieren.
            </p>
            <Button
              variant="primary"
              iconLeft={<Icon name="plus" size={18} />}
              onClick={() => setAddOpen(true)}
              disabled={sites.length === 0}
            >
              Gerät hinzufügen
            </Button>
            {sites.length === 0 && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                Legen Sie zuerst unter „Standorte“ einen Standort an.
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
                    <td data-label="Referenz">
                      {d.name ? (
                        <>
                          <b>{d.name}</b>
                          <div className="vp-note vp-mono">{d.externalRef}</div>
                        </>
                      ) : (
                        <span className="vp-mono">{d.externalRef}</span>
                      )}
                    </td>
                    <td data-label="Typ">{deviceKindLabel(d.kind)}</td>
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
            Ein Gerät gilt als <b>online</b>, sobald es Messwerte sendet.{' '}
            <Badge variant="warn" dot style={{ fontSize: '0.7rem' }}>wartet auf erste Daten</Badge>{' '}
            bedeutet: Das Gerät ist registriert, hat aber noch nichts gesendet - schalten
            Sie es einfach ein. Bleibt es länger als 15 Minuten in diesem Zustand,
            öffnen Sie die Details des Geräts - dort finden Sie eine Hilfe zur Fehlersuche.
          </p>
        </>
      )}

      <AddDeviceDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        sites={sites}
        onClaimed={onReload}
      />
      <DeviceDetailDrawer
        device={detail}
        sites={sites}
        onClose={() => setDetailId(null)}
        onChanged={onReload}
      />
    </>
  );
}
