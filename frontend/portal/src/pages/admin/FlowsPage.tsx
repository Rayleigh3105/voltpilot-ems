/**
 * Plattform → Flows (E3a MVP, admin-only): the flows of one Anlage - active
 * flows, drafts with their simulation stand, and the Vorlagen row (mockup
 * Screen 2). Mandant → Anlage picker like the Optimizer page (explicit
 * X-Tenant-Id per call); opening a flow renders the editor in place.
 * Deliberately WITHOUT live monitoring KPIs (Wünsche/Guard-Eingriffe are the
 * E-monitoring epic) - the cards show what the cloud KNOWS: lifecycle,
 * versions, recorded dry-run.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError, type Site } from '../../api';
import { adminApi, type Tenant } from '../../admin/adminApi';
import { EmptyState, ErrorState, TextSkeleton } from '../../components/States';
import { VpPicker } from '../../components/VpPicker';
import { adminFlowApi, flowsApi, type FlowSummary } from '../../flows/flowsApi';
import { lifecycleLabel, type EditorEntity } from '../../flows/model';
import {
  batteryEntity,
  flowChain,
  pilotTemplate,
  simSummaryLine,
} from '../../flows/templates';
import { AdminPageHead } from './AdminPageHead';
import { FlowEditorPage } from './FlowEditorPage';

const CHAIN_BORDER: Record<string, string> = {
  strategie: '#1E3A5F',
  daten: '#2196F3',
  logik: '#78909C',
  aktion: '#2E9E5B',
};

export function FlowsPage({ tenants }: { tenants: Tenant[] }) {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [editing, setEditing] = useState<{ flowId: string; version: number } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createTemplate, setCreateTemplate] = useState<'pilot' | 'leer'>('pilot');
  const [createError, setCreateError] = useState('');
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tenantId) {
      setSites([]);
      setSiteId(null);
      return;
    }
    let cancelled = false;
    adminApi.listSites(tenantId)
      .then((list) => {
        if (!cancelled) setSites(list);
      })
      .catch(() => {
        if (!cancelled) setSites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const reload = useCallback(() => {
    if (!tenantId || !siteId) {
      setFlows(null);
      return;
    }
    setListState('loading');
    Promise.all([
      flowsApi.list(tenantId, siteId),
      flowsApi.entities(tenantId, siteId).catch(() => [] as EditorEntity[]),
    ])
      .then(([list, entityList]) => {
        setFlows(list);
        setEntities(entityList);
        setListState('idle');
      })
      .catch(() => setListState('error'));
  }, [tenantId, siteId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const site = useMemo(() => sites.find((s) => s.id === siteId) ?? null, [sites, siteId]);
  const battery = batteryEntity(entities);
  const editorApi = useMemo(
    () => (tenantId && siteId ? adminFlowApi(tenantId, siteId) : null),
    [tenantId, siteId],
  );

  const create = useCallback(async () => {
    if (!tenantId || !siteId) return;
    const name = createName.trim() || (createTemplate === 'pilot' ? 'Marktoptimierung' : 'Neuer Flow');
    setBusy(true);
    setCreateError('');
    try {
      const created = await flowsApi.create(tenantId, siteId, name);
      if (createTemplate === 'pilot' && battery) {
        const doc = pilotTemplate(name, battery.id, siteId);
        const saved = await flowsApi.save(tenantId, siteId, created.flowId, 1, name, doc);
        setEditing({ flowId: saved.flowId, version: saved.flowVersion });
      } else {
        setEditing({ flowId: created.flowId, version: created.flowVersion });
      }
      setCreateOpen(false);
      setCreateName('');
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : 'Der Flow konnte nicht angelegt werden.');
    } finally {
      setBusy(false);
    }
  }, [tenantId, siteId, createName, createTemplate, battery]);

  if (editing && site && editorApi) {
    return (
      <FlowEditorPage
        api={editorApi}
        site={site}
        flowId={editing.flowId}
        initialVersion={editing.version}
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  return (
    <>
      <AdminPageHead
        icon="zap"
        category="primary"
        title="Flows"
        description="Typisierte Energie-Flows je Anlage bauen, prüfen, simulieren und ausrollen - Bausteine statt freiem Code, Guards bleiben unantastbar."
        actions={siteId ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>＋ Neuer Flow</Button>
        ) : undefined}
      />

      <Card className="vp-optim-pickers" style={{ marginBottom: 'var(--vp-space-4)' }}>
        <VpPicker
          id="flows-tenant"
          className="vp-optim-picker"
          label="Mandant"
          options={[
            { value: '', label: '– Mandant wählen –' },
            ...tenants.map((tenant) => ({ value: tenant.id, label: tenant.name })),
          ]}
          value={tenantId ?? ''}
          onChange={(v) => {
            setTenantId(v || null);
            setSiteId(null);
            setFlows(null);
          }}
          searchPlaceholder="Mandant suchen …"
        />
        <VpPicker
          id="flows-site"
          className="vp-optim-picker"
          label="Anlage"
          options={[
            { value: '', label: '– Anlage wählen –' },
            ...sites.map((s) => ({ value: s.id, label: s.name })),
          ]}
          value={siteId ?? ''}
          onChange={(v) => setSiteId(v || null)}
          disabled={!tenantId}
          searchPlaceholder="Anlage suchen …"
        />
      </Card>

      {!tenantId && (
        <EmptyState
          title="Wählen Sie oben einen Mandanten"
          description="Flows werden je Anlage eines Mandanten gebaut und ausgerollt."
        />
      )}
      {tenantId && !siteId && (
        <EmptyState
          title="Wählen Sie eine Anlage"
          description="Jeder Flow gehört zu genau einer Anlage."
        />
      )}
      {tenantId && siteId && listState === 'loading' && <TextSkeleton lines={4} />}
      {tenantId && siteId && listState === 'error' && (
        <ErrorState message="Die Flows konnten nicht geladen werden." onRetry={reload} />
      )}

      {tenantId && siteId && listState === 'idle' && flows && (
        <>
          {flows.length === 0 ? (
            <EmptyState
              icon="zap"
              title="Noch keine Flows"
              description="Starten Sie mit der Vorlage „Marktoptimierung“ - der Pilot-Flow aus Strompreis, PV-Prognose und Speicher."
              action={<Button size="sm" onClick={() => setCreateOpen(true)}>＋ Neuer Flow</Button>}
            />
          ) : (
            <div className="vp-flowcards">
              {flows.map((flow) => {
                const chain = flowChain(flow.latestDocument ?? {
                  schema_version: '1.0', name: flow.name, runtime: 'edge',
                  nodes: [], edges: [], triggers: [],
                });
                const simLine = simSummaryLine(flow.simulation);
                return (
                  <Card key={flow.flowId} className="vp-flowcard">
                    <div className="vp-flowcard-head">
                      <span
                        className={`vp-flowcard-dot ${flow.activeVersion != null ? 'g' : 'o'}`}
                      />
                      <h3>{flow.name}</h3>
                      <Badge
                        variant={flow.activeVersion != null ? 'ok'
                          : flow.latestLifecycle === 'simulated' ? 'tint' : 'off'}
                      >
                        {flow.activeVersion != null
                          ? `Aktiv · v${flow.activeVersion}`
                          : `${lifecycleLabel(flow.latestLifecycle)} · v${flow.latestVersion}`}
                      </Badge>
                    </div>
                    {chain.length > 0 && (
                      <div className="vp-flowcard-chain">
                        {chain.map((entry, i) => (
                          <span key={`${entry.label}-${i}`} className="vp-flowcard-chainwrap">
                            {i > 0 && <span className="vp-flowcard-arr">→</span>}
                            <span
                              className="vp-flowcard-mini"
                              style={{ borderLeftColor: CHAIN_BORDER[entry.group] ?? '#78909C' }}
                            >
                              {entry.label}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="vp-flowcard-sim">
                      {simLine ?? 'Noch nicht simuliert - der Dry-Run läuft vor jeder Aktivierung.'}
                    </p>
                    <div className="vp-flowcard-foot">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing({
                          flowId: flow.flowId,
                          version: flow.latestVersion,
                        })}
                      >
                        Öffnen
                      </Button>
                      {flow.activeVersion == null && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            if (!window.confirm(`Flow „${flow.name}“ mit allen Versionen löschen?`)) {
                              return;
                            }
                            setBusy(true);
                            try {
                              await flowsApi.remove(tenantId, siteId, flow.flowId);
                              reload();
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Löschen
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <h3 className="vp-flowtpl-head">Vorlagen von VoltPilot</h3>
          <div className="vp-flowcards">
            <Card className="vp-flowcard tpl">
              <div className="vp-flowcard-head"><h3>Marktoptimierung (Pilot)</h3></div>
              <p className="vp-flowcard-sim">
                Strompreis + PV-Prognose + Speicher lesen → Marktoptimierung → Speicher
                steuern. Der Speicher wird an die Co-Optimierung delegiert.
              </p>
              <div className="vp-flowcard-foot">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCreateTemplate('pilot');
                    setCreateOpen(true);
                  }}
                >
                  Verwenden
                </Button>
              </div>
              {!battery && (
                <p className="vp-flowcard-sim">
                  Hinweis: Diese Anlage hat noch keine Speicher-Entität - zuerst das
                  v2-Entitäten-Bootstrap ausführen.
                </p>
              )}
            </Card>
            <Card className="vp-flowcard tpl">
              <div className="vp-flowcard-head">
                <h3>Peak-Shaving + atyp. NN</h3>
                <Badge variant="off">VoltPilot richtet ein</Badge>
              </div>
              <p className="vp-flowcard-sim">
                Lastspitzenkappung und Hochlastzeitfenster sind Vertrags-Bausteine -
                Einrichtung im Beratungsgespräch, sichtbar in der Guard-Leiste.
              </p>
            </Card>
          </div>
        </>
      )}

      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Neuer Flow"
        footer={(
          <>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              Abbrechen
            </Button>
            <Button size="sm" onClick={create} disabled={busy}>
              Anlegen
            </Button>
          </>
        )}
      >
        <div className="vp-flowed-fld">
          <label htmlFor="flow-create-name">Name</label>
          <input
            id="flow-create-name"
            className="vp-select"
            value={createName}
            placeholder={createTemplate === 'pilot' ? 'Marktoptimierung' : 'Neuer Flow'}
            onChange={(e) => setCreateName(e.target.value)}
          />
        </div>
        <VpPicker
          id="flow-create-template"
          className="vp-flowed-fld"
          label="Vorlage"
          options={[
            {
              value: 'pilot',
              label: 'Marktoptimierung (Pilot)',
              disabled: !battery,
              disabledHint: battery ? undefined : 'Braucht eine Speicher-Entität',
            },
            { value: 'leer', label: 'Leerer Flow' },
          ]}
          value={createTemplate}
          onChange={(v) => setCreateTemplate(v as 'pilot' | 'leer')}
        />
        {createError && <p className="vp-flowed-notice error">{createError}</p>}
      </Drawer>
    </>
  );
}
