import { useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Input } from '../../../designsystem/components/forms/Input';
import { EmptyState } from '../../components/States';
import { VpPicker } from '../../components/VpPicker';
import { crossoverState, stateLabel,
  type EdgeUpdates, type EdgeUpdatesRelease } from '../../adminEdgeUpdates';
import { versionDisplay } from '../../edgeVersionLabel';
import { fmtRelative } from '../../format';
import { boxVersionOverview, filterBoxVersions } from '../../boxVersions';
import './BoxVersions.css';

/** Version and update status answer different questions: a confirmed target
 * can still be an older release. Keep the reported version next to the server
 * status; never infer a failure or an update requirement from missing data. */
export function BoxVersions({ data, busy, onUpdate, onOpen }: {
  data: EdgeUpdates;
  busy: boolean;
  onUpdate: (release: EdgeUpdatesRelease) => void;
  onOpen: (deviceId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [version, setVersion] = useState('all');
  const { releases, latest, sorted, versions, runningLatest, filters } = useMemo(
    () => boxVersionOverview(data), [data],
  );
  const rows = filterBoxVersions(sorted, releases, { search, filter, version });

  return (
    <div className="vp-box-versions">
      <section className="vp-box-release" aria-label="Neueste Version">
        <div className="vp-box-release-main">
          <span className="vp-box-eyebrow">Neueste Version</span>
          <h2>{latest?.version ?? 'Noch kein Release'}</h2>
          {latest ? <>
            <div className="vp-box-release-meta">
              <Badge variant={latest.signed ? 'ok' : 'off'} dot>
                {latest.signed ? 'Signiert · bereit zum Verteilen' : 'Nicht signiert · nicht verteilbar'}
              </Badge>
            </div>
          </> : <p>Die Boxen zeigen ihren gemeldeten Stand. Updates sind verfügbar, sobald ein signiertes Release registriert ist.</p>}
        </div>
        <div className="vp-box-release-action">
          {latest && <>
            <p><strong>{runningLatest} von {sorted.length}</strong> Boxen melden diese Version</p>
            <Button variant="primary" iconLeft={<Icon name="refresh-cw" size={18} />}
              disabled={busy || !latest.signed || sorted.length === 0} onClick={() => onUpdate(latest)}>
              Update verteilen
            </Button>
          </>}
        </div>
      </section>

      <Card className="vp-box-fleet" style={{ padding: 0 }}>
        <div className="vp-box-fleet-head">
          <div><h2>Versionen der Boxen</h2><p>Installierter Stand und Update-Ziel aus der letzten Meldung jeder Box.</p></div>
          <span className="vp-box-total">{sorted.length} {sorted.length === 1 ? 'Box' : 'Boxen'}</span>
        </div>
        {sorted.length === 0 ? <EmptyState title="Noch keine Box verbunden"
          description="Sobald eine Box einem Kundenkonto zugeordnet ist, erscheint sie hier mit ihrem Software-Stand." /> : <>
          <details className="vp-box-filter-panel">
          <summary>Suche & Filter <span>{filter !== 'all' || version !== 'all' || search ? `${rows.length} von ${sorted.length} Boxen` : 'Alle Boxen'}</span></summary>
          <div className="vp-box-tools">
            <Input type="search" aria-label="Boxen durchsuchen" placeholder="Box, Anlage, Kunde oder Version suchen …"
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <VpPicker label={<span className="vp-sr-only">Installierte Version</span>} value={version} onChange={setVersion}
              options={[{ value: 'all', label: 'Alle Versionen' }, ...versions.map((v) => ({ value: v, label: v }))]} />
          </div>
          <div className="vp-box-filters" role="group" aria-label="Boxen nach Update-Status filtern">
            {filters.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}>
              {f.label}<span>{f.count}</span>
            </button>)}
          </div>
          </details>
          <span className="vp-sr-only" role="status">{rows.length} von {sorted.length} Boxen angezeigt</span>
          {rows.length === 0 ? <EmptyState title="Keine passende Box"
            description="Ändern Sie die Suche oder setzen Sie die Filter zurück."
            action={<Button variant="outline" onClick={() => { setSearch(''); setFilter('all'); setVersion('all'); }}>Filter zurücksetzen</Button>} /> :
            <div className="vp-table-scroll">
              <table className="vp-table responsive vp-box-table" data-testid="box-versions">
                <caption className="vp-sr-only">Software-Version und Update-Status aller verbundenen Boxen</caption>
                <thead><tr><th>Box / Anlage</th><th>Installierte Version</th><th>Zielversion</th><th>Update-Status</th><th><span className="vp-sr-only">Aktionen</span></th></tr></thead>
                <tbody>{rows.map((r) => {
                  const cross = crossoverState(r.trust);
                  const status = stateLabel(r.state);
                  return <tr key={r.deviceId}>
                    <td data-label="Box / Anlage">
                      <span className="vp-cell-main"><strong>{r.siteName}</strong>
                        <span className="vp-cell-sub">{r.tenantName}</span>
                        <span className="vp-box-ref">{r.label !== r.externalRef ? `${r.label} · ` : ''}{r.externalRef}</span>
                      </span>
                    </td>
                    <td data-label="Installierte Version" className="vp-box-installed">
                      <BoxVersion stamp={r.ist} releases={releases} empty="Noch nicht gemeldet" />
                      <span className="vp-cell-sub">{r.reportedAt ? `Gemeldet ${fmtRelative(r.reportedAt)}` : 'Keine Versionsmeldung'}</span>
                    </td>
                    <td data-label="Zielversion"><BoxVersion stamp={r.soll} releases={releases} empty="Nicht zugewiesen" /></td>
                    <td data-label="Update-Status">
                      <span className={`vp-ustate vp-ustate-${status.cls}`}>
                        <i className="vp-ustate-dot" aria-hidden="true" />{status.label}
                      </span>
                      {r.reason && <span className="vp-cell-sub">{r.reason}</span>}
                      {cross.tone === 'warn' && <span className="vp-cell-sub" title={cross.detail ?? undefined}>{cross.label}</span>}
                    </td>
                    <td data-label="Aktionen"><Button variant="outline" size="sm" aria-label={`Update verwalten für ${r.siteName} · ${r.externalRef}`}
                      onClick={() => onOpen(r.deviceId)}>Update verwalten</Button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>}
        </>}
      </Card>
    </div>
  );
}

function BoxVersion({ stamp, releases, empty }: {
  stamp: string | null; releases: EdgeUpdatesRelease[]; empty: string;
}) {
  const value = versionDisplay(stamp, releases);
  return value ? <span className="vp-cell-main" title={stamp ?? undefined}>
    <strong className="vp-box-version">{value.tag}</strong>
    {value.build && <span className="vp-box-build">Build {value.build.slice(0, 8)}</span>}
  </span> : <span className="vp-muted">{empty}</span>;
}
