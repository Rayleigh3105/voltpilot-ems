/**
 * Anlage → **Steuerung** (Portal v3 · M4, spec `docs/portal-v3/M4-steuerung.md`).
 *
 * Die Fläche beantwortet EINE Frage — „Was darf VoltPilot, und was habe ich
 * selbst geregelt?" — mit genau ZWEI Kapseln und einer schmalen Schutz-Zeile:
 *
 *  1. **Modus-Profile** — kompakte Zeilen (Statuspunkt · ein Satz mit echten
 *     Zahlen · Schalter), darunter als Fußzeile der Ko-Optimierungs-Streifen
 *     mit dem SoC-Reservierungs-Stack. „Profile verwalten →" öffnet M3s Regal.
 *  2. **Automationen** — je Regel eine Zeile mit ihrem lebenden Zustand und
 *     EINEM Knopf „＋ Neue Automation", dessen Dialog die drei Wege in dieser
 *     Reihenfolge anbietet: Vorlage → geführter Baukasten → Editor.
 *
 * Die frühere Vier-Teilung (Aktive Modi → Ko-Optimierung → Automationen +
 * Vorlagen → Werkzeugkiste) ist damit aufgelöst; Angebote leben ausschließlich
 * in M3s Regal, es gibt keine zweite Tür in den Editor mehr.
 *
 * Alle Ableitung liegt in den reinen Modulen `surface.ts` (M0), `profiles.ts`
 * (M3), `steuerungArea.ts` und `flows/templateFilter.ts`; diese Seite lädt und
 * rendert. Gates bleiben unverändert — der Server prüft bei jeder Aktivierung
 * selbst nach.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { ApiError, api, type EarningsSite, type Site } from '../api';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { InfoTip } from '../components/InfoTip';
import { NeueAutomationDialog } from '../components/NeueAutomationDialog';
import { CoOptimizationStrip, PartHead } from '../components/SteuerungParts';
import { EINRICHTUNG_DURCH_VOLTPILOT } from '../moduleSurface';
import { anlageRoute, hashForRoute, type AnlagenSub } from '../nav';
import { optimizerApi } from '../optimizerApi';
import {
  customerFlowApi,
  type FlowNodeGovernance,
  type FlowSummary,
} from '../flows/flowsApi';
import type { CustomerTemplateDef } from '../flows/customerTemplates';
import { catalogType, type EditorEntity, type FlowDocument } from '../flows/model';
import { flowMode, paletteFilterFor, type SteuerungMode } from '../flows/steuerung';
import {
  AUTOMATION_CAPSULE_EMPTY,
  AUTOMATION_CAPSULE_INTRO,
  AUTOMATION_CAPSULE_TITLE,
  NEUE_AUTOMATION_LABEL,
  PROFILE_CAPSULE_EMPTY,
  PROFILE_CAPSULE_INTRO,
  PROFILE_CAPSULE_TITLE,
  PROFILE_MANAGE_LABEL,
  PROTECTION_INTRO,
  automationRows,
  coOptimization,
  profileRows,
  protectionItems,
  socReservationStack,
  type ProfileRow,
  type ReservationInput,
} from '../steuerungArea';
import { type ProfileState, type SiteProfiles } from '../profiles';
import { activeModes, type ActiveMode, type SurfaceFlow, type SurfaceSignals } from '../surface';
import { FlowEditorPage } from './admin/FlowEditorPage';
import '../components/Profile.css';

const EMPTY_DOC: FlowDocument = {
  schema_version: '1.0', name: '', runtime: 'edge', nodes: [], edges: [], triggers: [],
};

interface Editing {
  flowId: string;
  version: number;
  /** Welcher Palettenausschnitt geöffnet wird (U3-Regel: Strategie-Knoten gewinnt). */
  palette: SteuerungMode;
}

