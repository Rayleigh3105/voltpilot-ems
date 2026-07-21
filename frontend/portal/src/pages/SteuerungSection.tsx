/**
 * Anlage → **Steuerung v3** (M2, OpenProject #530, Epic „Projektion" #527;
 * Spec `data/vp-anlagen-face-k9/report.md` §2.3 + §1.2).
 *
 * Die Steuerung ist DIE Schlüsselfläche: sie zeigt die MENGE der aktiven Modi
 * (M0 `activeModes`), was jeder Modus beiträgt und welche Geräte er
 * beansprucht — und sie ist der EINE Ort, an dem jeder weitere Modus zu finden
 * ist. Vier Teile:
 *
 *  1. **Aktive Modi** — je Modus eine Karte (Zustand · Ergebnis · Beitrag ·
 *     Geräte-Chips · Details/Pausieren). NUR Aktives: das Vermischen von
 *     „läuft" und „wäre möglich" (das alte „Was läuft" mit
 *     `flowModules.ts offeredWhenInactive`) endet hier.
 *  2. **Ko-Optimierung** — ab zwei speicher-beanspruchenden Modi: ein Speicher,
 *     ein gemeinsamer Fahrplan + der SoC-Reservierungs-Stack.
 *  3. **Automationen** — die U3-Mechanik UNVERÄNDERT (geführter Baukasten,
 *     Vorlagen, Profi-Ansicht = derselbe `FlowEditorPage`, per-Knoten-Governance);
 *     nur die Rahmung ändert sich: ein Abschnitt dieser Fläche, kein zweiter Tab.
 *  4. **＋ Modus hinzufügen** — die Werkzeugkiste: jeder Modus für jeden Kunden,
 *     mit ehrlichen Voraussetzungs-Chips und dem BESTEHENDEN Gate (der Server
 *     prüft weiterhin selbst nach — E3b bleibt unangetastet).
 *
 * Alle Ableitung liegt in den reinen Modulen `surface.ts` (M0) und
 * `steuerungArea.ts`; diese Seite lädt und rendert.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError, api, type EarningsSite, type EntityStrategy, type Site } from '../api';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { GuidedRuleBuilder } from '../components/GuidedRuleBuilder';
import { FlowCanvas } from '../components/flows/FlowCanvas';
import {
  CoOptimizationStrip,
  ModeCard,
  PartHead,
  ProtectionsRow,
  ToolboxCard,
} from '../components/SteuerungParts';
import { EINRICHTUNG_DURCH_VOLTPILOT } from '../moduleSurface';
import { optimizerApi } from '../optimizerApi';
import {
  customerFlowApi,
  type FlowNodeGovernance,
  type FlowSummary,
} from '../flows/flowsApi';
import { CUSTOMER_TEMPLATES, type CustomerTemplateDef } from '../flows/customerTemplates';
import { lifecycleLabel, type EditorEntity, type FlowDocument } from '../flows/model';
import { batteryEntity, pilotTemplate, simSummaryLine } from '../flows/templates';
import { flowMode, paletteFilterFor, type SteuerungMode } from '../flows/steuerung';
import {
  AKTIVE_MODI_INTRO,
  KEINE_MODI,
  TOOLBOX_INTRO,
  coOptimization,
  socReservationStack,
  toolbox,
  type ReservationInput,
  type ToolboxEntry,
} from '../steuerungArea';
import { activeModes, type ActiveMode, type SurfaceFlow, type SurfaceSignals } from '../surface';
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

interface Editing {
  flowId: string;
  version: number;
  /** Welcher Palettenausschnitt geöffnet wird (U3-Regel: Strategie-Knoten gewinnt). */
  palette: SteuerungMode;
}

