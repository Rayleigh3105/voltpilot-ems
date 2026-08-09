/**
 * Anlage → **Steuerung** (Portal v3 · M4, spec `docs/portal-v3/M4-steuerung.md`).
 *
 * Die Fläche beantwortet EINE Frage — „Was darf VoltPilot, und was habe ich
 * selbst geregelt?" — mit genau ZWEI Kapseln und einer schmalen Schutz-Zeile:
 *
 *  1. **Modus-Profile** — kompakte, ANTIPPBARE Zeilen (Statuspunkt · ein Satz
 *     mit echten Zahlen · Chevron · Schalter); ein Tipp auf die Zeile öffnet den
 *     Modus-Container (v3.1-M2, `ModusContainer`), darunter als Fußzeile der
 *     Ko-Optimierungs-Streifen mit dem SoC-Reservierungs-Stack.
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
import { ApiError, api, type EarningsSite, type Site, type SiteAsset } from '../api';
import { EmptyState, ErrorState, TextSkeleton } from '../components/States';
import { InfoTip } from '../components/InfoTip';
import { NeueAutomationDialog } from '../components/NeueAutomationDialog';
import { CoOptimizationStrip, PartHead } from '../components/SteuerungParts';
import { ModusContainer } from '../components/ModusContainer';
import { EINRICHTUNG_DURCH_VOLTPILOT } from '../moduleSurface';
import { anlageRoute, hashForRoute, pageRoute, type AnlagenSub } from '../nav';
import type { NavTarget } from '../anlageNav';
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
  AUS_VERBRAUCHERREGEL,
  AUTOMATION_CAPSULE_EMPTY,
  AUTOMATION_CAPSULE_INTRO,
  AUTOMATION_CAPSULE_TITLE,
  NEUE_AUTOMATION_LABEL,
  PROFILE_CAPSULE_EMPTY,
  PROFILE_CAPSULE_INTRO,
  PROFILE_CAPSULE_TITLE,
  PROTECTION_INTRO,
  automationRows,
  coOptimization,
  profileRows,
  protectionItems,
  socReservationStack,
  type ProfileRow,
  type ReservationInput,
} from '../steuerungArea';
import {
  isConsumerRuleTemplate,
  verbraucherRegelHash,
  verbraucherVorlageHash,
} from '../consumers/vorlagen';
import { type ProfileState, type SiteProfiles } from '../profiles';
import {
  activeModes,
  baseSurface,
  type ActiveMode,
  type SurfaceFlow,
  type SurfaceSignals,
} from '../surface';
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
  /**
   * Audit E-1: eine frisch GEBAUTE Regel (Baukasten/Vorlage) landet auf dem
   * Prüf-Schritt in Klartext, nicht auf der Leinwand. Eine bestehende Regel
   * öffnet weiterhin direkt im Editor.
   */
  view?: 'review' | 'editor';
}

