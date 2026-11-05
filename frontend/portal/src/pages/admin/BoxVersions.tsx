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
import { boxenDerLinie, boxVersionOverview, filterBoxVersions } from '../../boxVersions';
import { verbindungZaehlung, type BoxVerbindung } from '../../adminFleet';
import { BoxArtChip } from './BoxArtChip';
import {
  OnlineFilterLeiste,
  OnlineStatusZelle,
  OnlineZaehlung,
  verbindungJeBox,
  type OnlineFilter,
} from './OnlineStatus';
import './BoxVersions.css';

/** Version and update status answer different questions: a confirmed target
 * can still be an older release. Keep the reported version next to the server
 * status; never infer a failure or an update requirement from missing data. */
export interface OnlineInventar {
  /** Letzte Meldung je Geräte-Id aus dem Geräte-Inventar (`listDevices`). */
  lastSeen: Map<string, string | null>;
  /** Abrufzeitpunkt des Inventars - Bezug der Online-Regel. */
  fetchedAt: number;
}

export function BoxVersions({ data, busy, onUpdate, onOpen, online = null, onlineFailed = false }: {
  data: EdgeUpdates;
  busy: boolean;
  onUpdate: (release: EdgeUpdatesRelease) => void;
  onOpen: (deviceId: string) => void;
  /** `null`: Inventar noch nicht (oder nie) geladen - dann hat keine Box einen Status. */
  online?: OnlineInventar | null;
  /** Die letzte Aktualisierung des Inventars schlug fehl. */
  onlineFailed?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [version, setVersion] = useState('all');
  const [boxArt, setBoxArt] = useState('all');
  const { releases, linien, sorted, versions, filters, boxArten } = useMemo(
    () => boxVersionOverview(data), [data],
  );
  const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>('alle');
  // Online-Status nur für Boxen, die das Inventar kennt: wer dort fehlt, hat
  // KEINEN Status (unbekannt ist nicht online) und zählt nirgends mit.
  const verbindung = useMemo(() => online == null ? new Map<string, BoxVerbindung>() : verbindungJeBox(
    sorted.filter((r) => online.lastSeen.has(r.deviceId))
      .map((r) => ({ key: r.deviceId, lastSeenAt: online.lastSeen.get(r.deviceId) })),
    online.fetchedAt,
  ), [sorted, online]);
  const zaehlung = verbindungZaehlung([...verbindung.values()].map((v) => v.zustand));
  const rows = filterBoxVersions(sorted, releases, { search, filter, version, boxArt })
    .filter((r) => onlineFilter === 'alle' || verbindung.get(r.deviceId)?.zustand === onlineFilter);
  const filtered = filter !== 'all' || version !== 'all' || boxArt !== 'all' || !!search || onlineFilter !== 'alle';

  return (
    <div className="vp-box-versions">
      {/* Je Software-Linie eine Karte (Geräte & Updates S0): Docker-Box und Edge
          Light haben eigene Releases. Eine Karte für alle nahm das neueste über
          BEIDE Linien - seit dem ersten Edge-Light-Release stand dort nur noch
          Edge Light, und die Docker-Releases waren aus dem Blick. */}
      <div className="vp-box-linien" data-testid="box-linien">
        {linien.length === 0 ? (
          <section className="vp-box-release" aria-label="Neueste Version">
            <div className="vp-box-release-main">
              <span className="vp-box-eyebrow">Neueste Version</span>
              <h2>Noch kein Release</h2>
              <p>Die Boxen zeigen ihren gemeldeten Stand. Updates sind verfügbar, sobald ein signiertes Release registriert ist.</p>
            </div>
          </section>
        ) : linien.map((l) => (
          <section key={l.boxArt} className="vp-box-release" aria-label={`Neueste Version · ${l.label}`}
            data-testid={`linie-${l.boxArt}`}>
            <div className="vp-box-release-main">
              <span className="vp-box-eyebrow">
                <Icon name={l.boxArt === 'light' ? 'cpu' : 'layers'} size={14} /> {l.label} · neueste Version
              </span>
              <h2>{l.release?.version ?? 'Noch kein Release'}</h2>
              {l.release ? (
                <div className="vp-box-release-meta">
                  <Badge variant={l.release.signed ? 'ok' : 'off'} dot>
                    {l.release.signed ? 'Signiert · bereit zum Verteilen' : 'Nicht signiert · nicht verteilbar'}
                  </Badge>
                </div>
              ) : <p>Für diese Linie ist noch kein Release registriert.</p>}
            </div>
            <div className="vp-box-release-action">
              <p>
                {l.release ? <>
                  <strong>{l.upToDate} von {boxenDerLinie(l.boxArt, l.devices)}</strong>{' '}
                  {l.upToDate === 1 ? 'meldet' : 'melden'} diese Version
                </> : <strong>{boxenDerLinie(l.boxArt, l.devices)}</strong>}
                {l.stufe1 > 0 && <span className="vp-box-linie-hand" data-testid="linie-stufe1">
                  <Icon name="hand" size={14} /> {l.stufe1 === 1 ? '1 davon nimmt' : `${l.stufe1} davon nehmen`} keine
                  Updates aus dem Portal an (Stufe 1, nur von Hand)
                </span>}
              </p>
              {l.release && (
                <Button variant="primary" iconLeft={<Icon name="refresh-cw" size={18} />}
                  disabled={busy || !l.release.signed || l.zuweisbar === 0}
                  onClick={() => l.release && onUpdate(l.release)}>
                  Update verteilen
                </Button>
              )}
            </div>
          </section>
        ))}
      </div>

      <Card className="vp-box-fleet" style={{ padding: 0 }}>
        <div className="vp-box-fleet-head">
          <div><h2>Versionen der Boxen</h2><p>Installierter Stand und Update-Ziel aus der letzten Meldung jeder Box.
            „Online-Status“ sagt, ob sich die Box in den letzten 5 Minuten gemeldet hat.</p>
            {verbindung.size > 0 && online && (
              <OnlineZaehlung zaehlung={zaehlung} fetchedAt={online.fetchedAt} refreshFailed={onlineFailed} />
            )}
            {online == null && onlineFailed && sorted.length > 0 && (
              <p className="vp-muted" data-testid="online-unbekannt">Online-Status gerade nicht abrufbar - keine Box wird als online gezählt.</p>
            )}
          </div>
          <span className="vp-box-total">{sorted.length} {sorted.length === 1 ? 'Box' : 'Boxen'}</span>
        </div>
        {sorted.length === 0 ? <EmptyState title="Noch keine Box verbunden"
          description="Sobald eine Box einem Kundenkonto zugeordnet ist, erscheint sie hier mit ihrem Software-Stand." /> : <>
          {verbindung.size > 0 && (
            <OnlineFilterLeiste filter={onlineFilter} onFilter={setOnlineFilter} alle={sorted.length} zaehlung={zaehlung} />
          )}
          <details className="vp-box-filter-panel">
          <summary>Suche & Filter <span>{filtered ? `${rows.length} von ${sorted.length} Boxen` : 'Alle Boxen'}</span></summary>
          <div className="vp-box-tools">
            <Input type="search" aria-label="Boxen durchsuchen" placeholder="Box, Anlage, Kunde oder Version suchen …"
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <VpPicker label={<span className="vp-sr-only">Installierte Version</span>} value={version} onChange={setVersion}
              options={[{ value: 'all', label: 'Alle Versionen' }, ...versions.map((v) => ({ value: v, label: v }))]} />
            <VpPicker label={<span className="vp-sr-only">Box-Art</span>} value={boxArt} onChange={setBoxArt}
              options={boxArten} />
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
            action={<Button variant="outline" onClick={() => { setSearch(''); setFilter('all'); setVersion('all'); setBoxArt('all'); setOnlineFilter('alle'); }}>Filter zurücksetzen</Button>} /> :
            <div className="vp-table-scroll">
              <table className="vp-table responsive vp-box-table" data-testid="box-versions">
                <caption className="vp-sr-only">Software-Version und Update-Status aller verbundenen Boxen</caption>
                <thead><tr><th>Box / Anlage</th><th>Online-Status</th><th>Installierte Version</th><th>Zielversion</th><th>Update-Status</th><th><span className="vp-sr-only">Aktionen</span></th></tr></thead>
                <tbody>{rows.map((r) => {
                  const cross = crossoverState(r.trust, r.boxArt);
                  const status = stateLabel(r.state);
                  return <tr key={r.deviceId}>
                    <td data-label="Box / Anlage">
                      <span className="vp-cell-main"><strong>{r.siteName}</strong>
                        <span className="vp-cell-sub">{r.tenantName}</span>
                        <span className="vp-box-ref">{r.label !== r.externalRef ? `${r.label} · ` : ''}{r.externalRef}</span>
                        <span className="vp-box-art"><BoxArtChip boxArt={r.boxArt} /></span>
                      </span>
                    </td>
                    <td data-label="Online-Status"><OnlineStatusZelle verbindung={verbindung.get(r.deviceId)} /></td>
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
                      {/* Laut nur, was ein Vorfall ist; Edge Light ohne Stufe 2 wird ruhig BENANNT (E10). */}
                      {(cross.tone === 'warn' || cross.state === 'von_hand') &&
                        <span className="vp-cell-sub" title={cross.detail ?? undefined}>{cross.label}</span>}
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
