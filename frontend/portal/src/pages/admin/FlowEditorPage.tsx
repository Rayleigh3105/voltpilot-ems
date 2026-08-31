/**
 * Plattform → Flows → Editor (E3a MVP, admin-only): build → validate →
 * simulate → roll out. Three panes per the EMS-v2 mockup (palette | canvas |
 * inspector), the always-visible GUARD BAR (the site's non-editable
 * constraints), live client-side validation (src/flows/validate.ts), the
 * dry-run over the existing Ersparnis-Simulation job infrastructure, and
 * activation - now the REAL E2 flowc compiler: on success the flow flips to
 * "active" and the deployment is published (green notice); a sidecar-down /
 * compiler-rejection outcome stays an honest warn notice (the api owns the
 * message and whether it activated; this page only renders `activation`).
 *
 * ALL rules live in the pure src/flows/* modules; this file wires state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { ApiError, api, type Site } from '../../api';
import {
  SimulationResultView,
  SimulationRunView,
  useSimulationJob,
} from '../../components/SimulationView';
import { ErrorState, TextSkeleton } from '../../components/States';
import { VpPicker } from '../../components/VpPicker';
import {
  FlowCanvas,
  type CanvasSelection,
  type ConnectSource,
} from '../../components/flows/FlowCanvas';
import { CodeNodeEditor } from '../../components/flows/CodeNodeEditor';
import { FlowStepList } from '../../components/flows/FlowStepList';
import '../../components/flows/FlowEditor.css';
import {
  type BoundFlowApi,
  type FlowActivationResult,
  type FlowNodeGovernance,
  type FlowVersion,
} from '../../flows/flowsApi';
import { guardChips, type GuardSources } from '../../flows/guardbar';
import { liveValues, type ChannelValue, type LiveValuesView } from '../../flows/liveValues';
import {
  positionsChanged,
  withPosition,
  type NodePosition,
  type SavedPositions,
} from '../../flows/positions';
import {
  deployedBadge,
  forkBanner,
  rolloutBusy,
  rolloutMessage,
  rolloutSteps,
  type RolloutState,
} from '../../flows/rollout';
import { stepList } from '../../flows/stepList';
import {
  addEdge,
  addNode,
  applyDerivedClaims,
  catalog,
  catalogType,
  customerVisible,
  lifecycleLabel,
  lifecycleSteps,
  removeEdge,
  removeNode,
  setParam,
  type CatalogParam,
  type CatalogType,
  type EditorEntity,
  type FlowDocument,
  type FlowNode,
  type PortRef,
  type PortType,
} from '../../flows/model';
import { isValid, validateFlow, type FlowFinding } from '../../flows/validate';
import { showTechnicalLayer } from '../../rollen';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { LIST_POLL_MS } from '../../pollCadence';

const GROUP_ORDER: Array<{ key: string; label: string }> = [
  { key: 'strategie', label: 'Strategie' },
  { key: 'daten', label: 'Daten' },
  { key: 'logik', label: 'Logik' },
  { key: 'aktion', label: 'Aktion' },
];

const GROUP_SWATCH: Record<string, string> = {
  strategie: '#1E3A5F',
  daten: '#2196F3',
  logik: '#78909C',
  aktion: '#2E9E5B',
};

interface FlowEditorPageProps {
  /** The site-bound flow API (admin or customer surface, see flowsApi factories). */
  api: BoundFlowApi;
  site: Site;
  flowId: string;
  initialVersion: number;
  onClose: () => void;
  /**
   * May this caller build with GATED strategy nodes freely? Admins can (they
   * enable them), so gated nodes are placeable; customers cannot, so a gated
   * node is placeable only when VoltPilot has enabled it for the site, else it
   * renders locked with {@link lockedHint}. Default true (admin).
   */
  canEnableGated?: boolean;
  /** The German hint on a locked gated node (Beratung-CTA copy). */
  lockedHint?: string;
  /**
   * Pre-filter the palette to a mode (U3: Strategien vs Automationen). The
   * canvas + inspector are unchanged; only which catalog types the palette
   * offers is narrowed. Absent = the full palette.
   */
  paletteFilter?: (type: CatalogType) => boolean;
  /** Back-button label (default "Alle Flows"). */
  backLabel?: string;
  /**
   * Audit E-1: open on the plain-German REVIEW step (the rule as sentences +
   * Ausrollen, editor one click away) instead of the canvas. The guided
   * builder and the templates hand over this way; the free editor does not.
   */
  initialView?: 'review' | 'editor';
}

