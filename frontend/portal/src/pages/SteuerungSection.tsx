/**
 * Anlage → Steuerung (U3, report §4): the ONE customer flow surface, with the
 * flow/automation editor as the visible STAR. It MERGES the former read-only
 * "Optimierung" module cards (Level 1 "Was läuft") with the E3b editor
 * (Level 2 "Ihre Steuerungen").
 *
 * Level 2 has two first-class mode tabs - ⚙ Strategien | ⚡ Automationen - that
 * open the SAME shared FlowEditorPage (via customerFlowApi - NO fork), differing
 * only in palette pre-filter, template set and list filter. The canvas is SHOWN:
 * each flow card carries a live read-only graph preview (the deterministic
 * auto-layout renders any document), and opening a flow goes full three-pane
 * (palette | canvas | inspector | guard bar). Customers get Vorlagen + a guided
 * Wenn/Dann builder first; the full node canvas ("Profi-Ansicht") is always
 * visible and write-gated via the existing per-node governance.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError, type Site } from '../api';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { GuidedRuleBuilder } from '../components/GuidedRuleBuilder';
import { FlowCanvas } from '../components/flows/FlowCanvas';
import { OptimierungSection } from '../components/OptimierungSection';
import { EINRICHTUNG_DURCH_VOLTPILOT } from '../moduleSurface';
import {
  customerFlowApi,
  type FlowNodeGovernance,
  type FlowSummary,
} from '../flows/flowsApi';
import { CUSTOMER_TEMPLATES, type CustomerTemplateDef } from '../flows/customerTemplates';
import { lifecycleLabel, type EditorEntity, type FlowDocument } from '../flows/model';
import { batteryEntity, pilotTemplate, simSummaryLine } from '../flows/templates';
import {
  MODES,
  flowMode,
  paletteFilterFor,
  type SteuerungMode,
} from '../flows/steuerung';
import { FlowEditorPage } from './admin/FlowEditorPage';

const EMPTY_DOC: FlowDocument = {
  schema_version: '1.0', name: '', runtime: 'edge', nodes: [], edges: [], triggers: [],
};

const NOOP = () => {};

/** A non-interactive graph preview (the canvas is the artifact, shown not hidden). */
function CanvasPreview({ doc, entities }: { doc: FlowDocument; entities: EditorEntity[] }) {
  if (doc.nodes.length === 0) return null;
  return (
    <div className="vp-flowpreview" aria-hidden="true">
      <FlowCanvas
        doc={doc}
        entities={entities}
        selection={null}
        connectFrom={null}
        errorNodeIds={new Set()}
        errorEdgeIds={new Set()}
        onSelectNode={NOOP}
        onSelectEdge={NOOP}
        onPortClick={NOOP}
        onBackground={NOOP}
      />
    </div>
  );
}

export function SteuerungSection({ site, isAdmin = false }: { site: Site; isAdmin?: boolean }) {
  const api = useMemo(() => customerFlowApi(site.id), [site.id]);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [mode, setMode] = useState<SteuerungMode>('automation');
  const [editing, setEditing] = useState<{ flowId: string; version: number } | null>(null);
  const [guided, setGuided] = useState(false);
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
    async (name: string, doc: FlowDocument | null) => {
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
        paletteFilter={paletteFilterFor(mode)}
        backLabel="Zur Steuerung"
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  const modeFlows = (flows ?? []).filter(
    (f) => flowMode(f.latestDocument ?? EMPTY_DOC) === mode,
  );

  return (
    <div className="vp-steuerung">
      {/* LEVEL 1 - Was läuft (the read-only outcome cards, merged from Optimierung). */}
      <section aria-label="Was läuft">
        <h3 className="vp-steuerung-l1head">Was läuft</h3>
        <OptimierungSection site={site} isAdmin={isAdmin} />
      </section>

      {/* LEVEL 2 - Ihre Steuerungen (the editor as the star). */}
      <section aria-label="Ihre Steuerungen" className="vp-steuerung-l2">
        <h3 className="vp-steuerung-l1head">Ihre Steuerungen</h3>

        <div className="vp-mode-tabs" role="tablist" aria-label="Steuerungs-Modus">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={mode === m.key}
              className={`vp-mode-tab${mode === m.key ? ' active' : ''}`}
              onClick={() => { setMode(m.key); setGuided(false); }}
            >
              <Icon name={m.key === 'strategie' ? 'settings' : 'zap'} size={16} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        <p className="vp-note vp-mode-hint">
          {MODES.find((m) => m.key === mode)?.hint}
        </p>

        {error && <p className="vp-flowed-notice error" role="status">{error}</p>}

        {listState === 'loading' && <TextSkeleton lines={4} />}
        {listState === 'error' && (
          <ErrorState
            message="Die Steuerungen konnten nicht geladen werden."
            onRetry={reload}
          />
        )}

        {listState === 'idle' && flows && (
          <>
            {guided ? (
              <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
                <div className="vp-steuerung-head">
                  <h3>Automation per Baukasten</h3>
                </div>
                <GuidedRuleBuilder
                  entities={entities}
                  busy={busy}
                  onCancel={() => setGuided(false)}
                  onBuild={(name, doc) => { setGuided(false); void openSaved(name, doc); }}
                />
              </Card>
            ) : (
              <>
                {modeFlows.length === 0 ? (
                  <EmptyState
                    icon={mode === 'strategie' ? 'trending-up' : 'zap'}
                    title={mode === 'strategie' ? 'Noch keine Strategie' : 'Noch keine Automation'}
                    description={
                      mode === 'strategie'
                        ? 'Starten Sie mit der Marktoptimierung unten - VoltPilot mit-optimiert Ihren Speicher.'
                        : 'Starten Sie mit dem Baukasten oder einer Vorlage - z. B. „Wallbox nur bei PV-Überschuss“.'
                    }
                  />
                ) : (
                  <div className="vp-flowcards">
                    {modeFlows.map((flow) => {
                      const doc = flow.latestDocument ?? EMPTY_DOC;
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
                          <CanvasPreview doc={doc} entities={entities} />
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

                {/* Create affordances per mode. */}
                {mode === 'automation' ? (
                  <>
                    <div className="vp-steuerung-head">
                      <h3>Neue Automation</h3>
                      <div className="vp-steuerung-actions">
                        <Button size="sm" onClick={() => setGuided(true)} disabled={busy}>
                          ＋ Baukasten (geführt)
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openSaved('Neue Automation', null)}
                          disabled={busy}
                        >
                          Profi-Ansicht (voller Editor)
                        </Button>
                      </div>
                    </div>
                    <h4 className="vp-flowtpl-head">Vorlagen</h4>
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
                            {blocked && (
                              <p className="vp-flowcard-sim">{(res as { reason: string }).reason}</p>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="vp-steuerung-head">
                      <h3>Neue Strategie</h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openSaved('Neue Strategie', null)}
                        disabled={busy}
                      >
                        Profi-Ansicht (voller Editor)
                      </Button>
                    </div>
                    <div className="vp-flowcards">
                      {/* Marktoptimierung: a GATED strategy - buildable, activatable
                          only after VoltPilot enables it (Beratung). */}
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
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