export function SteuerungSection({ site, isAdmin = false }: { site: Site; isAdmin?: boolean }) {
  const flowApi = useMemo(() => customerFlowApi(site.id), [site.id]);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);
  const [signals, setSignals] = useState<SurfaceSignals | null>(null);
  const [earnings, setEarnings] = useState<EarningsSite | null>(null);
  const [strategies, setStrategies] = useState<Record<string, EntityStrategy[]> | null>(null);
  const [reservation, setReservation] = useState<ReservationInput | null>(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [guided, setGuided] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = useCallback(() => {
    setListState('loading');
    // Nur die Flow-Liste ist tragend; alles andere ist fail-soft (der
    // `useAdaptiveLive`/`useAnlageSurface`-Präzedenzfall) - ein älteres Backend
    // oder ein 403 auf einer Admin-Route lässt die Fläche einfach ruhiger
    // aussehen, statt sie zu blockieren.
    Promise.all([
      flowApi.list(),
      flowApi.entities().catch(() => [] as EditorEntity[]),
      flowApi.governance().catch(() => ({ gatedNodes: [] } as FlowNodeGovernance)),
      api.usageProfile(site.id).catch(() => null),
      api.earnings('month').catch(() => null),
      api.entityStrategies(site.id).catch(() => null),
      optimizerApi.configViaSwitcher(site.id).catch(() => null),
    ])
      .then(([list, entityList, gov, profile, money, claims, config]) => {
        setFlows(list);
        setEntities(entityList);
        setGovernance(gov);
        setSignals(profile?.signals ?? null);
        setEarnings(money?.sites.find((s) => s.id === site.id) ?? null);
        setStrategies(claims);
        setReservation({
          socMinPct: config?.effective.socMinPct ?? null,
          socMaxPct: config?.effective.socMaxPct ?? null,
          backupReserveSocPct: config?.effective.backupReserveSocPct ?? null,
          // Die Lastspitzen-Reserve steht READ-ONLY auf dem SiteDto, ist also
          // auch ohne Admin-Route lesbar.
          peakReserveSocPct: site.peakReserveSocPct ?? null,
        });
        setListState('idle');
      })
      .catch(() => setListState('error'));
  }, [flowApi, site.id, site.peakReserveSocPct]);

  useEffect(() => {
    reload();
  }, [reload]);

  const battery = batteryEntity(entities);
  const enabledGatedTypes = useMemo(
    () => (governance?.gatedNodes ?? []).filter((n) => n.enabled).map((n) => n.type),
    [governance],
  );

  /** Die MENGE der aktiven Modi (M0) - hier wird NICHTS neu abgeleitet. */
  const modes = useMemo<ActiveMode[]>(
    () =>
      activeModes({
        signals,
        config: {
          plantKind: site.plantKind,
          tarifArt: site.tarifArt,
          netzladenErlaubt: site.netzladenErlaubt,
          leistungspreisEurKw: site.leistungspreisEurKw ?? null,
        },
        flows: (flows as SurfaceFlow[] | null) ?? null,
        entities: null,
      }),
    [signals, site, flows],
  );

  const co = useMemo(() => coOptimization(modes), [modes]);
  const layers = useMemo(() => socReservationStack(reservation), [reservation]);
  const toolboxEntries = useMemo(
    () => toolbox({ modes, entities, enabledGatedTypes }),
    [modes, entities, enabledGatedTypes],
  );

  const openFlow = useCallback(
    (flowId: string, version: number, doc: FlowDocument | null) => {
      setEditing({ flowId, version, palette: flowMode(doc ?? EMPTY_DOC) });
    },
    [],
  );

  const openSaved = useCallback(
    async (name: string, doc: FlowDocument | null, palette: SteuerungMode) => {
      setBusy(true);
      setError('');
      try {
        const created = await flowApi.create(name);
        if (doc) {
          const saved = await flowApi.save(created.flowId, 1, name, doc);
          setEditing({ flowId: saved.flowId, version: saved.flowVersion, palette });
        } else {
          setEditing({ flowId: created.flowId, version: created.flowVersion, palette });
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Der Flow konnte nicht angelegt werden.');
      } finally {
        setBusy(false);
      }
    },
    [flowApi],
  );

  const useTemplate = useCallback(
    (def: CustomerTemplateDef) => {
      const res = def.resolve(entities, site.id);
      if ('reason' in res) {
        setError(res.reason);
        return;
      }
      void openSaved(def.name, res.doc, 'automation');
    },
    [entities, site.id, openSaved],
  );

  /** „Pausieren" = den Flow stilllegen (E3b `deactivate`) - Gates unverändert. */
  const pauseMode = useCallback(
    async (mode: ActiveMode) => {
      const flowId = mode.flowRef?.flowId;
      if (!flowId) return;
      if (!window.confirm(`„${mode.label}" pausieren? Der Modus läuft dann nicht mehr.`)) return;
      setBusy(true);
      setError('');
      try {
        const res = await flowApi.deactivate(flowId);
        setNotice(res.message || `„${mode.label}" wurde pausiert.`);
        reload();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Der Modus konnte nicht pausiert werden.');
      } finally {
        setBusy(false);
      }
    },
    [flowApi, reload],
  );

  const openMode = useCallback(
    (mode: ActiveMode) => {
      const flowId = mode.flowRef?.flowId;
      if (!flowId) return;
      const row = (flows ?? []).find((f) => f.flowId === flowId);
      if (!row) return;
      openFlow(row.flowId, row.latestVersion, row.latestDocument ?? null);
    },
    [flows, openFlow],
  );

  const useToolboxEntry = useCallback(
    (entry: ToolboxEntry) => {
      setError('');
      switch (entry.action.kind) {
        case 'guided':
          setGuided(true);
          break;
        case 'market-template':
          if (!battery) {
            setError('Diese Anlage hat noch keinen Speicher als Steuer-Einheit.');
            return;
          }
          void openSaved(
            entry.title,
            pilotTemplate(entry.title, battery.id, site.id),
            'strategie',
          );
          break;
        case 'editor':
          void openSaved(entry.action.name, null, 'strategie');
          break;
        default:
          break;
      }
    },
    [battery, openSaved, site.id],
  );

  if (editing) {
    return (
      <FlowEditorPage
        api={flowApi}
        site={site}
        flowId={editing.flowId}
        initialVersion={editing.version}
        canEnableGated={isAdmin}
        lockedHint={EINRICHTUNG_DURCH_VOLTPILOT}
        paletteFilter={paletteFilterFor(editing.palette)}
        backLabel="Zur Steuerung"
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  const automations = (flows ?? []).filter(
    (f) => flowMode(f.latestDocument ?? EMPTY_DOC) === 'automation',
  );

  return (
    <div className="vp-steuerung vp-steuerung-area">
      {error && <p className="vp-flowed-notice error" role="status">{error}</p>}
      {notice && <p className="vp-flowed-notice" role="status">{notice}</p>}

      {listState === 'loading' && <TextSkeleton lines={5} />}
      {listState === 'error' && (
        <ErrorState message="Die Steuerung konnte nicht geladen werden." onRetry={reload} />
      )}

      {listState === 'idle' && flows && (
        <>
          {/* --- 1 · Aktive Modi ------------------------------------------ */}
          <section className="vp-steuerung-part" aria-label="Aktive Modi">
            <PartHead
              title="Aktive Modi"
              badge={<Badge variant="tint">{modes.length}</Badge>}
              intro={modes.length > 0 ? AKTIVE_MODI_INTRO : undefined}
            />
            {modes.length === 0 ? (
              <EmptyState
                icon="settings"
                title="Noch kein Modus aktiv"
                description={KEINE_MODI}
              />
            ) : (
              <div className="vp-modecards">
                {modes.map((mode) => (
                  <ModeCard
                    key={mode.key}
                    mode={mode}
                    earnings={earnings}
                    strategies={strategies}
                    entities={entities}
                    busy={busy}
                    onOpen={openMode}
                    onPause={pauseMode}
                  />
                ))}
              </div>
            )}
          </section>

          {/* --- 2 · Ko-Optimierung --------------------------------------- */}
          {co && (
            <section className="vp-steuerung-part" aria-label="Ko-Optimierung">
              <CoOptimizationStrip co={co} layers={layers} />
            </section>
          )}

          {/* --- 3 · Automationen (U3-Mechanik unverändert) --------------- */}
          <section className="vp-steuerung-part" aria-label="Automationen">
            <PartHead
              title="Automationen"
              intro="Eigene Wenn/Dann-Regeln für Ihre Geräte — geprüft, simuliert und erst dann aktiv."
            />
            {guided ? (
              <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
                <div className="vp-steuerung-head">
                  <h3>Automation per Baukasten</h3>
                </div>
                <GuidedRuleBuilder
                  entities={entities}
                  siteId={site.id}
                  busy={busy}
                  onCancel={() => setGuided(false)}
                  onBuild={(name, doc) => {
                    setGuided(false);
                    void openSaved(name, doc, 'automation');
                  }}
                />
              </Card>
            ) : (
              <>
                {automations.length === 0 ? (
                  <EmptyState
                    icon="zap"
                    title="Noch keine Automation"
                    description="Starten Sie mit dem Baukasten oder einer Vorlage — z. B. „Wallbox nur bei PV-Überschuss“."
                  />
                ) : (
                  <div className="vp-flowcards">
                    {automations.map((flow) => {
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
                              ? 'Aktiv — auf Ihr Gerät ausgerollt.'
                              : simLine ?? 'Noch nicht simuliert — der Dry-Run läuft vor jeder Aktivierung.'}
                          </p>
                          <div className="vp-flowcard-foot">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openFlow(flow.flowId, flow.latestVersion, doc)}
                            >
                              Öffnen
                            </Button>
                            {!active && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={async () => {
                                  if (!window.confirm(`Automation „${flow.name}“ löschen?`)) return;
                                  setBusy(true);
                                  try {
                                    await flowApi.remove(flow.flowId);
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

                <div className="vp-steuerung-head">
                  <h3>Neue Automation</h3>
                  <div className="vp-steuerung-actions">
                    <Button size="sm" onClick={() => setGuided(true)} disabled={busy}>
                      ＋ Baukasten (geführt)
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openSaved('Neue Automation', null, 'automation')}
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
            )}
          </section>

          {/* --- 4 · Die Werkzeugkiste ------------------------------------ */}
          <section className="vp-steuerung-part" aria-label="Modus hinzufügen">
            <PartHead title="＋ Modus hinzufügen" intro={TOOLBOX_INTRO} />
            <div className="vp-toolbox">
              {toolboxEntries.map((entry) => (
                <ToolboxCard key={entry.id} entry={entry} busy={busy} onUse={useToolboxEntry} />
              ))}
            </div>
          </section>

          {/* --- Automatisch aktiv (kein Modus - Schutzfunktionen) -------- */}
          <section className="vp-steuerung-part" aria-label="Automatisch aktiv">
            <PartHead title="Automatisch aktiv" />
            <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
              <ProtectionsRow />
            </Card>
          </section>

          <p className="vp-note">
            <Icon name="info" size={12} /> Vertragsnahe Modi richtet VoltPilot ein — die
            Freischaltung prüft das System bei jeder Aktivierung erneut.
          </p>
        </>
      )}
    </div>
  );
}