export function FlowEditorPage({
  api: flowApi,
  site,
  flowId,
  initialVersion,
  onClose,
  canEnableGated = true,
  lockedHint = 'VoltPilot richtet ein',
  paletteFilter,
  backLabel = 'Alle Flows',
  initialView = 'editor',
}: FlowEditorPageProps) {
  const [version, setVersion] = useState(initialVersion);
  const [name, setName] = useState('');
  const [lifecycle, setLifecycle] = useState('draft');
  const [doc, setDoc] = useState<FlowDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadState, setLoadState] = useState<'loading' | 'idle' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [guards, setGuards] = useState<GuardSources | null>(null);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);

  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [connectFrom, setConnectFrom] = useState<ConnectSource | null>(null);
  const [serverFindings, setServerFindings] = useState<FlowFinding[] | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [activation, setActivation] = useState<FlowActivationResult | null>(null);

  // Portal v3 M5: canvas layout (OUTSIDE the hashed document), the device's own
  // view of what is running, live channel values, and the guided rollout.
  const [positions, setPositions] = useState<SavedPositions>({});
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [ack, setAck] = useState<{ version: number; state: string; detail: string | null } | null>(null);
  const [channels, setChannels] = useState<ChannelValue[] | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<
    Array<{ nodeId: string; state: string; text: string | null; since: string | null }> | null
  >(null);
  const [rollout, setRollout] = useState<RolloutState>({ phase: 'idle' });
  /**
   * Audit E-1: coming out of the guided builder the customer was dropped onto
   * the full canvas ("… Gerät wählen, fertig" → a 12-block technical palette).
   * `view` inserts a plain-German REVIEW step in between: the rule as sentences
   * plus ONE Ausrollen button, with the editor one optional click away.
   */
  const [view, setView] = useState<'review' | 'editor'>(
    initialView === 'review' ? 'review' : 'editor',
  );
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 720px)').matches
      : false,
  );

  const savedPositionsRef = useRef<SavedPositions>({});
  const versionRef = useRef(version);
  versionRef.current = version;

  // ---- loading -----------------------------------------------------------

  const adopt = useCallback((v: FlowVersion) => {
    setVersion(v.flowVersion);
    setName(v.name);
    setLifecycle(v.lifecycle);
    setDoc(v.document);
    setDirty(false);
    setServerFindings(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    Promise.all([
      flowApi.get(flowId, initialVersion),
      flowApi.entities().catch(() => [] as EditorEntity[]),
      flowApi.socBands().catch(() => null),
      flowApi.governance().catch(() => ({ gatedNodes: [] } as FlowNodeGovernance)),
      // M5 Part A: the saved canvas arrangement (fail-soft - an older backend
      // simply yields the deterministic auto-layout).
      flowApi.layout(flowId).catch(() => ({ positions: {} })),
      // M5 Part B: what the DEVICE says it is running (fail-soft).
      flowApi.list().catch(() => []),
    ])
      .then(([flow, entityList, bands, gov, layout, summaries]) => {
        if (cancelled) return;
        adopt(flow);
        setPositions(layout.positions ?? {});
        savedPositionsRef.current = layout.positions ?? {};
        setActiveVersion(summaries.find((f) => f.flowId === flowId)?.activeVersion ?? null);
        setEntities(entityList);
        setGovernance(gov);
        setGuards({
          netzladenErlaubt: site.netzladenErlaubt,
          maxFeedInKw: site.maxFeedInKw,
          leistungspreisEurKw: site.leistungspreisEurKw ?? null,
          socMinPct: bands?.socMinPct ?? null,
          socMaxPct: bands?.socMaxPct ?? null,
          backupReserveSocPct: bands?.backupReserveSocPct ?? null,
        });
        setLoadState('idle');
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowApi, site.id, flowId]);

  const pollRef = useRef<() => void>(() => {});
  // M5 Part C: live values. Channel values come from the shipped topology
  // read-model (its capabilities carry the latest per-channel value); per-node
  // states come ONLY from the device's feature-flagged heartbeat block. Both
  // fail-soft: without them the editor stays fully usable and shows NO state.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api.topology(site.id)
        .then((topology) => {
          if (cancelled) return;
          setChannels(topology.entities.flatMap((entity) => entity.capabilities.map((cap) => ({
            entityId: entity.id,
            channel: cap.channel,
            value: cap.value,
          }))));
        })
        .catch(() => undefined);
      flowApi.liveStatus()
        .then((status) => {
          if (cancelled) return;
          const mine = status.nodes.filter((n) => n.flowId === flowId);
          // An EMPTY set means "this device does not report node states" - we
          // pass null so the editor shows none rather than a guessed one.
          setNodeStatuses(mine.length > 0 ? mine.map((n) => ({
            nodeId: n.nodeId, state: n.state, text: n.text, since: n.since,
          })) : null);
          const deviceAck = status.acks.find((a) => a.flowId === flowId);
          setAck(deviceAck
            ? { version: deviceAck.flowVersion, state: deviceAck.state, detail: deviceAck.detail }
            : null);
        })
        .catch(() => undefined);
    };
    pollRef.current = poll;
    poll();
    return () => {
      cancelled = true;
    };
  }, [flowApi, site.id, flowId]);
  // `useFreshnessPoll` statt eines nackten Intervalls (die Haus-Disziplin);
  // LIST: der Editor zeigt Zustände, keine sekündlich bewegten Messwerte.
  useFreshnessPoll(() => pollRef.current(), LIST_POLL_MS);

  // Phones render the read-only step list, never a mini canvas.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(max-width: 720px)');
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // M5 Part A: a drag writes the LAYOUT resource, debounced - never the
  // document, so `content_hash` cannot move and the device is not re-deployed.
  const onPositionChange = useCallback((nodeId: string, pos: NodePosition) => {
    setPositions((current) => withPosition(current, nodeId, pos));
  }, []);

  useEffect(() => {
    if (!positionsChanged(savedPositionsRef.current, positions)) return undefined;
    const timer = window.setTimeout(() => {
      const snapshot = positions;
      flowApi.saveLayout(flowId, snapshot)
        .then(() => {
          savedPositionsRef.current = snapshot;
        })
        .catch(() => undefined); // a failed layout write is never a blocker
    }, 600);
    return () => window.clearTimeout(timer);
  }, [positions, flowApi, flowId]);

  const live: LiveValuesView | null = useMemo(
    () => (doc ? liveValues({ doc, channels, statuses: nodeStatuses }) : null),
    [doc, channels, nodeStatuses],
  );

  // The ONE role helper (M7): the technical layer keeps the diagnostic-only
  // nodes; a customer surface never offers them (N-1).
  const technical = showTechnicalLayer();

  // The gated node types VoltPilot has enabled for this site (AE7 governance).
  const enabledGated = useMemo(
    () => new Set((governance?.gatedNodes ?? []).filter((n) => n.enabled).map((n) => n.type)),
    [governance],
  );

  // ---- validation (live, client-side; server on Prüfen) ------------------

  const clientFindings = useMemo(
    () => (doc ? validateFlow(doc, entities) : []),
    [doc, entities],
  );
  const findings = serverFindings ?? clientFindings;
  const errorNodeIds = useMemo(
    () => new Set(findings.filter((f) => f.severity === 'error').flatMap((f) => f.nodeIds)),
    [findings],
  );
  const errorEdgeIds = useMemo(
    () => new Set(findings.filter((f) => f.severity === 'error').flatMap((f) => f.edgeIds)),
    [findings],
  );

  // ---- edit operations ---------------------------------------------------

  const change = useCallback((next: FlowDocument) => {
    setDoc(next);
    setDirty(true);
    setServerFindings(null);
    setActivation(null);
  }, []);

  const handlePortClick = useCallback(
    (ref: PortRef, direction: 'in' | 'out', type: PortType) => {
      if (!doc) return;
      if (direction === 'out') {
        setConnectFrom({ ref, type });
        return;
      }
      if (connectFrom) {
        change(addEdge(doc, connectFrom.ref, ref));
        setConnectFrom(null);
      }
    },
    [doc, connectFrom, change],
  );

  // ---- save / validate / simulate / activate -----------------------------

  const save = useCallback(async (): Promise<FlowVersion | null> => {
    if (!doc) return null;
    setBusy(true);
    setNotice(null);
    try {
      const stamped = applyDerivedClaims(doc);
      const saved = await flowApi.save(flowId, versionRef.current,
        name || 'Unbenannter Flow', stamped);
      adopt(saved);
      return saved;
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof ApiError ? e.message : 'Speichern fehlgeschlagen.',
      });
      return null;
    } finally {
      setBusy(false);
    }
  }, [doc, name, flowApi, flowId, adopt]);

  const check = useCallback(async () => {
    const saved = dirty ? await save() : { flowVersion: versionRef.current };
    if (!saved) return;
    setBusy(true);
    try {
      const result = await flowApi.validate(flowId, saved.flowVersion);
      setServerFindings(result.findings);
      setNotice(result.valid
        ? { tone: 'ok', text: 'Der Flow ist gültig - bereit für die Simulation.' }
        : { tone: 'warn', text: 'Der Flow hat Validierungsfehler (siehe unten).' });
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof ApiError ? e.message : 'Prüfung fehlgeschlagen.',
      });
    } finally {
      setBusy(false);
    }
  }, [dirty, save, flowApi, flowId]);

  const simJobApi = useMemo(
    () => ({
      start: async () => {
        const result = await flowApi.simulate(flowId, versionRef.current);
        return { simulationId: result.simulationId };
      },
      poll: (simulationId: string) =>
        flowApi.simulationStatus(flowId, versionRef.current, simulationId),
    }),
    [flowApi, flowId],
  );
  const sim = useSimulationJob(simJobApi);

  const simulate = useCallback(async () => {
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    setShowReport(false);
    setNotice(null);
    await sim.start({});
  }, [dirty, save, sim]);

  // The poll flips draft → simulated server-side; mirror it once done.
  useEffect(() => {
    if (sim.status?.status === 'done') {
      setLifecycle((current) => (current === 'draft' ? 'simulated' : current));
    }
  }, [sim.status?.status]);

  /**
   * The ONE guided "Ausrollen" - prüfen → simulieren → ausrollen over the
   * EXISTING endpoints. A refusal stops the run and leaves the active version
   * untouched; every backend reason is mapped to customer-grade German by the
   * pure rollout.ts (since the v3 release these strings are customer copy).
   */
  const rolloutNow = useCallback(async () => {
    if (!doc) return;
    setNotice(null);
    setActivation(null);
    // E-6: the catch-all used to hardcode failedAt:'ausrollen', so a THROW in
    // validate or simulate was attributed to the wrong step (the strip showed
    // "Prüfen ✓ · Simulieren ✓ · Ausrollen ✗" next to "Der Simulationsdienst
    // ist gerade nicht erreichbar"). Track the running step and use it.
    const running = { at: 'pruefen' as 'pruefen' | 'simulieren' | 'ausrollen' };
    setRollout({ phase: 'pruefen' });
    try {
      const savedVersion = dirty ? (await save())?.flowVersion : versionRef.current;
      if (savedVersion == null) {
        setRollout({ phase: 'fehler', failedAt: 'pruefen' });
        return;
      }
      const check = await flowApi.validate(flowId, savedVersion);
      setServerFindings(check.findings);
      if (!check.valid) {
        setRollout({ phase: 'fehler', failedAt: 'pruefen' });
        return;
      }

      running.at = 'simulieren';
      setRollout({ phase: 'simulieren' });
      const started = await flowApi.simulate(flowId, savedVersion);
      let status = await flowApi.simulationStatus(flowId, savedVersion, started.simulationId);
      for (let i = 0; i < 150 && status.status !== 'done' && status.status !== 'failed'; i += 1) {
        await new Promise((r) => { window.setTimeout(r, 2000); });
        status = await flowApi.simulationStatus(flowId, savedVersion, started.simulationId);
      }
      if (status.status !== 'done') {
        // E-7: the dry-run's own German sentence names the real cause (e.g.
        // missing price coverage). Dropping it left the customer with "bitte
        // erneut versuchen" - an instruction they could follow forever.
        setRollout({
          phase: 'fehler',
          failedAt: 'simulieren',
          message: status.error ?? null,
        });
        return;
      }
      setLifecycle((current) => (current === 'draft' ? 'simulated' : current));

      running.at = 'ausrollen';
      setRollout({ phase: 'ausrollen' });
      const result = await flowApi.activate(flowId, savedVersion);
      setActivation(result);
      if (!result.activated) {
        setRollout({
          phase: 'fehler',
          failedAt: 'ausrollen',
          reason: result.reason ?? null,
          message: result.message ?? null,
        });
        return;
      }
      setLifecycle('active');
      setActiveVersion(savedVersion);
      setRollout({ phase: 'fertig', message: result.message ?? null });
    } catch (e) {
      setRollout({
        phase: 'fehler',
        failedAt: running.at,
        message: e instanceof ApiError ? e.message : null,
      });
    }
  }, [doc, dirty, save, flowApi, flowId]);

  const deactivate = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    setActivation(null);
    try {
      const result = await flowApi.deactivate(flowId);
      setLifecycle(result.lifecycle || 'retired');
      setNotice({ tone: 'ok', text: result.message });
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof ApiError ? e.message : 'Stilllegen fehlgeschlagen.',
      });
    } finally {
      setBusy(false);
    }
  }, [flowApi, flowId]);

  // ---- render ------------------------------------------------------------

  if (loadState === 'loading') {
    return <TextSkeleton lines={6} />;
  }
  if (loadState === 'error' || !doc) {
    return <ErrorState message="Der Flow konnte nicht geladen werden." onRetry={onClose} />;
  }

  const selectedNode = selection?.kind === 'node'
    ? doc.nodes.find((n) => n.id === selection.id) ?? null
    : null;
  const selectedEdge = selection?.kind === 'edge'
    ? doc.edges.find((e) => e.id === selection.id) ?? null
    : null;
  const valid = isValid(findings);
  const badge = deployedBadge({
    activeVersion,
    ackVersion: ack?.version ?? null,
    ackState: (ack?.state as 'active' | 'error' | 'unsupported' | undefined) ?? null,
    ackDetail: ack?.detail ?? null,
  });
  const fork = forkBanner({ activeVersion, editingVersion: version, dirty });
  const rolloutRunning = rolloutBusy(rollout);
  const rolloutText = rolloutMessage(rollout);
  const simRunning = sim.busy;
  const simResult = sim.status?.status === 'done' ? sim.status.result ?? null : null;

  // E-1: the plain-German REVIEW step between the guided builder and the
  // canvas - the rule as sentences (the SAME pure stepList the phone shows),
  // the three-step progress, ONE "Ausrollen" and the editor as an option.
  if (view === 'review' && !phone) {
    return (
      <div className="vp-flowed review">
        <div className="vp-flowed-bar">
          <button type="button" className="vp-flowed-back" onClick={onClose}>
            <Icon name="chevron-left" size={16} /> {backLabel}
          </button>
          <span className="vp-flowed-name">{name}</span>
        </div>

        <div className="vp-flowreview">
          <h3>Ihre Regel</h3>
          <p className="vp-flowreview-lead">
            So haben wir Ihre Regel verstanden. Passt das, rollen wir sie aus - VoltPilot prüft
            und simuliert sie vorher.
          </p>
          <FlowStepList
            steps={stepList(doc, entities, live)}
            statusLabel={badge.label}
            statusTone={badge.tone}
            showPhoneHint={false}
          />

          {findings.filter((f) => f.severity === 'error').length > 0 && (
            <p className="vp-flowed-notice warn" role="status">
              Diese Regel ist noch nicht vollständig. Öffnen Sie den Editor, um die markierten
              Stellen zu ergänzen.
            </p>
          )}

          {rollout.phase !== 'idle' && (
            <div className="vp-rollout" role="status" data-testid="rollout-strip">
              {rolloutSteps(rollout).map((step) => (
                <span key={step.key} className={`vp-rollout-step ${step.state}`}>{step.label}</span>
              ))}
              {rolloutText && <span className="vp-rollout-msg">{rolloutText}</span>}
            </div>
          )}
          {notice && (
            <div className={`vp-flowed-notice ${notice.tone}`} role="status">{notice.text}</div>
          )}

          <div className="vp-flowreview-foot">
            {rollout.phase === 'fertig' ? (
              <Button size="sm" onClick={onClose}>Fertig</Button>
            ) : (
              <Button
                size="sm"
                onClick={rolloutNow}
                disabled={busy || rolloutRunning}
                title="Prüfen, simulieren und auf das Gerät ausrollen - in einem Schritt."
              >
                Ausrollen
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setView('editor')}
              disabled={rolloutRunning}
            >
              Im Editor öffnen
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={rolloutRunning}>
              Später
            </Button>
          </div>
          <p className="vp-flowreview-guards">
            <Icon name="shield" size={14} /> Nicht editierbar:{' '}
            {guardChips(guards).map((chip) => chip.text).join(' · ')}
          </p>
        </div>
      </div>
    );
  }

  // PHONE: a read-only step list with the same live values, never a canvas.
  if (phone) {
    return (
      <div className="vp-flowed phone">
        <div className="vp-flowed-bar">
          <button type="button" className="vp-flowed-back" onClick={onClose}>
            <Icon name="chevron-left" size={16} /> {backLabel}
          </button>
          <span className="vp-flowed-name">{name}</span>
        </div>
        <FlowStepList
          steps={stepList(doc, entities, live)}
          statusLabel={badge.label}
          statusTone={badge.tone}
          onPause={lifecycle === 'active' ? deactivate : undefined}
          pauseBusy={busy}
        />
        {notice && (
          <div className={`vp-flowed-notice ${notice.tone}`} role="status">{notice.text}</div>
        )}
      </div>
    );
  }

  return (
    <div className="vp-flowed">
      <div className="vp-flowed-bar">
        <button type="button" className="vp-flowed-back" onClick={onClose}>
          <Icon name="chevron-left" size={16} /> {backLabel}
        </button>
        <input
          className="vp-flowed-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          aria-label="Flow-Name"
        />
        <Badge variant={lifecycle === 'active' ? 'ok' : lifecycle === 'simulated' ? 'tint' : 'off'}>
          {lifecycleLabel(lifecycle)} · v{version}
        </Badge>
        <span className="vp-flowed-rail" aria-label="Lebenszyklus">
          {lifecycleSteps(lifecycle).map((step, i) => (
            <span key={step.label} className="vp-flowed-railstep">
              {i > 0 && <span className="vp-flowed-railarrow">→</span>}
              <span className={`vp-flowed-railchip ${step.state}`}>{step.label}</span>
            </span>
          ))}
        </span>
        <span className="vp-flowed-actions">
          <Button variant="outline" size="sm" onClick={check} disabled={busy}>
            Prüfen
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={simulate}
            disabled={busy || simRunning || !valid}
            title={valid ? undefined : 'Bitte zuerst die Validierungsfehler beheben.'}
          >
            Simulieren
          </Button>
          {lifecycle === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={deactivate}
              disabled={busy}
              title="Diesen Flow anhalten - das Gerät fällt auf die sichere Grundregelung zurück."
            >
              Stilllegen
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={rolloutNow}
              disabled={busy || rolloutRunning || simRunning}
              title="Prüfen, simulieren und auf das Gerät ausrollen - in einem Schritt."
            >
              Ausrollen
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={busy || !dirty}>
            Speichern
          </Button>
        </span>
      </div>

      <div className="vp-flowed-deploy" data-testid="deployed-badge">
        <Badge variant={badge.tone === 'ok' ? 'ok' : badge.tone === 'warn' ? 'warn' : 'off'}>
          {badge.label}
        </Badge>
        {badge.detail && <span className="vp-deploy-detail">{badge.detail}</span>}
      </div>
      {fork && (
        <div className="vp-flowed-fork" role="status">{fork}</div>
      )}
      {rollout.phase !== 'idle' && (
        <div className="vp-rollout" role="status" data-testid="rollout-strip">
          {rolloutSteps(rollout).map((step) => (
            <span key={step.key} className={`vp-rollout-step ${step.state}`}>{step.label}</span>
          ))}
          {rolloutText && <span className="vp-rollout-msg">{rolloutText}</span>}
        </div>
      )}

      {notice && (
        <div className={`vp-flowed-notice ${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}
      {/* E-9: while the guided rollout is showing, IT owns the outcome message
          (customer German). Rendering the raw server string next to it showed
          "Flow aktiviert (Version 1)." twice. */}
      {activation && rollout.phase === 'idle' && (
        <div
          className={`vp-flowed-notice ${activation.activated ? 'ok' : 'warn'}`}
          role="status"
        >
          {activation.message}
          {activation.activated && activation.published && ' Rollout an das Gerät veröffentlicht.'}
        </div>
      )}

      <div className="vp-flowed-main">
        <aside className="vp-flowed-palette" aria-label="Baustein-Katalog">
          {GROUP_ORDER.map((group) => {
            const groupTypes = catalog.types.filter(
              (t) => t.group === group.key
                && (!paletteFilter || paletteFilter(t))
                // D-19: generated-only types (the consumer-policy compiler's
                // vp.consumer.reactive) never appear in ANY palette - not even
                // the technical layer places one by hand.
                && t.generated !== true
                // N-1: a node whose promise the platform cannot keep (the
                // notification has no delivery channel, and the Wenn/Dann gate
                // only feeds it) is offered ONLY in the technical layer -
                // never to a customer who would then read "Läuft".
                && (customerVisible(t) || technical),
            );
            if (groupTypes.length === 0) return null;
            return (
            <div key={group.key} className="vp-flowed-pgroup">
              <h4>{group.label}</h4>
              {groupTypes
                .map((type) => {
                  // A gated strategy node (Arbitrage/Peak/atyp. NN) is placeable
                  // only when this caller may build with it: admins always (they
                  // enable it), customers only once VoltPilot has enabled it for
                  // the site (AE7 governance) - else it renders locked with the
                  // Beratung-CTA hint. Free nodes are always placeable.
                  const locked = type.gated && !canEnableGated && !enabledGated.has(type.type);
                  if (locked) {
                    return (
                      <div
                        key={type.type}
                        className="vp-flowed-pnode locked"
                        title={lockedHint}
                      >
                        <Icon name="lock" size={12} /> {type.label}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={type.type}
                      type="button"
                      className="vp-flowed-pnode"
                      title={type.description}
                      onClick={() => change(addNode(doc, type.type))}
                    >
                      <span
                        className="vp-flowed-sq"
                        style={{ background: GROUP_SWATCH[group.key] }}
                      />
                      {type.label}
                    </button>
                  );
                })}
            </div>
            );
          })}
        </aside>

        <div className="vp-flowed-center">
          {connectFrom && (
            <div className="vp-flowed-connect" role="status">
              Verbinden: kompatiblen Eingang anklicken (Esc/Klick daneben bricht ab).
            </div>
          )}
          <FlowCanvas
            doc={doc}
            entities={entities}
            selection={selection}
            connectFrom={connectFrom}
            errorNodeIds={errorNodeIds}
            errorEdgeIds={errorEdgeIds}
            onSelectNode={(id) => {
              setSelection({ kind: 'node', id });
              setConnectFrom(null);
            }}
            onSelectEdge={(id) => {
              setSelection({ kind: 'edge', id });
              setConnectFrom(null);
            }}
            onPortClick={handlePortClick}
            onBackground={() => {
              setSelection(null);
              setConnectFrom(null);
            }}
            positions={positions}
            onPositionChange={onPositionChange}
            live={live}
          />

          <div className="vp-flowed-guardbar" aria-label="Nicht editierbare Grenzen">
            <span className="vp-flowed-guardlead">
              <Icon name="shield" size={14} /> <b>Nicht editierbar:</b>
            </span>
            {guardChips(guards).map((chip) => (
              <span key={chip.key} className="vp-flowed-guard">
                {chip.text}
              </span>
            ))}
          </div>

          {(simRunning || sim.error || simResult) && (
            <div className="vp-flowed-simstrip">
              {simRunning && <SimulationRunView status={sim.status} error={null} />}
              {sim.error && <SimulationRunView status={sim.status} error={sim.error} />}
              {simResult && !simRunning && !sim.error && (
                <>
                  <span>
                    ✓ <b>Simulation abgeschlossen</b>
                    {simResult.headline
                      ? ` - Vorteil gegenüber ohne Speicher: ${Math.round(simResult.headline.gesamtVorteilNettoEur)} € pro Jahr`
                      : ''}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setShowReport((s) => !s)}>
                    {showReport ? 'Bericht ausblenden' : 'Bericht ansehen'}
                  </Button>
                </>
              )}
            </div>
          )}
          {showReport && simResult && (
            <div className="vp-flowed-report">
              <SimulationResultView result={simResult} running={false} />
            </div>
          )}

          {findings.length > 0 && (
            <div className="vp-flowed-findings" aria-label="Validierung">
              <h4>
                Validierung {serverFindings ? '(Server)' : '(live)'} ·{' '}
                {findings.filter((f) => f.severity === 'error').length} Fehler
              </h4>
              <ul>
                {findings.map((finding, i) => (
                  <li key={`${finding.rule}-${i}`}>
                    <button
                      type="button"
                      className={`vp-flowed-finding ${finding.severity}`}
                      onClick={() => {
                        if (finding.nodeIds.length > 0) {
                          setSelection({ kind: 'node', id: finding.nodeIds[0] });
                        }
                      }}
                    >
                      <Badge variant={finding.severity === 'error' ? 'warn' : 'off'}>
                        {finding.rule}
                      </Badge>
                      <span>{finding.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside className="vp-flowed-inspector" aria-label="Konfiguration">
          {selectedNode && (
            <NodeInspector
              node={selectedNode}
              entities={entities}
              onParam={(paramName, value) => change(setParam(doc, selectedNode.id, paramName, value))}
              onRemove={() => {
                change(removeNode(doc, selectedNode.id));
                setSelection(null);
              }}
            />
          )}
          {selectedEdge && (
            <div>
              <h4>Verbindung</h4>
              <p className="vp-flowed-help">
                {selectedEdge.from.node}.{selectedEdge.from.port} →{' '}
                {selectedEdge.to.node}.{selectedEdge.to.port}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  change(removeEdge(doc, selectedEdge.id));
                  setSelection(null);
                }}
              >
                Verbindung löschen
              </Button>
            </div>
          )}
          {!selectedNode && !selectedEdge && (
            <TriggerInspector
              doc={doc}
              onChange={change}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector pieces
// ---------------------------------------------------------------------------

function NodeInspector({
  node,
  entities,
  onParam,
  onRemove,
}: {
  node: FlowNode;
  entities: EditorEntity[];
  onParam: (name: string, value: unknown) => void;
  onRemove: () => void;
}) {
  const type = catalogType(node.type);
  if (!type) {
    return <p className="vp-flowed-help">Unbekannter Baustein-Typ „{node.type}“.</p>;
  }
  return (
    <div>
      <h4>
        <span className="vp-flowed-sq" style={{ background: GROUP_SWATCH[type.group] }} />
        {type.label}
      </h4>
      {type.description && <p className="vp-flowed-help">{type.description}</p>}
      {type.parameters.map((param) => (
        <ParamField
          key={param.name}
          type={type}
          param={param}
          value={node.parameters?.[param.name]}
          node={node}
          entities={entities}
          onChange={(value) => onParam(param.name, value)}
          onTimeout={(ms) => onParam('timeout_ms', ms)}
        />
      ))}
      {node.claims && node.claims.length > 0 && (
        <p className="vp-flowed-hint">
          Dieser Baustein beansprucht die Steuerung von „
          {node.claims.map((c) => entities.find((e) => e.id === c.entity_id)?.label
            ?? c.entity_id).join('", "')}
          “{node.claims.some((c) => c.delegated) ? ' - delegiert an die Co-Optimierung' : ''}.
        </p>
      )}
      {type.hint && <p className="vp-flowed-hint">{type.hint}</p>}
      <div className="vp-flowed-inspector-foot">
        <Button variant="outline" size="sm" onClick={onRemove}>
          <Icon name="trash" size={14} /> Baustein entfernen
        </Button>
      </div>
    </div>
  );
}

function ParamField({
  type,
  param,
  value,
  node,
  entities,
  onChange,
  onTimeout,
}: {
  type: CatalogType;
  param: CatalogParam;
  value: unknown;
  node: FlowNode;
  entities: EditorEntity[];
  onChange: (value: unknown) => void;
  onTimeout?: (ms: number | null) => void;
}) {
  const label = param.label ?? param.name;
  const id = `flowed-param-${node.id}-${param.name}`;
  // The sandboxed code node (D-16): a plain monospace textarea + the three
  // clamps, never a CDN editor (the portal CSP is script-src 'self').
  if (param.kind === 'code') {
    const timeoutSpec = type.parameters.find((p) => p.name === 'timeout_ms');
    const timeout = timeoutSpec
      ? (node.parameters?.[timeoutSpec.name] as number | undefined) ?? null
      : null;
    return (
      <CodeNodeEditor
        inputId={id}
        value={String(value ?? '')}
        maxLength={param.maxLength ?? 4000}
        timeoutMs={typeof timeout === 'number' ? timeout : null}
        onChange={(code) => onChange(code)}
        onTimeoutChange={(ms) => onTimeout?.(ms)}
      />
    );
  }
  // The code node's timeout is edited INSIDE CodeNodeEditor - do not render a
  // second field for it.
  if (type.type === 'vp.logic.function' && param.name === 'timeout_ms') return null;
  if (param.kind === 'entityRef') {
    const options = param.entityTypes
      ? entities.filter((e) => param.entityTypes?.includes(e.entityType))
      : entities;
    return (
      <div className="vp-flowed-fld">
        <VpPicker
          id={id}
          label={label}
          options={[
            { value: '', label: '– wählen –' },
            ...options.map((entity) => ({ value: entity.id, label: entity.label })),
          ]}
          value={String(value ?? '')}
          onChange={onChange}
        />
        {entities.length === 0 && (
          <p className="vp-flowed-help">
            Keine v2-Entitäten - bitte zuerst das Entitäten-Bootstrap dieser Anlage ausführen.
          </p>
        )}
      </div>
    );
  }
  if (param.kind === 'channel') {
    const entityParam = type.parameters.find((p) => p.kind === 'entityRef');
    const entity = entities.find(
      (e) => e.id === String(node.parameters?.[entityParam?.name ?? 'entity_id'] ?? ''),
    );
    return (
      <VpPicker
        id={id}
        className="vp-flowed-fld"
        label={label}
        options={[
          { value: '', label: '– wählen –' },
          ...(entity?.measure ?? []).map((channel) => ({ value: channel, label: channel })),
        ]}
        value={String(value ?? '')}
        onChange={onChange}
      />
    );
  }
  if (param.kind === 'enum') {
    return (
      <VpPicker
        id={id}
        className="vp-flowed-fld"
        label={label}
        options={[
          ...(param.required ? [] : [{ value: '', label: '– Standard –' }]),
          ...(param.options ?? []).map((option) => ({
            value: option,
            label: param.optionLabels?.[option] ?? option,
          })),
        ]}
        value={String(value ?? '')}
        onChange={onChange}
      />
    );
  }
  if (param.kind === 'number') {
    return (
      <div className="vp-flowed-fld">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="number"
          className="vp-select"
          value={value === undefined || value === null ? '' : String(value)}
          min={param.min}
          max={param.max}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
        {param.help && <p className="vp-flowed-help">{param.help}</p>}
      </div>
    );
  }
  return (
    <div className="vp-flowed-fld">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={param.kind === 'time' ? 'time' : 'text'}
        className="vp-select"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
      {param.help && <p className="vp-flowed-help">{param.help}</p>}
    </div>
  );
}

function TriggerInspector({
  doc,
  onChange,
}: {
  doc: FlowDocument;
  onChange: (doc: FlowDocument) => void;
}) {
  return (
    <div>
      <h4>Auslöser</h4>
      <p className="vp-flowed-help">
        Wann der Flow neu bewertet wird. Bausteine auf der Leinwand anklicken, um sie zu
        konfigurieren; Ausgang → Eingang anklicken, um zu verbinden.
      </p>
      {doc.triggers.map((trigger) => (
        <div key={trigger.id} className="vp-flowed-trigger">
          <span>
            {trigger.kind === 'slot-boundary' && 'Slot-Takt (15 min)'}
            {trigger.kind === 'interval' && 'Intervall'}
            {trigger.kind === 'value-change' && 'Wertänderung'}
            {trigger.kind === 'event' && `Ereignis ${trigger.event ?? ''}`}
          </span>
          {trigger.kind === 'interval' && (
            <input
              type="number"
              className="vp-select"
              aria-label="Sekunden"
              value={trigger.every_s ?? 900}
              min={1}
              max={86400}
              onChange={(e) => onChange({
                ...doc,
                triggers: doc.triggers.map((t) => (t.id === trigger.id
                  ? { ...t, every_s: Number(e.target.value) }
                  : t)),
              })}
            />
          )}
          <button
            type="button"
            className="vp-flowed-trigger-x"
            aria-label={`Auslöser ${trigger.id} entfernen`}
            onClick={() => onChange({
              ...doc,
              triggers: doc.triggers.filter((t) => t.id !== trigger.id),
            })}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <div className="vp-flowed-inspector-foot">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({
            ...doc,
            triggers: [...doc.triggers, {
              id: nextTriggerId(doc),
              kind: 'interval',
              every_s: 900,
            }],
          })}
        >
          ＋ Intervall
        </Button>{' '}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({
            ...doc,
            triggers: [...doc.triggers, { id: nextTriggerId(doc), kind: 'slot-boundary' }],
          })}
        >
          ＋ Slot-Takt
        </Button>
      </div>
    </div>
  );
}

function nextTriggerId(doc: FlowDocument): string {
  const taken = new Set(doc.triggers.map((t) => t.id));
  for (let i = 1; ; i += 1) {
    if (!taken.has(`t${i}`)) return `t${i}`;
  }
}
