/**
 * Anlage → Steuerung (E3b, the customer flow surface). A Portal-User builds,
 * validates, simulates, activates and deactivates the flows of their OWN Anlage
 * through the tenant-scoped /api/v1/sites/** routes. It REUSES the exact
 * FlowEditorPage (palette/canvas/inspector) via the customer-bound flow API - no
 * forked editor. Server-side governance is the law: a gated strategy node
 * (Marktoptimierung/Lastspitzenkappung) is shown but LOCKED until VoltPilot
 * enables it for the Anlage; free nodes (Eigenverbrauch, device control,
 * data/logic/action) build and activate normally.
 *
 * Monitoring is deliberately minimal + honest: the cards show what the cloud
 * KNOWS (lifecycle + whether a rollout was published) - poll-based (reload),
 * never a fabricated live-ack (no SSE - that is E14).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError, type Site } from '../api';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { EINRICHTUNG_DURCH_VOLTPILOT } from '../moduleSurface';
import {
  customerFlowApi,
  type FlowNodeGovernance,
  type FlowSummary,
} from '../flows/flowsApi';
import { CUSTOMER_TEMPLATES, type CustomerTemplateDef } from '../flows/customerTemplates';
import { lifecycleLabel, type EditorEntity } from '../flows/model';
import {
  batteryEntity,
  flowChain,
  pilotTemplate,
  simSummaryLine,
} from '../flows/templates';
import { FlowEditorPage } from './admin/FlowEditorPage';

const CHAIN_BORDER: Record<string, string> = {
  strategie: '#1E3A5F',
  daten: '#2196F3',
  logik: '#78909C',
  aktion: '#2E9E5B',
};

export function SteuerungSection({ site, isAdmin = false }: { site: Site; isAdmin?: boolean }) {
  const api = useMemo(() => customerFlowApi(site.id), [site.id]);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState<{ flowId: string; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    setListState('loading');
    Promise.all([
      api.list(),
      api.entities().catch(() => [] as EditorEntity[]),
      api.governance().catch(() => ({ gatedNodes: [] } as FlowNodeGovernance)),
    ])
      .then(([list, entityList, gov]) => {
        setFlows(list);
        setEntities(entityList);
        setGovernance(gov);
        setListState('idle');
      })
      .catch(() => setListState('error'));
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const battery = batteryEntity(entities);
  const marketEnabled = useMemo(
    () => (governance?.gatedNodes ?? []).some((n) => n.type === 'vp.strategy.market' && n.enabled),
    [governance],
  );

  const openSaved = useCallback(
    async (name: string, doc: Parameters<typeof api.save>[3] | null) => {
      setBusy(true);
      setError('');
      try {
        const created = await api.create(name);
        if (doc) {
          const saved = await api.save(created.flowId, 1, name, doc);
          setEditing({ flowId: saved.flowId, version: saved.flowVersion });
        } else {
          setEditing({ flowId: created.flowId, version: created.flowVersion });
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Der Flow konnte nicht angelegt werden.');
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const useTemplate = useCallback(
    (def: CustomerTemplateDef) => {
      const res = def.resolve(entities, site.id);
      if ('reason' in res) {
        setError(res.reason);
        return;
      }
      void openSaved(def.name, res.doc);
    },
    [entities, site.id, openSaved],
  );

  if (editing) {
    return (
      <FlowEditorPage
        api={api}
        site={site}
        flowId={editing.flowId}
        initialVersion={editing.version}
        canEnableGated={isAdmin}
        lockedHint={EINRICHTUNG_DURCH_VOLTPILOT}
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  return (
    <div className="vp-steuerung">
      <p className="vp-steuerung-intro">
        Bauen Sie eigene Steuerungs-Regeln aus fertigen Bausteinen - VoltPilot prüft,
        simuliert und rollt sie auf Ihr Gerät aus. Sicherheits-, Netz- und
        Vertragsgrenzen (§ 14a) bleiben dabei immer unantastbar. Vertragsnahe
        Bausteine wie die Marktoptimierung richtet VoltPilot für Sie frei.
      </p>

      {error && <p className="vp-flowed-notice error" role="status">{error}</p>}

      {listState === 'loading' && <TextSkeleton lines={4} />}
      {listState === 'error' && (
        <ErrorState message="Die Steuerungs-Flows konnten nicht geladen werden." onRetry={reload} />
      )}

      {listState === 'idle' && flows && (
        <>
          <div className="vp-steuerung-head">
            <h3>Ihre Steuerungen</h3>
            <Button size="sm" onClick={() => openSaved('Neue Steuerung', null)} disabled={busy}>
              ＋ Neue Steuerung
            </Button>
          </div>

          {flows.length === 0 ? (
            <EmptyState
              icon="zap"
              title="Noch keine Steuerung"
              description="Starten Sie mit einer Vorlage unten - z. B. „Wallbox nur bei PV-Überschuss“."
            />
          ) : (
            <div className="vp-flowcards">
              {flows.map((flow) => {
                const chain = flowChain(flow.latestDocument ?? {
                  schema_version: '1.0', name: flow.name, runtime: 'edge',
                  nodes: [], edges: [], triggers: [],
                });
                const active = flow.activeVersion != null;
                const simLine = simSummaryLine(flow.simulation);
                return (
                  <Card key={flow.flowId} className="vp-flowcard">
                    <div className="vp-flowcard-head">
                      <span className={`vp-flowcard-dot ${active ? 'g' : 'o'}`} />
                      <h3>{flow.name}</h3>
                      <Badge
                        variant={active ? 'ok'
                          : flow.latestLifecycle === 'simulated' ? 'tint' : 'off'}
                      >
                        {active
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
                      {active
                        ? 'Aktiv - auf Ihr Gerät ausgerollt.'
                        : simLine ?? 'Noch nicht simuliert - der Dry-Run läuft vor jeder Aktivierung.'}
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
                      {!active && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            if (!window.confirm(`Steuerung „${flow.name}“ löschen?`)) return;
                            setBusy(true);
                            try {
                              await api.remove(flow.flowId);
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

          <h3 className="vp-flowtpl-head">Vorlagen</h3>
          <div className="vp-flowcards">
            {CUSTOMER_TEMPLATES.map((def) => {
              const res = def.resolve(entities, site.id);
              const blocked = 'reason' in res;
              return (
                <Card key={def.id} className="vp-flowcard tpl">
                  <div className="vp-flowcard-head"><h3>{def.name}</h3></div>
                  <p className="vp-flowcard-sim">{def.description}</p>
                  <div className="vp-flowcard-foot">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || blocked}
                      onClick={() => useTemplate(def)}
                    >
                      Verwenden
                    </Button>
                  </div>
                  {blocked && <p className="vp-flowcard-sim">{(res as { reason: string }).reason}</p>}
                </Card>
              );
            })}

            {/* Marktoptimierung: a GATED strategy - buildable, activatable only
                after VoltPilot enables it (Beratung). */}
            <Card className="vp-flowcard tpl">
              <div className="vp-flowcard-head">
                <h3>Marktoptimierung</h3>
                <Badge variant={marketEnabled ? 'ok' : 'off'}>
                  {marketEnabled ? 'Freigeschaltet' : 'VoltPilot richtet ein'}
                </Badge>
              </div>
              <p className="vp-flowcard-sim">
                Der Speicher wird an die VoltPilot-Co-Optimierung delegiert: Arbitrage auf
                Börsenpreise, Eigenverbrauch und Vertragsgrenzen im gemeinsamen Optimum.
              </p>
              <div className="vp-flowcard-foot">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !battery}
                  onClick={() => battery && void openSaved(
                    'Marktoptimierung',
                    pilotTemplate('Marktoptimierung', battery.id, site.id),
                  )}
                >
                  Verwenden
                </Button>
              </div>
              {!battery ? (
                <p className="vp-flowcard-sim">
                  Diese Anlage hat noch keinen Speicher als Steuer-Einheit.
                </p>
              ) : !marketEnabled && (
                <p className="vp-flowcard-sim">
                  <Icon name="lock" size={12} /> {EINRICHTUNG_DURCH_VOLTPILOT} Sie können den
                  Flow bereits bauen und simulieren - aktiviert wird er nach der Freischaltung.
                </p>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