export function SteuerungSection({
  site,
  isAdmin = false,
  onOpenSub,
}: {
  site: Site;
  isAdmin?: boolean;
  onOpenSub?: (sub: AnlagenSub) => void;
}) {
  const flowApi = useMemo(() => customerFlowApi(site.id), [site.id]);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);
  const [signals, setSignals] = useState<SurfaceSignals | null>(null);
  const [earnings, setEarnings] = useState<EarningsSite | null>(null);
  const [profiles, setProfiles] = useState<SiteProfiles | null>(null);
  const [reservation, setReservation] = useState<ReservationInput | null>(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The notice strip lives at the TOP of the area while the actions that can
  // fail sit far below it - a message set there read as "nothing happened"
  // (G6). Every setError goes through `fail`, which also brings the strip
  // into view, so a refusal is never silent.
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const fail = useCallback((message: string) => {
    setError(message);
    // The strip renders in the same commit; scroll after paint.
    requestAnimationFrame(() => {
      noticeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, []);

  /**
   * The honest message for a failed flow action. A 403 means the account is
   * not unlocked for this - VoltPilot sets it up - NOT that the server is
   * unreachable. The gate is unchanged; only the copy tells the truth.
   */
  const flowFailure = useCallback((e: unknown, fallback: string): string => {
    if (e instanceof ApiError && e.status === 403) {
      return `Der volle Editor ist für Ihr Konto nicht freigeschaltet. ${EINRICHTUNG_DURCH_VOLTPILOT}`;
    }
    return e instanceof ApiError ? e.message : fallback;
  }, []);

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
      api.siteProfiles(site.id).catch(() => null),
      optimizerApi.configViaSwitcher(site.id).catch(() => null),
    ])
      .then(([list, entityList, gov, profile, money, shelf, config]) => {
        setFlows(list);
        setEntities(entityList);
        setGovernance(gov);
        setSignals(profile?.signals ?? null);
        setEarnings(money?.sites.find((s) => s.id === site.id) ?? null);
        setProfiles(shelf);
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

  const enabledGatedTypes = useMemo(
    () => (governance?.gatedNodes ?? []).filter((n) => n.enabled).map((n) => n.type),
    [governance],
  );

  /**
   * Bedingungs-Arten des Baukastens, deren Katalog-Knoten GATED und für diese
   * Anlage nicht freigeschaltet ist (AE7-Governance). Der Server verweigert die
   * Aktivierung sonst mit `gated_node_not_enabled`, also wird die Art sichtbar
   * gesperrt statt eine Regel bauen zu lassen, die nie live gehen kann.
   */
  const lockedCondKinds = useMemo<('price')[]>(
    () => (catalogType('vp.price.current')?.gated
      && !enabledGatedTypes.includes('vp.price.current') ? ['price'] : []),
    [enabledGatedTypes],
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
  const rows = useMemo(
    () => profileRows(profiles?.profiles, modes, earnings),
    [profiles, modes, earnings],
  );
  const protections = useMemo(() => protectionItems(site), [site]);
  const automations = useMemo(
    () => automationRows(
      (flows ?? []).filter((f) => flowMode(f.latestDocument ?? EMPTY_DOC) === 'automation'),
    ),
    [flows],
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
        setCreating(false);
      } catch (e) {
        fail(flowFailure(e, 'Der Flow konnte nicht angelegt werden.'));
      } finally {
        setBusy(false);
      }
    },
    [flowApi, fail, flowFailure],
  );

  const useTemplate = useCallback(
    (def: CustomerTemplateDef) => {
      const res = def.resolve(entities, site.id);
      if ('reason' in res) {
        setCreating(false);
        fail(res.reason);
        return;
      }
      void openSaved(def.name, res.doc, 'automation');
    },
    [entities, site.id, openSaved, fail],
  );

  /** Der Profil-Schalter schreibt NUR den Willen; der Server schaltet frei. */
  const toggleProfile = useCallback(
    async (id: string, next: ProfileState) => {
      setToggling(id);
      setError('');
      try {
        setProfiles(await api.setSiteProfile(site.id, id, next));
        reload();
      } catch (e) {
        fail(
          e instanceof ApiError && e.message
            ? e.message
            : 'Das Profil konnte nicht umgeschaltet werden. Bitte später erneut versuchen.',
        );
      } finally {
        setToggling(null);
      }
    },
    [site.id, reload, fail],
  );

  const openProfileShelf = useCallback(() => {
    if (onOpenSub) onOpenSub('profile');
    else window.location.hash = hashForRoute(anlageRoute(site.id, 'profile'));
  }, [onOpenSub, site.id]);

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

  return (
    <div className="vp-steuerung vp-steuerung-area">
      <div ref={noticeRef}>
        {error && (
          <p className="vp-flowed-notice error" role="alert">
            {error}
          </p>
        )}
      </div>

      {listState === 'loading' && <TextSkeleton lines={5} />}
      {listState === 'error' && (
        <ErrorState message="Die Steuerung konnte nicht geladen werden." onRetry={reload} />
      )}

      {listState === 'idle' && flows && (
        <>
          {/* --- Kapsel 1 · Modus-Profile --------------------------------- */}
          <section className="vp-capsule" aria-label={PROFILE_CAPSULE_TITLE}>
            <PartHead title={PROFILE_CAPSULE_TITLE} intro={PROFILE_CAPSULE_INTRO}>
              <button type="button" className="vp-capsule-link" onClick={openProfileShelf}>
                {PROFILE_MANAGE_LABEL} <Icon name="chevron-right" size={14} />
              </button>
            </PartHead>
            <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
              {rows.length === 0 ? (
                <p className="vp-capsule-empty">{PROFILE_CAPSULE_EMPTY}</p>
              ) : (
                <ul className="vp-profrows">
                  {rows.map((row) => (
                    <ProfileRowView
                      key={row.id}
                      row={row}
                      busy={toggling === row.id}
                      onToggle={toggleProfile}
                    />
                  ))}
                </ul>
              )}
              {co && (
                <div className="vp-capsule-foot">
                  <CoOptimizationStrip co={co} layers={layers} />
                </div>
              )}
            </Card>
          </section>

          {/* --- Kapsel 2 · Automationen ---------------------------------- */}
          <section className="vp-capsule" aria-label={AUTOMATION_CAPSULE_TITLE}>
            <PartHead title={AUTOMATION_CAPSULE_TITLE} intro={AUTOMATION_CAPSULE_INTRO}>
              <span className="vp-capsule-action">
                <Button size="sm" disabled={busy} onClick={() => setCreating(true)}>
                  {NEUE_AUTOMATION_LABEL}
                </Button>
              </span>
            </PartHead>
            <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
              {automations.length === 0 ? (
                <EmptyState
                  icon="zap"
                  title="Noch keine Automation"
                  description={AUTOMATION_CAPSULE_EMPTY}
                />
              ) : (
                <ul className="vp-autorows">
                  {automations.map((row) => (
                    <li key={row.flowId} className="vp-autorow">
                      <span className={`vp-rowdot ${row.tone}`} aria-hidden="true" />
                      <div className="vp-autorow-text">
                        <strong>{row.name}</strong>
                        <p>{row.state}</p>
                      </div>
                      <Badge variant={row.active ? 'ok' : 'off'}>v{row.version}</Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          const flow = (flows ?? []).find((f) => f.flowId === row.flowId);
                          if (flow) openFlow(flow.flowId, flow.latestVersion, flow.latestDocument);
                        }}
                      >
                        Öffnen
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          {/* --- Die schmale Schutz-Zeile --------------------------------- */}
          <p className="vp-protline">
            <Icon name="shield" size={14} />
            <span className="vp-protline-intro">{PROTECTION_INTRO}</span>
            {protections.map((p) => (
              <span key={p.key} className="vp-protline-item">
                {p.label} <InfoTip title={p.label}>{p.tip}</InfoTip>
              </span>
            ))}
          </p>

          <NeueAutomationDialog
            open={creating}
            onClose={() => setCreating(false)}
            entities={entities}
            siteId={site.id}
            busy={busy}
            lockedKinds={lockedCondKinds}
            lockedHint={EINRICHTUNG_DURCH_VOLTPILOT}
            onUseTemplate={useTemplate}
            onBuilt={(name, doc) => void openSaved(name, doc, 'automation')}
            onOpenEditor={() => void openSaved('Neue Automation', null, 'automation')}
          />
        </>
      )}
    </div>
  );
}

/** Eine kompakte Profil-Zeile: Statuspunkt · Beitrag · Schalter. */
function ProfileRowView({
  row,
  busy,
  onToggle,
}: {
  row: ProfileRow;
  busy: boolean;
  onToggle: (id: string, next: ProfileState) => void;
}) {
  return (
    <li className={`vp-profrow${row.on ? ' on' : ''}`}>
      <span className={`vp-rowdot ${row.tone}`} aria-hidden="true" />
      <div className="vp-profrow-text">
        <strong>{row.label}</strong>
        <p className="vp-profrow-contrib">{row.contribution}</p>
        {row.blockedReason && <p className="vp-profrow-blocked">{row.blockedReason}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={row.on}
        aria-label={`${row.label} ${row.on ? 'ausschalten' : 'einschalten'}`}
        className={`vp-switch${row.on ? ' on' : ''}`}
        disabled={busy}
        onClick={() => onToggle(row.id, row.on ? 'aus' : 'an')}
      >
        <span className="vp-switch-knob" aria-hidden="true" />
      </button>
    </li>
  );
}