export function SteuerungSection({
  site,
  isAdmin = false,
  onOpenSub,
  onSiteSaved,
}: {
  site: Site;
  isAdmin?: boolean;
  onOpenSub?: (sub: AnlagenSub) => void;
  /**
   * Eine Site-Einstellung wurde IM Modus-Container gespeichert (v3.1-M3) — die
   * Anlagen-Seite lädt daraufhin neu, damit alle Flächen den neuen Wert zeigen.
   */
  onSiteSaved?: (updated: Site) => void;
}) {
  const flowApi = useMemo(() => customerFlowApi(site.id), [site.id]);
  // Lokaler Site-Zustand, damit ein Container-Save (Netzladen/Tarif/…) sofort in
  // der Ableitung (`activeModes` — Netzladen ∧ dyn. Tarif IST ein Markt-Signal!)
  // und in den Lese-Zeilen sichtbar wird; die Prop bleibt die Quelle der Wahrheit
  // und synchronisiert bei einem Anlagenwechsel/Seiten-Reload zurück.
  const [siteState, setSiteState] = useState<Site>(site);
  useEffect(() => setSiteState(site), [site]);
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [entities, setEntities] = useState<EditorEntity[]>([]);
  const [governance, setGovernance] = useState<FlowNodeGovernance | null>(null);
  const [signals, setSignals] = useState<SurfaceSignals | null>(null);
  const [earnings, setEarnings] = useState<EarningsSite | null>(null);
  const [profiles, setProfiles] = useState<SiteProfiles | null>(null);
  const [assets, setAssets] = useState<SiteAsset[] | null>(null);
  const [reservation, setReservation] = useState<ReservationInput | null>(null);
  const [listState, setListState] = useState<'idle' | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState<Editing | null>(null);
  /**
   * v3.1-M2: der offene Modus-Container (die Profil-Id) — ein interner
   * Sub-View-State wie `editing` (der Flow-Editor-Präzedenzfall), kein neuer
   * `Route`-Parameter. Der Bookmark `#/anlage/{id}/profile` redirectet auf
   * `steuerung` (`nav.ts` LEGACY_SUBS), landet also auf den zwei Kapseln.
   */
  const [openContainer, setOpenContainer] = useState<string | null>(null);
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
      // Der Speicher-Asset speist die Speicherschonungs-Einstellung im Container
      // (v3.1-M3); fail-soft wie der Rest.
      api.siteAssets(site.id).catch(() => null),
    ])
      .then(([list, entityList, gov, profile, money, shelf, config, siteAssets]) => {
        setFlows(list);
        setEntities(entityList);
        setGovernance(gov);
        setSignals(profile?.signals ?? null);
        setEarnings(money?.sites.find((s) => s.id === site.id) ?? null);
        setProfiles(shelf);
        setAssets(siteAssets);
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

  /** Die EINE Projektions-Eingabe dieser Fläche (M0) - nichts wird hier neu abgeleitet. */
  const surfaceInput = useMemo(
    () => ({
      signals,
      config: {
        plantKind: siteState.plantKind,
        tarifArt: siteState.tarifArt,
        netzladenErlaubt: siteState.netzladenErlaubt,
        leistungspreisEurKw: siteState.leistungspreisEurKw ?? null,
      },
      flows: (flows as SurfaceFlow[] | null) ?? null,
      entities: null,
    }),
    [signals, siteState, flows],
  );

  /** Die MENGE der aktiven Modi (M0). */
  const modes = useMemo<ActiveMode[]>(() => activeModes(surfaceInput), [surfaceInput]);

  /**
   * Die BASIS-Ansichten (Fahrplan bei Speicher, Marktpreise bei Börsentarif).
   * Der Modus-Container zieht sie von „Ansichten dieses Modus" ab, damit er
   * nichts als Freischaltung ausweist, was ohnehin in der Navigation steht.
   */
  const baseViews = useMemo(() => baseSurface(surfaceInput).deepViews, [surfaceInput]);

  const co = useMemo(() => coOptimization(modes), [modes]);
  const layers = useMemo(() => socReservationStack(reservation), [reservation]);
  const rows = useMemo(
    () => profileRows(profiles?.profiles, modes, earnings),
    [profiles, modes, earnings],
  );
  const protections = useMemo(() => protectionItems(siteState), [siteState]);
  const battery = useMemo(
    () => (assets ?? []).find((a) => a.type === 'battery') ?? null,
    [assets],
  );

  /** Ein Container-Save einer Site-Einstellung: lokal spiegeln + Seite nachladen. */
  const handleSiteSaved = useCallback(
    (updated: Site) => {
      setSiteState(updated);
      onSiteSaved?.(updated);
      reload();
    },
    [onSiteSaved, reload],
  );

  /** Ein Container-Save der Speicherschonung: die neuen Assets übernehmen. */
  const handleBatterySaved = useCallback((updatedAssets: SiteAsset[]) => {
    setAssets(updatedAssets);
  }, []);
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
          // E-1: ein fertig gebautes Dokument (Baukasten/Vorlage) geht auf den
          // Prüf-Schritt; die leere Fläche öffnet direkt im Editor.
          setEditing({
            flowId: saved.flowId, version: saved.flowVersion, palette, view: 'review',
          });
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
      // D7 (Inkrement 4): a CONSUMER template is a Verbraucherregel - it opens
      // the guided Regelbaukasten prefilled instead of emitting a raw flow
      // (cycle guard, grid policy and enforcement live there).
      if (isConsumerRuleTemplate(def.id)) {
        setCreating(false);
        window.location.hash = verbraucherVorlageHash(site.id, def.id);
        return;
      }
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

  /** Eine Ansicht dieses Modus öffnen (Container → Sidebar-Ziel). */
  const navigateView = useCallback(
    (target: NavTarget) => {
      if (target.kind === 'sub') {
        if (target.sub == null) return;
        if (onOpenSub) onOpenSub(target.sub);
        else window.location.hash = hashForRoute(anlageRoute(site.id, target.sub));
      } else if (target.kind === 'page') {
        window.location.hash = hashForRoute(pageRoute(target.page));
      }
    },
    [onOpenSub, site.id],
  );

  /** „Flow öffnen" aus dem Container: den echten Flow des Modus öffnen. */
  const openContainerFlow = useCallback(
    (flowRef: { flowId: string; name: string }) => {
      const flow = (flows ?? []).find((f) => f.flowId === flowRef.flowId);
      if (flow) openFlow(flow.flowId, flow.latestVersion, flow.latestDocument);
    },
    [flows, openFlow],
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
        initialView={editing.view ?? 'editor'}
        backLabel="Zur Steuerung"
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  // v3.1-M2: ist ein Modus-Container geöffnet, ersetzt er die zwei Kapseln.
  // `profiles` bleibt über einen Reload erhalten, der Container flackert also
  // beim Umschalten nicht weg.
  const openProfile =
    openContainer != null
      ? profiles?.profiles.find((p) => p.id === openContainer) ?? null
      : null;
  if (openProfile) {
    const mode = modes.find((m) => String(m.kind) === openProfile.id) ?? null;
    return (
      <div className="vp-steuerung vp-steuerung-area">
        <div ref={noticeRef}>
          {error && (
            <p className="vp-flowed-notice error" role="alert">
              {error}
            </p>
          )}
        </div>
        <ModusContainer
          profile={openProfile}
          mode={mode}
          activeModes={modes}
          baseViews={baseViews}
          site={siteState}
          battery={battery}
          earnings={earnings}
          busy={toggling === openProfile.id}
          onToggle={toggleProfile}
          onBack={() => setOpenContainer(null)}
          onNavigate={navigateView}
          onOpenFlow={openContainerFlow}
          onSiteSaved={handleSiteSaved}
          onBatterySaved={handleBatterySaved}
        />
      </div>
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
            <PartHead title={PROFILE_CAPSULE_TITLE} intro={PROFILE_CAPSULE_INTRO} />
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
                      onOpen={setOpenContainer}
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
                      {/* D7: eine generierte Verbraucherregel wird HIER nur
                          beobachtet - bearbeitet wird sie im Regelbaukasten
                          ihres Verbrauchers, nie im Flow-Editor. */}
                      {row.fromConsumerRule && (
                        <Badge variant="off">{AUS_VERBRAUCHERREGEL}</Badge>
                      )}
                      <Badge variant={row.active ? 'ok' : 'off'}>v{row.version}</Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (row.fromConsumerRule) {
                            window.location.hash = verbraucherRegelHash(
                              site.id, row.fromConsumerRule.entityId,
                            );
                            return;
                          }
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

/**
 * Eine kompakte, ANTIPPBARE Profil-Zeile: Statuspunkt · Beitrag · Chevron
 * (öffnet den Modus-Container) und rechts der Schalter. Der Schalter ist ein
 * eigener Knopf NEBEN der Öffnen-Fläche (kein verschachteltes `<button>`) und
 * stoppt die Propagation, damit ein Umschalten nie in den Container navigiert.
 */
function ProfileRowView({
  row,
  busy,
  onToggle,
  onOpen,
}: {
  row: ProfileRow;
  busy: boolean;
  onToggle: (id: string, next: ProfileState) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <li className={`vp-profrow${row.on ? ' on' : ''}`}>
      <span className={`vp-rowdot ${row.tone}`} aria-hidden="true" />
      <button
        type="button"
        className="vp-profrow-open"
        aria-label={`${row.label} öffnen`}
        onClick={() => onOpen(row.id)}
      >
        <span className="vp-profrow-text">
          <strong>{row.label}</strong>
          <span className="vp-profrow-contrib">{row.contribution}</span>
          {row.blockedReason && <span className="vp-profrow-blocked">{row.blockedReason}</span>}
        </span>
        <Icon name="chevron-right" size={16} />
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={row.on}
        aria-label={`${row.label} ${row.on ? 'ausschalten' : 'einschalten'}`}
        className={`vp-switch${row.on ? ' on' : ''}`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(row.id, row.on ? 'aus' : 'an');
        }}
      >
        <span className="vp-switch-knob" aria-hidden="true" />
      </button>
    </li>
  );
}
