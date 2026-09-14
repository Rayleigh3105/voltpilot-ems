import { Fragment, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SUB_CHUNK } from '../pageChunks';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import {
  api,
  type ControlStatus,
  type CurtailmentStatus,
  type SiteCharging,
  type Device,
  type EarningsRange,
  type History,
  type HistoryTotals,
  type Overview,
  type RollenKanonischerWert,
  type SchedulePlan,
  type Site,
  type SiteEarnings,
  type SiteSource,
  type TelemetryPoint,
} from '../api';
import { BATTERY_NO_DEVICE_WARNING, composeSiteSentence, siteLiveFresh, siteSnapshot } from '../fleet';
import { plantKindLabel } from '../format';
import { DEFAULT_EARNINGS_RANGE } from '../anlage';
import {
  anlageRoute,
  geraetSeiteHash,
  hashForRoute,
  parseBefehleGeraet,
  parseBefehleKomponente,
  type AnlagenSub,
  type GeraetTarget,
  type Route,
} from '../nav';
import { useStaffel, mitStaffel } from '../staffel';
import { boxRefOf, chargerGeraetId } from '../geraetSeite';
import { useFreshnessPoll } from '../useFreshnessPoll';
// LIVE für alles Gemessene (Cockpit, Steuerung, Viertelstunden-Band), LIST für
// die Zeitraum-Aggregate der Historie.
import { LIST_POLL_MS, LIVE_POLL_MS } from '../pollCadence';
import { useIsPhone } from '../useIsPhone';
import { useScrolledPast } from '../useScrolledPast';
import { useWake } from '../useWake';
import { nextHourIndex, weatherWhy } from '../weather';
import { controlReasonSlot, controlStrip, nextChargeStart, planOutlook } from '../control';
import { curtailTruth, curtailTruthForSlot, exportGuardView } from '../curtailment';
import { flowConflict, flowConflictCandidate, stepFlowConflict } from '../flowConflict';
import { todaySlots } from '../schedule';
import { slotWhy, surplusWhy } from '../fahrplanWhy';
import { healthChecklist, type AnlageHealthFacts } from '../health';
import { AnlageAnlegenDrawerLazy as AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawerLazy';
import { resolveAnlage } from '../anlageNav';
import { fetchGate, readFace, rememberFace } from '../anlageFace';
import { consumersApi } from '../consumers/consumersApi';
import { consumerStrip, type ConsumerStripView } from '../consumers/fulfillment';
import { ladeFlussKnoten, ladenKachel } from '../ladenKachel';
import { LadenKachel } from '../components/LadenKachel';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import { ControlStrip } from '../components/ControlStrip';
import { useAdaptiveLive } from '../useAdaptiveLive';
import { liveState, type LiveState } from '../adaptiveLive';
import { flowHasValues, headSentenceVisible, liveChip } from '../liveDetail';
import { leadBlock } from '../leadSlot';
import { useCockpitLayout } from '../useCockpitLayout';
import { ortsHinweis, type BausteinId } from '../cockpitLayout';
import {
  LEER_SATZ as EIGEN_LEER_SATZ,
  deckelSatz as eigenDeckelSatz,
  einheit as eigenEinheit,
  istEigen,
  werteNachId,
  type EigeneAuswertungDef,
  type EigeneAuswertungWerte,
} from '../eigeneAuswertung';
import { EigenerBaustein } from '../components/EigeneAuswertung';
import { EigeneAuswertungDialog } from '../components/EigeneAuswertungDialog';
import {
  AnpassenHuelle,
  AnpassenLeiste,
  AnpassenListe,
  AusgeblendetZeile,
} from '../components/CockpitAnpassen';
import { useAnlageSurface } from '../useAnlageSurface';
import type { AnlageSurface } from '../surface';
import { anlageDecision, hasBlock } from '../cockpit';
import {
  cockpitHero,
  cockpitWidgets,
  historyRangeForCockpit,
  mobileWidgets,
  stickyHead,
  type CockpitWidgetsInput,
  type WidgetDef,
} from '../cockpitWidgets';
import { CockpitHero } from '../components/CockpitHero';
import {
  MobileMoneyCard,
  MobileStickyHead,
} from '../components/CockpitBlocks';
import { KomponentenSection } from '../components/KomponentenSection';
import { ZustandCard } from '../components/ZustandCard';
import { StrompreisStrip } from '../components/StrompreisStrip';
import { gateStrompreis } from '../strompreis';
import { WidgetGrid } from '../components/WidgetGrid';
import { AnlageSetup } from '../components/AnlageSetup';
import { SETUP_STATUS_LINE, setupPathActive } from '../setupPath';
import { peakBand, quarterHourMeanImportKw } from '../peakBand';
import { FahrplanBand } from '../components/FahrplanBand';
import { FleetSiteCard } from '../components/FleetOverview';
import { PeriodTabs } from '../components/MoneyView';
import { NetzladenBadge } from '../components/NetzladenBadge';
import { ErrorState, Skeleton } from '../components/States';
import { LazyBoundary } from '../components/Lazy';
import { BereichTabs } from '../components/BereichTabs';
import { anlageSidebar, bereichLabel, tabsFor } from '../anlageNav';
// Die Unterseiten einer Anlage werden LAZY geladen. Das Cockpit (`sub === null`)
// zeichnet keine von ihnen, zog aber über den statischen Import ihre gesamte
// Fracht ins Einstiegs-Bündel: ECharts (jede Diagramm-Fläche), Leaflet (die
// Karte auf „Einstellungen"), den Automations-Editor. Gemessen war das der
// grösste Einzelposten der Ladezeit - siehe `components/Lazy.tsx`.
const FahrplanSection = lazy(() =>
  SUB_CHUNK.daten().then((m) => ({ default: m.FahrplanSection })),
);
const WetterSection = lazy(() =>
  SUB_CHUNK.daten().then((m) => ({ default: m.WetterSection })),
);
const MesswerteSection = lazy(() =>
  SUB_CHUNK.messwerte().then((m) => ({ default: m.MesswerteSection })),
);
const ErloeseSection = lazy(() =>
  SUB_CHUNK.erloese().then((m) => ({ default: m.ErloeseSection })),
);
const AnlagenModellSection = lazy(() =>
  SUB_CHUNK.modell().then((m) => ({ default: m.AnlagenModellSection })),
);
const GeraetSeiteSection = lazy(() =>
  SUB_CHUNK.geraet().then((m) => ({ default: m.GeraetSeiteSection })),
);
const BoxSeiteSection = lazy(() =>
  SUB_CHUNK.box().then((m) => ({ default: m.BoxSeiteSection })),
);
const LadevorgaengeSection = lazy(() =>
  SUB_CHUNK.ladevorgaenge().then((m) => ({ default: m.LadevorgaengeSection })),
);
const LastspitzenSection = lazy(() =>
  SUB_CHUNK.lastspitzen().then((m) => ({ default: m.LastspitzenSection })),
);
const SteuerungSection = lazy(() =>
  SUB_CHUNK.steuerung().then((m) => ({ default: m.SteuerungSection })),
);
const TechnikSection = lazy(() =>
  SUB_CHUNK.technik().then((m) => ({ default: m.TechnikSection })),
);
const BefehleSection = lazy(() =>
  SUB_CHUNK.befehle().then((m) => ({ default: m.BefehleSection })),
);
// Marktpreise und Prognose sind seit der Navigations-Runde „zwei Ebenen" (E3)
// REITER des Verlaufs, also gewöhnliche Unterseiten dieser Anlage - ihre alten
// Adressen leiten um (`nav.ts` LEGACY_ROUTES).
const MarktpreisePage = lazy(() =>
  SUB_CHUNK.daten().then((m) => ({ default: m.MarktpreisePage })),
);
const PrognosePage = lazy(() =>
  SUB_CHUNK.prognose().then((m) => ({ default: m.PrognosePage })),
);

/** Re-render cadence of the "Stand vor X" freshness note. */
const TICK_MS = 5_000;
/**
 * Die knappe, begründete Frist, bevor eine hängende Entscheidungs-Eingabe
 * (Netz hängt, Backend antwortet nie) als Fehlschlag behandelt wird - "kein
 * Dauer-Spinner" (Captain-Nachtrag 06.08.2026). Am `BOOT_TIMEOUT_MS`-Präzedenz
 * orientiert (`src/boot.ts`).
 */
const ANLAGE_DECISION_TIMEOUT_MS = 10_000;

export interface AnlagenPageProps {
  sites: Site[];
  devices: Device[];
  /**
   * Bezugszeit der Geräteliste (Epoch-ms der Server-Antwort). Lebendigkeit wird
   * dagegen gemessen, nie gegen eine Uhr, die über einen nicht erneuerten
   * Schnappschuss hinausläuft - siehe `src/liveness.ts`.
   */
  devicesFetchedAt?: number | null;
  route: Route;
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /**
   * Reports the health facts only this page measures (plan / control / battery
   * link) up to the shell, so the top-bar badge and the plant's own Zustand
   * card are ONE truth. Absent facts stay absent — `healthBadge` drops every
   * row it was not given, so the badge never claims health it did not measure.
   */
  onHealthFacts?: (siteId: string, facts: AnlageHealthFacts) => void;
  /**
   * Das M0-Lese-Modell der Anlage, wie es die Schale ohnehin schon geladen hat
   * (`App.tsx` `useAnlageSurface`) - durchgereicht, damit die Historie-Welten
   * KEINEN eigenen Abruf brauchen, um zu wissen, ob es die Erlöse-Welt gibt.
   */
  surface?: AnlageSurface | null;
}

/**
 * "Meine Anlage(n)": ONE site = ONE Anlage (captain decision 2026-07-07).
 * Single-Anlage customers land straight on their Anlagen-Seite; fleets get
 * the Anlagen list and drill in per card. `#/anlage/{siteId}` addresses one
 * Anlage, `#/anlage/{siteId}/{sub}` its deep views (the former Live-Daten/
 * Fahrplan/Historie/Wetter menu items). A legacy hash without a site id
 * (e.g. `#/fahrplan`) resolves to the single Anlage or falls back to the
 * list when the customer has several.
 */
export function AnlagenPage(props: AnlagenPageProps) {
  const { sites, route, onNavigate, isAdmin = false } = props;

  if (sites.length === 0) {
    return <AnlagenEmpty onReload={props.onReload} isAdmin={isAdmin} />;
  }

  // The SAME resolution the shell uses to scope its trio (anlageNav.ts).
  const site = resolveAnlage(sites, route.siteId);

  if (!site) {
    return (
      <AnlagenListe
        sites={sites}
        onOpen={(id) => onNavigate(anlageRoute(id))}
        onReload={props.onReload}
      />
    );
  }

  // Portal v3 M1: every area of an Anlage lives in the SHELL now - the grouped
  // sidebar (base group + one group per active mode) plus the phone 5-slot
  // bottom bar with its Mehr sheet (`anlageNav.ts`). The page head carries no
  // navigation of its own any more; the cockpit's drill-in links stay as
  // shortcuts. Routes are unchanged, so every bookmark keeps working.
  return route.sub ? (
    <AnlagenSubPage
      site={site}
      sites={sites}
      devices={props.devices}
      devicesFetchedAt={props.devicesFetchedAt ?? null}
      sub={route.sub}
      geraet={route.geraet ?? null}
      isAdmin={isAdmin}
      surface={props.surface ?? null}
      onBack={() => onNavigate(anlageRoute(site.id))}
      onOpenSub={(sub) => onNavigate(anlageRoute(site.id, sub))}
      onReload={props.onReload}
    />
  ) : (
    <AnlageSeite
      {...props}
      site={site}
      onOpenSub={(sub) => onNavigate(anlageRoute(site.id, sub))}
      onBackToList={
        sites.length > 1 ? () => onNavigate({ page: 'anlagen', siteId: null, sub: null }) : null
      }
    />
  );
}

/** Customer without any Anlage yet (admins: an empty tenant). */
function AnlagenEmpty({
  onReload,
  isAdmin,
}: {
  onReload: (selectSiteId?: string) => void;
  isAdmin: boolean;
}) {
  const [drawer, setDrawer] = useState(false);
  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Meine Anlage</h1>
          <p>
            {isAdmin
              ? 'Dieser Mandant hat noch keine Anlage.'
              : 'Hier erscheint Ihre Anlage: Live-Daten, Fahrplan, Technik und Erlöse an einem Ort.'}
          </p>
        </div>
      </div>
      <Card padding="lg" radius="lg">
        <div className="vp-empty">
          <IconTile category="solar" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
            <Icon name="sun" size={24} />
          </IconTile>
          <h3>{isAdmin ? 'Dieser Mandant hat noch keine Anlage' : 'Noch keine Anlage'}</h3>
          <p>
            {isAdmin
              ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheint sie hier. Sie können im Namen des Mandanten eine Anlage anlegen.'
              : 'Legen Sie Ihre Anlage an - danach verbinden Sie Ihr Gerät und sehen Live-Daten, Fahrplan und Erlöse.'}
          </p>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDrawer(true)}>
            Anlage anlegen
          </Button>
        </div>
      </Card>
      <AnlageAnlegenDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </>
  );
}

/** The fleet's Anlagen list: one card per Anlage, tap to open its Seite. */
function AnlagenListe({
  sites,
  onOpen,
  onReload,
}: {
  sites: Site[];
  onOpen: (siteId: string) => void;
  onReload: (selectSiteId?: string) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    let active = true;
    api.overview().then(
      (o) => {
        if (!active) return;
        setOverview(o);
        setFailed(false);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey, sites]);

  // Freshness tick + silent background poll (the fleet-mode pattern). Der
  // DATEN-Takt läuft über `useFreshnessPoll`, damit die Rückkehr in einen
  // verdeckten Tab sofort nachholt statt den Stand von vorhin zu zeigen.
  useFreshnessPoll(() => {
    setNow(new Date());
    api.overview().then(
      (o) => setOverview(o),
      () => {},
    );
  }, LIVE_POLL_MS);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Meine Anlagen</h1>
          <p>Wählen Sie eine Anlage - jede hat ihre eigene Seite.</p>
        </div>
        <div className="actions">
          <Button variant="outline" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDrawer(true)}>
            Anlage anlegen
          </Button>
        </div>
      </div>

      {overview == null && failed ? (
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Ihre Anlagen konnten gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
      ) : overview == null ? (
        <div className="vp-grid vp-fleet-grid">
          <Skeleton height={190} radius="var(--vp-radius-lg)" />
          <Skeleton height={190} radius="var(--vp-radius-lg)" />
          <Skeleton height={190} radius="var(--vp-radius-lg)" />
        </div>
      ) : (
        <div className="vp-grid vp-fleet-grid">
          {overview.sites.map((s) => (
            <FleetSiteCard
              key={s.id}
              site={s}
              earnings={null}
              now={now}
              onOpen={() => onOpen(s.id)}
            />
          ))}
        </div>
      )}

      <AnlageAnlegenDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        existingSites={sites}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </>
  );
}

/**
 * Titel + Untertitel je Unterseite. **Die zwei Historie-Welten stehen bewusst
 * NICHT darin**: sie tragen ihren eigenen Welt-Kopf (Icon · Titel · Abzeichen ·
 * Kartenpaar), und eine zweite generische Überschrift darüber wäre genau die
 * Kopfzone, die das Konzept abbaut.
 */
/**
 * Der SICHTBARE Seitenkopf einer Unterseite — Titel + Lead-Absatz ÜBER den
 * Bereichs-Reitern.
 *
 * ⚠ **Die sechs Reiter des Bereichs „Verlauf" stehen hier bewusst NICHT mehr**
 * (Paket P1, Konzept `vp-verlauf-sprache-konzept-v5` §3.2 V1, Befund B1). Vier
 * von ihnen (`marktpreise`, `lastspitzen`, `prognose`, `wetter`) trugen einen
 * Kopf, die anderen zwei (`messwerte`, `erloese`) nie — die Reiterleiste sprang
 * dadurch bei JEDEM Reiterwechsel: gemessen 140 px auf Messwerte/Erlöse gegen
 * 287/316 px auf den vier anderen. Ein Reiter, der seine eigene Leiste
 * verschiebt, ist keine Bühne; das ist der teuerste Bruch der App-Kriterien
 * A5/A8.
 *
 * Was der Kopf SAGTE, sagen die Reiter darüber schon. Für Dokumentstruktur und
 * Screenreader trägt jeder der vier eine unsichtbare `h1` (`VerlaufKopf`), sein
 * Lead-Satz lebt als Fuß-Aufklapper weiter (`VerlaufFuss`) — Nachschlage-Text,
 * kein Scrollweg-Inhalt.
 *
 * Die Bereiche AUSSERHALB des Verlaufs (Fahrplan, Einstellungen, Komponenten,
 * Steuerung) behalten ihren Kopf: sie sind nicht Teil dieses Pakets, und ein
 * halb umgestelltes Portal wäre ein zweiter Sprung statt keinem.
 */
const SUB_PAGES: Partial<Record<AnlagenSub, { title: string; subtitle: string }>> = {
  fahrplan: {
    title: 'Fahrplan',
    subtitle: 'Kostenoptimaler Batterie-Fahrplan aus Börsenpreisen und Prognosen.',
  },
  technik: {
    // D2 (Captain, 31.07.2026): die Seite heisst „Einstellungen". Der Untertitel
    // nennt seit E1 wieder das, was dort auch WIRKLICH steht - Stromtarif und
    // Vergütung sind zurueck (Konzept `vp-settings-ux-konzept` §3.4).
    title: 'Einstellungen',
    subtitle:
      'Stromtarif, Vergütung, Speicher, Wechselrichter und der Standort Ihrer Anlage - an einem Ort.',
  },
  modell: {
    // ⚠ Der Bereich heisst seit Steuerung Stufe 8 „Komponenten" (§3.9,
    // Captain 25.08.2026: „Komponenten & Regeln" → „Komponenten"). Die Regeln
    // wohnen in der Steuerung — EIN Ort je Sache. Die Route `modell` bleibt,
    // damit jedes Lesezeichen gilt.
    title: 'Komponenten',
    subtitle: 'So ist Ihre Anlage verschaltet: Geräte, Komponenten und was das Cockpit daraus macht.',
  },
  steuerung: {
    title: 'Steuerung',
    // EIN Satz, kein Technik-Vokabular: „Steuerungs-Flows" ist unser Wort fuer
    // die Regel-Dokumente, nicht das des Kunden - und vier Zeilen Untertitel
    // schoben am Telefon die Kapseln unter den Falz (Mobil-Umbau Stufe 4).
    subtitle: 'Was Ihre Anlage automatisch tut - und was es bringt.',
  },
};

/** One deep view of an Anlage, with the way back always in sight. */
function AnlagenSubPage({
  site,
  sites,
  devices,
  devicesFetchedAt,
  sub,
  geraet,
  isAdmin,
  surface,
  onBack,
  onOpenSub,
  onReload,
}: {
  site: Site;
  sites: Site[];
  devices: Device[];
  devicesFetchedAt: number | null;
  sub: AnlagenSub;
  /** Nur bei `sub === 'geraet'`: WELCHES Gerät die Adresse nennt. */
  geraet: GeraetTarget | null;
  isAdmin: boolean;
  surface: AnlageSurface | null;
  onBack: () => void;
  onOpenSub: (sub: AnlagenSub) => void;
  onReload: (selectSiteId?: string) => void;
}) {
  const meta = SUB_PAGES[sub];
  // Die REITER dieses Bereichs - aus DEMSELBEN Modell wie die Seitenleiste
  // (`anlageSidebar`), damit Leiste und Reiter nie Verschiedenes behaupten.
  // Ein Bereich, der EINE Seite ist (Cockpit, Steuerung), liefert keine.
  const sidebar = anlageSidebar(surface);
  const tabs = tabsFor(sidebar, sub);

  /**
   * **Der Welt-Wechsel wohnt seit E3 in DIESEN Reitern** (Konzept
   * `vp-erloese-lesbar-konzept-u3` §3.5): die frühere Wechsel-Karte im
   * Welt-Kopf ist entfallen, weil sie denselben Schalter ein zweites Mal war.
   *
   * ⚠ Sie brachte aber etwas mit, das eine nackte Route nicht kennt: den
   * ZEITRAUM. Ihr `href` war `historieHash(...)` — mit `z=`, `at=` und seit F8
   * `v=`. Ein Wechsel über den Reiter reicht diese Parameter deshalb weiter,
   * sonst springt „Erlöse" beim Wechsel aus dem Juni 2026 zurück auf heute.
   * Nur ZWISCHEN den beiden Historie-Welten — jeder andere Reiter ist eine
   * andere Frage und startet mit seiner eigenen Vorgabe.
   */
  const oeffneReiter = (ziel: AnlagenSub) => {
    const welten: AnlagenSub[] = ['messwerte', 'erloese'];
    if (ziel !== sub && welten.includes(ziel) && welten.includes(sub)) {
      const query = window.location.hash.split('?')[1];
      if (query) {
        window.location.hash = `#/anlage/${site.id}/${ziel}?${query}`;
        return;
      }
    }
    onOpenSub(ziel);
  };
  // ⚠ Eine Unterseite EINE Ebene tiefer trägt ihren Rückweg selbst - als
  // Brotkrume `Anlage › Komponenten › {Gerät}` in ihrem eigenen Kopf. Der Knopf
  // hier stünde darüber als ZWEITER Rückweg auf denselben Weg (Stufe 0, §2.1,
  // Captain-Entscheid D1a); `tabsFor` schweigt aus demselben Grund.
  const eigenerRueckweg = sub === 'geraet' || sub === 'box';
  return (
    <>
      {!eigenerRueckweg && (
        <button type="button" className="vp-fleet-back" onClick={onBack}>
          <Icon name="chevron-left" size={18} />
          Anlage {site.name}
        </button>
      )}
      {meta && (
        <div className="vp-page-head">
          <div className="titles">
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
        </div>
      )}
      <BereichTabs
        tabs={tabs}
        active={sub}
        label={`Reiter des Bereichs ${bereichLabel(sidebar, sub)}`}
        onOpen={oeffneReiter}
      />
      <LazyBoundary>
        {sub === 'fahrplan' && <FahrplanSection site={site} />}
        {sub === 'messwerte' && (
          <MesswerteSection
            site={site}
            surface={surface}
            onOpenWelt={(welt) => onOpenSub(welt)}
          />
        )}
        {sub === 'erloese' && (
          <ErloeseSection site={site} surface={surface} onOpenWelt={(welt) => onOpenSub(welt)} />
        )}
        {sub === 'wetter' && <WetterSection site={site} />}
        {/* Als Reiter des Verlaufs: die Anlage steht im Pfad, den Titel trägt
            der Seitenkopf oben - `embedded` unterdrückt darum Überschrift und
            Anlagen-Wähler der ehemals eigenständigen Seiten. */}
        {sub === 'marktpreise' && (
          <MarktpreisePage
            sites={[site]}
            selectedSite={site.id}
            onSelectSite={() => {}}
            embedded
          />
        )}
        {sub === 'prognose' && (
          <PrognosePage sites={[site]} selectedSite={site.id} onSelectSite={() => {}} embedded />
        )}
      {/* The Anlagen-Modell names the ONE VoltPilot-Box every reported device
          hangs off (Captain-Korrektur) — from the devices list the shell already
          holds and keeps fresh, so this page adds no request of its own. Its
          Bezugszeit travels along: der Zustand der Box altert gegen die
          Server-Antwort, nie gegen eine weiterlaufende Uhr (`liveness.ts`). */}
        {sub === 'modell' && (
          <AnlagenModellSection site={site} devices={devices} devicesFetchedAt={devicesFetchedAt} />
        )}
        {/* Die BOX ist ein TOR, kein Gerät (E3) - eigene Adresse, eigene
            Gattung. Die Referenz ist optional: eine Anlage hat genau EINE Box,
            die Fläche löst sie selbst auf. */}
        {sub === 'box' && (
          <BoxSeiteSection
            site={site}
            boxRef={geraet?.ref ?? null}
            devices={devices}
            devicesFetchedAt={devicesFetchedAt}
            onDeviceRemoved={() => {
              onOpenSub('modell');
              onReload(site.id);
            }}
          />
        )}
        {sub === 'geraet' && geraet && (
          <GeraetSeiteSection
            site={site}
            boxRef={geraet.ref}
            geraetId={geraet.geraetId}
            devices={devices}
            devicesFetchedAt={devicesFetchedAt}
          />
        )}
        {sub === 'lastspitzen' && <LastspitzenSection site={site} />}
        {sub === 'ladevorgaenge' && <LadevorgaengeSection site={site} devices={devices} />}
        {/* Die BEFEHLE-Seite gehört einer KOMPONENTE - sie kommt als
            Hash-Parameter, damit jedes Lesezeichen dieselbe wieder öffnet. */}
        {sub === 'befehle' && (
          <BefehleSection
            site={site}
            entityId={parseBefehleKomponente(window.location.hash)}
            geraetRef={parseBefehleGeraet(window.location.hash)}
          />
        )}
        {sub === 'steuerung' && (
          <SteuerungSection
            site={site}
            isAdmin={isAdmin}
            onOpenSub={onOpenSub}
            onSiteSaved={(updated) => onReload(updated.id)}
          />
        )}
        {sub === 'technik' && (
          <TechnikSection
            site={site}
            devices={devices}
            sites={sites}
            onReload={onReload}
            onSiteSaved={(updated) => onReload(updated.id)}
            onSiteDeleted={onBack}
          />
        )}
      </LazyBoundary>
    </>
  );
}

/**
 * THE Anlagen-Seite: one scrollable story per Anlage (captain mockup order) -
 * Kopf (name, status dot, one German sentence, badges), Geld (the measured
 * EarningsHero, site-scoped), Jetzt (energy flow + link into the live depth),
 * Fahrplan (mini preview + one derived German sentence + today's planned
 * saving), Technik (Wechselrichter/Speicher/Register/Standort - everything
 * that used to live on Standorte/Geräte), and Mehr (Historie & Erlöse,
 * Wetter). All wording derivation is pure (fleet.ts / schedule.ts).
 */
export function AnlageSeite({
  site,
  sites,
  devices,
  onOpenSub,
  onReload,
  onHealthFacts,
}: AnlagenPageProps & {
  site: Site;
  onOpenSub: (sub: AnlagenSub) => void;
  /**
   * ⚠ Seit E3 UNGENUTZT: der Pfad in der Kopfzeile ist der Rückweg zur
   * Flotten-Ebene. Der Prop bleibt, damit die zwei Aufrufer (Anlagen-Seite,
   * Übersicht) unverändert bleiben — und als Andockpunkt, falls die Fläche
   * je wieder einen eigenen Rückweg braucht.
   */
  onBackToList?: (() => void) | null;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  // Das GEMESSENE Geld dieser Anlage. Seit dem Perf-Audit (vp-portal-perf-a4,
  // B2) vom anlagen-scharfen `/sites/{id}/earnings` (3 Queries, ~0,42 s) statt
  // vom mandantenweiten `/earnings` (8 Queries, 1,8 s bei range=year) mit
  // Client-Filter - der Flotten-Endpunkt bleibt der Portfolio-Seite.
  const [siteEarnings, setSiteEarnings] = useState<SiteEarnings | null>(null);
  // The period tabs govern the whole page (captain 2026-07-07). `at` is the
  // selected instance (a month tapped in the strip); null = the current period.
  // Die Voreinstellung ist „Heute" und steht an EINER Stelle (`anlage.ts`);
  // eine getroffene Wahl gewinnt danach wie bisher (Captain 2026-07-30).
  const [range, setRange] = useState<EarningsRange>(DEFAULT_EARNINGS_RANGE);
  const [at, setAt] = useState<string | null>(null);
  const [nextHourTempC, setNextHourTempC] = useState<number | null>(null);
  const [weatherWhyText, setWeatherWhyText] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<ControlStatus | null>(null);
  // Die Abregel-Wahrheit (PR 3): setzt die Anlage eine geplante Drosselung
  // wirklich um? Eigener Abruf (der Herzschlag-Block kommt unabhängig vom
  // Rücklese-Block), fail-soft - null = kein Beleg = Plan-Wortlaut.
  const [curtailStatus, setCurtailStatus] = useState<CurtailmentStatus | null>(null);
  // Die Ladepunkte (Lastmanagement Stufe 3) - fail-soft wie jeder additive
  // Abruf hier: ein älteres Backend kennt die Route nicht, dann gibt es die
  // Kachel schlicht nicht.
  const [charging, setCharging] = useState<SiteCharging | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planFailed, setPlanFailed] = useState(false);
  // U4: recent telemetry for the peak face's live ¼-h mean (fetched only when
  // the cockpit leads with the Peak-Band - see the gated effect below).
  const [peakSamples, setPeakSamples] = useState<TelemetryPoint[]>([]);
  // M3: today's Historie totals feed the Eigenverbrauchs-Block (Autarkie /
  // PV-Nutzung); since v3 M2 they ALSO feed the cockpit hero's rings and the
  // Haus/Netz widgets, so the projection path fetches them once for all of it.
  const [dayTotals, setDayTotals] = useState<HistoryTotals | null>(null);
  // v3.2 M1: the hero rings (Autarkie / Eigenverbrauch) follow the SELECTED
  // period tab, so they read range-scoped Historie totals (day/month/year) -
  // distinct from `dayTotals`, which stays "today" for the widget grid. The
  // energy flow stays live regardless. null while loading / for "Gesamt".
  // v3.2 M2: the SAME range-scoped Historie also feeds the rich widget-detail
  // modal's Verlauf chart (one fetch, buckets + totals), so we keep the whole
  // `History` and derive the totals from it.
  const [rangeHistory, setRangeHistory] = useState<History | null>(null);
  const rangeTotals: HistoryTotals | null = rangeHistory?.totals ?? null;
  // The site's measurement points (primary inverter + configured sources), so
  // the hero can explain a multi-inverter site's composite PV (#524).
  // Fail-soft: an older backend simply yields no breakdown.
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  // Der Cockpit-Verbraucherstreifen (§14.10): steuerbare Verbraucher + ihr
  // Live-Zustand, fail-soft geladen. Ohne Verbraucher / auf einem älteren
  // Backend bleibt es null und das Cockpit ist byte-identisch zu vorher.
  const [consumersView, setConsumersView] = useState<ConsumerStripView | null>(null);
  // Der ROHE Zustand steuerbarer Verbraucher: der Streifen verdichtet ihn zu
  // seiner eigenen Sicht, die Verbrauchs-Aufschlüsselung braucht ihn je Gerät
  // (ein Gerät ohne Messung hat NUR diesen Zustand).
  const [consumerStatus, setConsumerStatus] = useState<ConsumerRuntimeStatus[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  // Aufwach-Signal: die drei BEDINGTEN Lade-Effekte unten holen beim Betreten
  // sofort und hängen sonst nur an einem Intervall - das ein verdeckter Tab
  // drosselt oder einfriert. `wake` in ihrer Abhängigkeitsliste lässt sie beim
  // Zurückkommen (auch aus dem bfcache) erneut laufen, ihre Bedingungen und
  // Abbruch-Wächter bleiben unangetastet (`useWake.ts`).
  const wake = useWake();
  // Mobil-Umbau Stufe 2: unterhalb der Telefon-Grenze rendert das Cockpit eine
  // eigene KOMPOSITION (Konzept `data/vp-mobile-views-x1`, Sektion „Cockpit").
  // Ohne `matchMedia` (jsdom/SSR) ist das `false` — also die Bühne, unverändert.
  const isPhone = useIsPhone();
  // Der Auslöser der Sticky-Kopfzahl: sie erscheint erst, wenn die Geld-Karte
  // nach oben aus dem Bild gescrollt ist.
  const [moneyRef, scrolledPastMoney] = useScrolledPast<HTMLDivElement>(isPhone);

  // Start the layout inputs before secondary reads can occupy the available
  // browser connections. The loading gate below still waits for real facts.
  // AE1/AE7: the compact "Jetzt gerade" flow becomes the adaptive N-node
  // diagram once the site has a renderable topology; otherwise the cockpit
  // falls back to the plain `EnergyFlow` (`CockpitHero` decides internally).
  // `reloadKey` doubles as the retry key: bumping it (an "Erneut versuchen"
  // click) forces a fresh fetch of the SAME site.
  const adaptiveLive = useAdaptiveLive(site.id, reloadKey);

  // M3 (#531): the cockpit is the PROJECTION of the Anlage — a deterministic
  // module stack derived from the ACTIVE MODES (M0 `surface.ts`). `blocks`/
  // `modes` come straight from the read-model - `cockpitBlocks` already
  // returns `[]` for a site without entities, so there is no separate
  // "projected ? … : []" ternary any more.
  const {
    surface,
    entities: siteEntityPins,
    loading: surfaceLoading,
    failed: surfaceFailed,
  } = useAnlageSurface(site, reloadKey);

  // Status + live snapshot: the site's overview row (device health + newest
  // sample) - the same source the fleet cards render from.
  useEffect(() => {
    let active = true;
    api.overview().then(
      (o) => {
        if (!active) return;
        setOverview(o);
        setOverviewFailed(false);
      },
      () => {
        if (active) setOverviewFailed(true);
      },
    );
    return () => {
      active = false;
    };
    // `sites` identity changes on explicit App reloads (device claimed, site
    // edited), keeping a fresh claim's status current without the 30 s poll.
  }, [site.id, sites, reloadKey]);

  // The measured money numbers - site-scoped (B2). Refetched when the period
  // (range/at) changes; the page keeps the previous numbers until the new ones
  // arrive (no flash). Fail-soft: an older backend / a 404 leaves the last
  // value.
  useEffect(() => {
    let active = true;
    api.siteEarnings(site.id, range, at).then(
      (e) => {
        if (active) setSiteEarnings(e);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey, range, at]);

  // Inverter-control confirmation for the calm "Steuerung" strip, loaded
  // silently (null while none has arrived yet or on any failure).
  useEffect(() => {
    let active = true;
    api.controlStatus(site.id).then(
      (c) => {
        if (active) setControlStatus(c);
      },
      () => {
        if (active) setControlStatus(null);
      },
    );
    api.curtailmentStatus(site.id).then(
      (c) => {
        if (active) setCurtailStatus(c);
      },
      () => {
        if (active) setCurtailStatus(null);
      },
    );
    api.siteChargers(site.id).then(
      (c) => {
        if (active) setCharging(c);
      },
      () => {
        if (active) setCharging(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // The PV breakdown's measurement points, loaded silently (#524).
  useEffect(() => {
    let active = true;
    api.siteSources(site.id).then(
      (s) => {
        if (active) setSources(s);
      },
      () => {
        if (active) setSources(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // The cockpit consumer strip (§14.10): controllable consumers + their live
  // state. Fail-soft - an older backend / a site without consumers yields null,
  // and the strip renders nothing (cockpit byte-identical to before).
  useEffect(() => {
    let active = true;
    Promise.all([
      consumersApi.list(site.id).catch(() => []),
      consumersApi.status(site.id).catch(() => []),
    ]).then(([list, statuses]) => {
      if (!active) return;
      setConsumerStatus(statuses ?? null);
      setConsumersView(
        consumerStrip(
          (list ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            ratedPowerKw: Number(c.ratedPowerKw),
            connection: c.connection,
          })),
          statuses ?? [],
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Wetter: the "Mehr" card teaser temp AND the live-zone "why" one-liner
  // (report N3), loaded silently.
  useEffect(() => {
    let active = true;
    api.weather(site.id).then(
      (w) => {
        if (!active) return;
        const idx = nextHourIndex(w.points, Date.now());
        setNextHourTempC(idx >= 0 ? (w.points[idx].temperatureC ?? null) : null);
        setWeatherWhyText(weatherWhy(w.points, new Date()));
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // The battery-dispatch plan: drives the promoted Fahrplan band, the
  // Fahrplan-aktiv health item and whether control is expected.
  useEffect(() => {
    let active = true;
    setPlanLoading(true);
    api.schedule(site.id).then(
      (p) => {
        if (!active) return;
        setPlan(p);
        setPlanFailed(false);
        setPlanLoading(false);
      },
      () => {
        if (!active) return;
        setPlanFailed(true);
        setPlanLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Freshness tick (5 s) + silent 30 s background poll.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const atRef = useRef(at);
  atRef.current = at;
  // Daten-Takt über `useFreshnessPoll` (holt beim Aufwachen SOFORT nach), Uhr
  // daneben - sonst zeigt das Cockpit dem zurückkehrenden Kunden bis zu 30 s
  // lang die Zahlen von vorhin.
  useFreshnessPoll(() => {
    setNow(new Date());
    api.overview().then(
      (o) => setOverview(o),
      () => {},
    );
    api.siteEarnings(site.id, rangeRef.current, atRef.current).then(
      (e) => setSiteEarnings(e),
      () => {},
    );
    api.controlStatus(site.id).then(
      (c) => setControlStatus(c),
      () => {},
    );
    api.curtailmentStatus(site.id).then(
      (c) => setCurtailStatus(c),
      () => {},
    );
    api.schedule(site.id).then(
      (p) => setPlan(p),
      () => {},
    );
  }, LIVE_POLL_MS);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const ovSite = overview?.sites.find((x) => x.id === site.id) ?? null;
  const sentence = ovSite ? composeSiteSentence(ovSite, now) : null;
  const fresh = ovSite ? siteLiveFresh(ovSite, now) : false;
  const blocks = surface?.cockpitBlocks ?? [];
  // Die Staffel des ersten Bildes (Bewegungs-Programm P4). Sie fährt auf der
  // Erinnerung von P6 (`src/staffel.ts`): dieselbe Klasse, dieselbe Regel
  // „einmal je Sitzung" — der Stapel stellt sich beim ersten Mal vor und
  // steht bei jeder Rückkehr still.
  const staffel = useStaffel('cockpit-stapel');
  const modes = surface?.modes ?? [];
  const lead = leadBlock(blocks);
  const isPeakLead = hasBlock(blocks, 'peak-band');

  // Der DREIWERTIGE Render-Entscheid (Captain-Nachtrag 06.08.2026, `cockpit.ts`
  // `anlageDecision`): SOLANGE die Entscheidungs-Eingaben laufen — `/entities`,
  // `/topology` UND die Übersichts-Zeile (die `setupPathActive` unten braucht,
  // um „noch nie Daten geliefert" von „noch nicht geladen" zu unterscheiden) —
  // wird KEIN Layout gewählt. Das ist der eigentliche Fix des „erst zeigt das
  // Portal die alte Ansicht"-Defekts: die frühere Weiche entschied, BEVOR ihre
  // Eingaben geladen waren.
  const overviewPending = overview == null && !overviewFailed;
  const decisionLoading = surfaceLoading || adaptiveLive.loading || overviewPending;
  const decisionFailed = surfaceFailed || adaptiveLive.failed || overviewFailed;
  const [decisionTimedOut, setDecisionTimedOut] = useState(false);
  useEffect(() => {
    if (!decisionLoading) {
      setDecisionTimedOut(false);
      return undefined;
    }
    const timer = setTimeout(() => setDecisionTimedOut(true), ANLAGE_DECISION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [decisionLoading, site.id, reloadKey]);
  const decision = anlageDecision({
    loading: decisionLoading,
    failed: decisionFailed,
    timedOut: decisionTimedOut,
    hasEntities: surface?.base.hasEntities,
    adaptive: adaptiveLive.adaptive,
  });
  const decided = decision === 'stack' || decision === 'unassigned';

  // M5 (#533): die Ausprägung "Neu / leer" — das Cockpit IST der
  // Einrichtungspfad. Die Weiche ist bewusst eng (siehe `setupPath.ts`): eine
  // bereits messende Anlage ohne v2-Entitäten bekommt NICHT den Einrichtungspfad
  // (siehe den „nicht zugeordnet"-Endzustand unten) — nur eine Anlage, die noch
  // nie Messdaten geliefert hat. `pinned` hält ihn stehen, während der Kunde
  // mitten in der Kette steht (nach einer Übernahme), damit die Seite nicht
  // unter ihm wegspringt. Ausgewertet erst, sobald wirklich ENTSCHIEDEN ist -
  // während `decision === 'pending'` bräuchte sie eine Übersichts-Zeile, die es
  // noch gar nicht gibt.
  const [setupPinned, setSetupPinned] = useState(false);
  const showSetup =
    decided &&
    (setupPinned ||
      setupPathActive({
        hasEntities: surface?.base.hasEntities,
        modeCount: surface?.modes.length ?? 0,
        statusLoaded: ovSite != null,
        lastSeenAt: ovSite?.lastSeenAt ?? null,
        hasLiveSample: ovSite?.live != null,
      }));
  // Der Modul-Stapel selbst rendert nur, wenn ENTSCHIEDEN, nicht der
  // Einrichtungspfad, UND `projectionActive` (in `decision` verrechnet) wirklich
  // zutrifft - sonst ist es der ehrliche „nicht zugeordnet"-Endzustand.
  const showStack = decided && !showSetup && decision === 'stack';

  // B1 · Welle 3 startet MIT Welle 2 (Perf-Review `vp-cockpit-perf-p7` §3).
  // `/history` und `/telemetry` hingen an `showStack`/`isPeakLead` und damit
  // daran, dass `/entities` + `/topology` geantwortet haben - eine dritte
  // serielle Etappe, gemessen ~0,5 s bei Prod-Latenz. Das GESICHT dieser Anlage
  // aus der Tab-Sitzung laesst sie optimistisch sofort starten; faellt die
  // Entscheidung anders aus, verwerfen die Effekte ihr Ergebnis in ihrem
  // bestehenden `else`-Zweig. Es wandert NUR der Startzeitpunkt - gerendert
  // wird weiterhin ausschliesslich nach `showStack`/`isPeakLead`, und
  // `decision === 'pending'` zeigt unveraendert `AnlagePending`.
  // ⚠ Die Erinnerung wird je Anlage GENAU EINMAL gelesen, und zwar in der
  // RENDER-Phase (Reacts „Zustand an geaenderte Props anpassen"-Muster) - nicht
  // in einem Effekt: `AnlageSeite` ist nicht je Anlage gekeyt, ein
  // Anlagen-Wechsel montiert also nicht neu, und ein Effekt liefe erst NACH dem
  // ersten Render der neuen Anlage - genau in dem er spekulieren muesste. Nach
  // dem Lesen bleibt sie stehen, damit das `rememberFace` weiter unten die
  // laufende Spekulation nicht mitten im Boot umwirft.
  const [guess, setGuess] = useState(() => ({ site: site.id, face: readFace(site.id) }));
  if (guess.site !== site.id) setGuess({ site: site.id, face: readFace(site.id) });
  useEffect(() => {
    if (!decided) return;
    rememberFace(site.id, { stack: showStack, peak: isPeakLead });
  }, [site.id, decided, showStack, isPeakLead]);
  /** Das Gate der Historie-Abrufe: echte Entscheidung, sonst die Erinnerung. */
  const fetchStack = fetchGate(showStack, decided, guess.face?.stack);
  /** Dasselbe fuer das Telefon-Fenster des Peak-Bands. */
  const fetchPeak = fetchGate(isPeakLead, decided, guess.face?.peak);

  // Recent telemetry for the Peak-Band's live ¼-h mean - fetched ONLY when the
  // cockpit leads with the Peak-Band, so non-peak faces never pay for it. A
  // 20-min window always covers the running quarter; polled on the 30 s cadence.
  // Eine späte Antwort der ZUVOR gewählten Anlage darf die neue nie
  // überschreiben - der Ersatz für den `active`-Wächter des alten Intervalls.
  const siteIdRef = useRef(site.id);
  siteIdRef.current = site.id;
  const peakLoadRef = useRef<() => void>(() => {});
  peakLoadRef.current = () => {
    if (!fetchPeak) return;
    const from = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const id = site.id;
    api.telemetry(id, from).then(
      (pts) => id === siteIdRef.current && setPeakSamples(pts),
      () => {},
    );
  };
  useEffect(() => {
    if (!fetchPeak) {
      setPeakSamples([]);
      return;
    }
    peakLoadRef.current();
  }, [site.id, fetchPeak, reloadKey, wake]);
  // LIVE: das Viertelstunden-Band liest gemessene Telemetrie.
  useFreshnessPoll(() => peakLoadRef.current(), LIVE_POLL_MS, fetchPeak);

  // M3: the Eigenverbrauchs-Block's Autarkie / PV-Nutzung come from the EXISTING
  // Historie totals of today (server-computed) - fetched ONLY while the stack
  // truly renders, so neither the setup nor the "nicht zugeordnet" end state
  // pays for it. A failure leaves the numbers null and the block simply omits
  // those tiles (never a fake 0 %).
  // Beim Standard-Zeitraum „Heute" (ohne getippten Vormonat) fragt dieser
  // Abruf ZEICHENGLEICH dasselbe wie der Zeitraum-Abruf darunter - es war zwei
  // Mal dieselbe Anfrage samt zweitem 30-s-Takt. Dann wird er ausgelassen und
  // der Wert kommt aus `rangeHistory`; die Aussage ist identisch, weil es
  // dieselbe Antwort ist.
  const dayIsRange = range === 'day' && at == null;
  /** Die Tages-Summen: eigener Abruf - oder die des Zeitraums, wenn er GENAU
   *  derselbe ist. Nie ein anderer Wert, nur eine Anfrage weniger. */
  const dayTotalsEffective: HistoryTotals | null = dayIsRange ? rangeTotals : dayTotals;
  const dayTotalsLoadRef = useRef<() => void>(() => {});
  dayTotalsLoadRef.current = () => {
    if (!fetchStack || dayIsRange) return;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    const id = site.id;
    api.history(id, 'day', today).then(
      (h) => id === siteIdRef.current && setDayTotals(h.totals),
      () => {},
    );
  };
  useEffect(() => {
    if (!fetchStack || dayIsRange) {
      setDayTotals(null);
      return;
    }
    dayTotalsLoadRef.current();
  }, [site.id, fetchStack, dayIsRange, reloadKey, wake]);
  // LIST: eine Tages-SUMME aus den Viertelstunden-Rollups - sie bewegt sich
  // nicht sekündlich, ein Live-Takt fragte dreimal nach derselben Zahl.
  useFreshnessPoll(
    () => dayTotalsLoadRef.current(),
    LIST_POLL_MS,
    fetchStack && !dayIsRange,
  );

  // v3.2 M1: the hero rings follow the SELECTED period tab. They read
  // range-scoped Historie totals (Tag/Monat/Jahr) so "Autarkie · Monat" is
  // genuinely the month's autarky, not today's. The `at` selects a past month
  // (MonthStrip) exactly like the earnings fetch. "Gesamt" (`all`) has no
  // all-time Historie endpoint -> no fetch -> the rings are honestly absent
  // (never a wrong-range value). Fail-soft; the energy flow is untouched.
  const rangeHistoryLoadRef = useRef<() => void>(() => {});
  rangeHistoryLoadRef.current = () => {
    const hRange = historyRangeForCockpit(range);
    if (!fetchStack || hRange == null) return;
    const atForHistory =
      at ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    const id = site.id;
    api.history(id, hRange, atForHistory).then(
      (h) => id === siteIdRef.current && setRangeHistory(h),
      () => {},
    );
  };
  useEffect(() => {
    if (!fetchStack || historyRangeForCockpit(range) == null) {
      setRangeHistory(null);
      return;
    }
    rangeHistoryLoadRef.current();
  }, [site.id, fetchStack, range, at, reloadKey, wake]);
  // LIST: dasselbe Zeitraum-Aggregat wie darüber, nur für den gewählten Tab.
  useFreshnessPoll(
    () => rangeHistoryLoadRef.current(),
    LIST_POLL_MS,
    fetchStack && historyRangeForCockpit(range) != null,
  );

  // The Peak-Band view: live ¼-h mean (import-only, from the window above) vs.
  // the plan's Ziel + the PS-4 numbers. Null when not the peak lead.
  const peakView = isPeakLead
    ? peakBand({
        current: quarterHourMeanImportKw(peakSamples, now),
        targetKw: plan?.peakTargetKw ?? null,
        peak: siteEarnings?.peakShaving ?? null,
      })
    : null;

  // Fahrplan-derived flags: whether the plan is current for today (health) and
  // whether the site is controllable (a plan published to a battery device),
  // which keeps the Steuerung strip honest even before the first readback.
  const planSlots = plan?.slots ?? [];
  const hasPlanToday = todaySlots(planSlots, now).length > 0;
  const batteryLinked = plan?.deviceId != null;

  // Flussabgleich (Scout `vp-verkauf-praemisse-s8` §3, Pilsting/Herzogau): eine
  // register-bestätigte, aber anders fließende Order versöhnt Steuerzeile und
  // Flussbild - EINE Ableitung für den Satz der Steuerzeile (control.ts) UND den
  // Speicherknoten-Haken. Entprellt über den Rücklese-Zeitpunkt des Geräts.
  // Steht VOR `controlView`, weil dessen Satz den Befund konsumiert.
  const cockpitSnap = siteSnapshot(ovSite?.live ?? null);
  // Negativ = Einspeisung; die GEMESSENE Größe für den kappen-ehrlichen
  // Fahrplan-Satz (Teil 2 „gemessen").
  const measuredExportKw =
    fresh && cockpitSnap.gridKw != null && cockpitSnap.gridKw < 0 ? -cockpitSnap.gridKw : null;
  const cockpitFlowInput = {
    commandedKw: controlStatus?.commandedKw,
    snapshot: cockpitSnap,
    snapshotFresh: fresh,
    executionMode: controlStatus?.executionMode,
    maxFeedInKw: site.maxFeedInKw,
  };
  const hasFlowConflictCandidate = flowConflictCandidate(cockpitFlowInput) != null;
  const [flowConflictStreak, setFlowConflictStreak] = useState(0);
  const flowCandRef = useRef(hasFlowConflictCandidate);
  flowCandRef.current = hasFlowConflictCandidate;
  const flowConflictObs = controlStatus?.checkedAt ?? null;
  useEffect(() => {
    if (flowConflictObs == null) return;
    setFlowConflictStreak((s) => stepFlowConflict(s, flowCandRef.current));
  }, [flowConflictObs]);
  const cockpitFlow = flowConflict(cockpitFlowInput, flowConflictStreak);

  // WHY the current setpoint is what it is: the OPTIMIZER's own recorded reason
  // for the slot being executed (Fahrplan-Warum), never a second explanation
  // logic here. Null outside the horizon or on a plan from before the why-layer
  // - the strip then claims no cause (the idleReason discipline).
  const activePlanSlot = controlReasonSlot(planSlots, now, plan?.slotMinutes ?? 15);
  // Die Abregel-Beleg-Lage gilt NUR für die laufende Viertelstunde und nur,
  // wenn dort abgeregelt werden soll - `curtailTruthForSlot` ist der Filter,
  // sonst behauptete die Karte etwas über eine Stunde, die noch kommt.
  const controlCurtail = curtailTruthForSlot(
    curtailTruth(curtailStatus, now),
    activePlanSlot?.slotRole,
  );
  const planKind =
    site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch';
  // Teil 4b: warum geht der Solar-Überschuss GERADE ins Netz statt in die
  // Batterie? Overrides the plain slot reason when the slot exports; null
  // otherwise, so the strip falls back to the base reason (Null-Degradation).
  const surplusReason = activePlanSlot
    ? surplusWhy(activePlanSlot, planKind, nextChargeStart(planSlots, now), {
        // Teil 2/3: das Plan-Fenster für die Ladefenster-Ökonomie, die gepflegte
        // Grenze + die gemessene Einspeisung für den kappen-ehrlichen Satz.
        slots: planSlots,
        slotMinutes: plan?.slotMinutes ?? 15,
        maxFeedInKw: site.maxFeedInKw,
        measuredExportKw,
      })
    : null;
  const baseReason = activePlanSlot
    ? // Die LAUF-Fakten reisen mit (Erklärbarkeit Stufe 1): der Ruhe-Grund der
      // Steuerungs-Zeile nennt denselben Treiber wie die Fahrplan-Seite - EIN
      // Generator, EIN Satz, kein zweiter Wortlaut. Erklärbarkeit Stufe 3
      // reicht dazu die Grenzen-Fakten durch (Einspeisegrenze der Anlage + der
      // s0-Block der Box), damit ein Abregel-Slot hier dieselbe Ursache nennt.
      slotWhy(activePlanSlot, planKind, controlCurtail, planSlots, plan, {
        maxFeedInKw: site.maxFeedInKw,
        curtailment: curtailStatus,
      })
    : null;
  const controlReason = surplusReason ?? baseReason;
  // Teil 3: der nächste geplante Einsatz - im Ruhefall als eigene Ausblick-Zeile.
  const controlOutlook = planOutlook(planSlots, now);
  const controlView = controlStrip(
    controlStatus,
    now,
    batteryLinked,
    controlReason,
    controlCurtail,
    controlOutlook,
    surplusReason != null,
    // Die Anlage wurde ausdrücklich OHNE Ladestand eingerichtet - dann ist
    // „VoltPilot prüft das Modell am Prüfstand" die falsche Auskunft.
    controlStatus?.missingReadingChannel === 'soc_pct',
    // Der Flussabgleich: bei „pausiert, fließt aber" ersetzt sein Satz den
    // gesunden - `info` grün (voller Netzanschluss), `warn` bernstein.
    cockpitFlow ? { severity: cockpitFlow.severity, text: cockpitFlow.text } : null,
  );
  // Der EINSPEISEWÄCHTER („Grenzen & Wächter" Stufe 0): eine STEHENDE Aussage
  // über die Anlage - welche Einspeisegrenze gilt, wirkt sie überhaupt, und
  // hält der Wechselrichter selbst eine engere. Bewusst NICHT durch
  // `curtailTruthForSlot` gefiltert (das gilt der laufenden Viertelstunde) und
  // bewusst unabhängig von `controlView`: ein Gerät ohne Batterie-Rücklesung
  // liefert keine Steuerzeile, hält aber sehr wohl eine Grenze - genau die
  // Konstellation, die in Herzogau zwei Untersuchungsrunden gekostet hat.
  const guardView = exportGuardView(curtailStatus, now);

  // The Gesundheits-Checklist — rendered on BOTH cockpit paths (the projected
  // one lists it as its "Zustand" card, so a migrated plant has the surface the
  // header badge drills to; before this it existed only on the v1 branch).
  const health = healthChecklist({
    deviceCount: ovSite?.deviceCount ?? 0,
    onlineCount: ovSite?.onlineCount ?? 0,
    waitingCount: ovSite?.waitingCount ?? 0,
    hasPlanToday,
    hasAnyPlan: planSlots.length > 0,
    controlState: controlView?.state ?? null,
    batteryWithoutDevice: ovSite?.batteryWithoutDevice ?? false,
    batteryLinked,
  });

  // Report the facts only this page measures up to the shell badge, so header
  // and cockpit can never disagree about the same Anlage. The overview drives
  // whether the battery fact is KNOWN at all — without it the badge must not
  // conclude "kein Speicher" (an absent fact contributes nothing).
  const planKnown = !planLoading && !planFailed;
  const hasAnyPlan = planSlots.length > 0;
  const controlState = controlView?.state ?? null;
  const batteryKnown = ovSite != null;
  const batteryWithoutDevice = ovSite?.batteryWithoutDevice ?? false;
  useEffect(() => {
    if (!onHealthFacts) return;
    onHealthFacts(site.id, {
      plan: planKnown ? { hasPlanToday, hasAnyPlan } : null,
      controlState,
      battery: batteryKnown ? { withoutDevice: batteryWithoutDevice, linked: batteryLinked } : null,
    });
  }, [
    onHealthFacts,
    site.id,
    planKnown,
    hasPlanToday,
    hasAnyPlan,
    controlState,
    batteryKnown,
    batteryWithoutDevice,
    batteryLinked,
  ]);

  // The selected period instance (`at` = a tapped past month; null = current).
  const atDate = at ? new Date(`${at}T12:00:00`) : now;

  // v3 M2 · das Live-Cockpit: Hero (bestehendes Energiefluss-Diagramm groß +
  // Ringe + Geld + Fahrplan-Zeile) und das Widget-Raster. Beide Ableitungen
  // sind rein (`cockpitWidgets.ts`); hier wird nur gefüttert und gerendert.
  const heroView = cockpitHero({
    totals: rangeTotals,
    money: siteEarnings,
    range,
    at: atDate,
    now,
    slots: planSlots,
    slotMinutes: plan?.slotMinutes ?? 15,
    plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
  });
  // `cockpitWidgets` is safe to call unconditionally: `blocks`/`modes` are
  // already the correctly-empty read-model of a non-stack Anlage, so it
  // returns `[]` on its own - no separate gate needed here.
  const widgetInput: CockpitWidgetsInput = {
    blocks,
    modes,
    lead,
    dayTotals: dayTotalsEffective,
    money: siteEarnings,
    streams: surface?.moneyStreams ?? [],
    range,
    at: atDate,
    now,
    slots: planSlots,
    slotMinutes: plan?.slotMinutes ?? 15,
    plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
    peak: peakView,
    charging,
    weather: { nextHourTempC, why: weatherWhyText },
  };
  const widgets = cockpitWidgets(widgetInput);
  // Mobil-Umbau Stufe 2 (`<= 720px`): dieselben Kacheln minus die, deren
  // Aussage auf demselben Telefon-Bildschirm schon steht. Die Regel ist rein
  // (`mobileWidgets`), hier wird nur gewählt.
  const shownWidgets = isPhone
    ? mobileWidgets(widgets, { hasRings: heroView.rings.length > 0 })
    : widgets;
  // ONE freshness truth (G3/R4): the three-state `liveState` drives BOTH the
  // head chip and the hero/board dimming. `site-only` (the Anlage delivers,
  // the per-device breakdown does not) gets its own honest chip wording and
  // never greys anything; only `stale` dims — values keep last-good, absent
  // stays "—", never a 0.
  const liveSt: LiveState = adaptiveLive.topology
    ? liveState({
        entityFresh: adaptiveLive.topology.entities.some((e) => e.health === 'ok'),
        siteFresh: fresh,
      })
    : fresh
      ? 'live'
      : 'stale';
  const heroStale = liveSt === 'stale';
  const chip = ovSite && !showSetup ? liveChip(liveSt, ovSite.live?.ts ?? null, now) : null;

  // Die Kopfsatz-Regel der Bühne (Konzept §6.2): der Prosa-Satz doppelte im
  // Normalfall die drei Zahlen, die 100 px tiefer an den Fluss-Knoten stehen.
  // Er wird nicht abgeschafft - er spricht nur noch, wenn er etwas ANDERES
  // sagt als das Diagramm (Warnung, kein zeichenbarer Fluss, Einrichtung).
  // `flowHasValues` ist dieselbe reine Funktion, die auch der Hero benutzt -
  // kein zweites Urteil über dieselbe Frage.
  const heroSnapshot = ovSite ? siteSnapshot(ovSite.live) : null;
  const showHeadSentence = headSentenceVisible({
    projected: showStack,
    tone: sentence?.tone ?? null,
    hasFlow: flowHasValues(adaptiveLive.topology, heroSnapshot),
  });

  const switchRange = (r: EarningsRange) => {
    setRange(r);
    setAt(null);
  };

  // „Eine Kachel ist ein Absprung" (V2): ein Tipp navigiert direkt zum Ziel der
  // Kachel — kein Modal. Seit dem Cockpit+Live-Merge sind alle Kacheln Geld-/
  // Modus-Kacheln und öffnen ihre Seite; die Verlauf-Sprünge (mit Zeitraum-
  // Übernahme) leben auf den Komponenten-Board-Zeilen.
  const jumpToWidget = (widget: WidgetDef) => onOpenSub(widget.target.sub);

  // --- Mobil-Umbau Stufe 2 --------------------------------------------------
  // Dieselben zwei Bausteine, nur in zwei Kleidern und zwei Reihenfolgen: am
  // Rechner Preis → Fahrplan als Karten, am Telefon Fahrplan → Preis als je
  // EINE Zeile mit Absprung. Sie werden hier EINMAL gebaut, damit die zwei
  // Fassungen nicht auseinanderlaufen können.
  const strompreisRow = gateStrompreis(modes, site.tarifArt) ? (
    <StrompreisStrip
      siteId={site.id}
      isDv={site.plantKind === 'direktvermarktung'}
      tarifArt={site.tarifArt}
      kind={site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch'}
      slots={planSlots}
      slotMinutes={plan?.slotMinutes ?? 15}
      activeSlot={activePlanSlot}
      onOpenMarktpreise={() => onOpenSub('marktpreise')}
      compact={isPhone}
    />
  ) : null;
  // ①b Speicher-Fahrplan (PR 4, Konzept §4b). Gated wie die Fahrplan-Ansicht
  // selbst; der volle Chart lebt nur auf der Fahrplan-Seite (D7). Am Telefon
  // trägt die Zeile zusätzlich den Wetter-Satz — die Wetter-Kachel entfällt
  // dafür, und ohne erklärenden Satz erscheint gar nichts.
  const fahrplanRow = (surface?.deepViews ?? []).includes('fahrplan') ? (
    <FahrplanBand
      plan={plan}
      plantKind={site.plantKind}
      now={now}
      loading={planLoading && plan == null}
      failed={planFailed}
      onOpen={() => onOpenSub('fahrplan')}
      compact={isPhone}
      weatherWhy={weatherWhyText}
    />
  ) : null;
  // Die geschrumpfte Kopfzahl beim Scrollen: die zwei Anker (Geld + Zustand).
  const sticky = isPhone
    ? stickyHead({ money: heroView.money, status: showSetup ? null : (sentence ?? null) })
    : null;

  // Die Referenz der Box dieser Anlage - dieselbe ehrliche Regel wie auf der
  // Box-Seite: eine Anlage hat GENAU EINE Box, und mehr als ein eigenes Gerät
  // lässt sie nicht eindeutig bestimmen. Dann führt keine Ladepunkt-Zeile
  // irgendwohin, statt auf ein geratenes Gerät zu zeigen.
  const eigeneGeraete = (devices ?? []).filter((d) => d.siteId === site.id);
  const boxRef = eigeneGeraete.length === 1 ? eigeneGeraete[0].externalRef : null;

  // Die Kachel „Laden" (Konzept `vp-verbraucher-cockpit-k1` §5): sie
  // beantwortet ohne Klick, was die Aufschlüsselung nicht kann - „steckt ein
  // Auto?". Ohne einen einzigen Ladepunkt ist sie null und der Baustein gar
  // nicht erst verfügbar.
  const ladenView = useMemo(
    () =>
      ladenKachel({
        charging,
        links: {
          uebersicht: () => hashForRoute(anlageRoute(site.id, 'ladevorgaenge')),
          charger: (id) =>
            boxRef ? geraetSeiteHash(site.id, boxRef, chargerGeraetId(id)) : null,
        },
      }),
    [charging, site.id, boxRef],
  );

  // Die beiden Lade-Kreise des Flussbildes, getrennt nach Anschlusspunkt
  // (Cockpit Phase 1 / C2): der Abzweig hinter dem Haus und - falls eine Säule
  // an einem EIGENEN Netzanschluss hängt - ein Kreis am Hub daneben.
  const ladeKreise = useMemo(() => ladeFlussKnoten(charging), [charging]);

  // --- Anwendungs-Programm Stufe 3 · das anpassbare Cockpit ------------------
  // Welche BAUSTEINE diese Anlage GERADE hat: dieselbe Ehrlichkeit wie bisher -
  // was keine Quelle hat, ist gar nicht erst verfügbar (und lässt sich damit
  // auch nicht anordnen oder ausblenden). Der Status-Kopf, die Bühne und das
  // Komponenten-Board gehören zu jedem Cockpit, das überhaupt rendert.
  const verfuegbar = useMemo<BausteinId[]>(() => {
    // `geld` ist IMMER dabei: die Geld-Fläche (Rechner-Leiste bzw. Telefon-
    // Karte) rendert auch ohne Erlös-Komposition ehrlich - nur ihr
    // Zeitraum-Segment hängt an dem Block, genau wie vor dieser Stufe.
    const out: BausteinId[] = ['status', 'energiefluss', 'geld'];
    if (controlView || guardView) out.push('steuerung');
    if (fahrplanRow) out.push('fahrplan');
    if (strompreisRow) out.push('strompreis');
    // Die Kachel „Laden" erscheint, sobald ein Ladepunkt EXISTIERT - nicht
    // erst mit einem Budget, sonst fehlte sie genau während der Einrichtung
    // (Konzept `vp-verbraucher-cockpit-k1` §5.1). Abwählbar über „Anpassen".
    if (ladenView) out.push('laden');
    if (shownWidgets.length > 0) out.push('kacheln');
    out.push('komponenten');
    if (ovSite != null && health.length > 0) out.push('zustand');
    return out;
  }, [blocks, controlView, guardView, fahrplanRow, strompreisRow, shownWidgets, ovSite, health, ladenView]);
  // ⚠ Steuerung Stufe 8: es gibt hier KEIN Tor mehr. „Eigene Auswertung" ist
  // die Katalog-Klasse `cockpit` und hat keinen Schalter — der Weg zu einer
  // eigenen Kachel ist der Anpassen-Modus, und wer dort eine anlegt, hat seine
  // Absicht bewiesen. Der frühere Umweg (erst irgendwo einschalten, dann
  // anlegen) war genau der Absichts-Schalter ohne Wirkung, den das Konzept
  // abgeschafft hat.
  const layout = useCockpitLayout({
    schluessel: site.id,
    siteId: site.id,
    verfuegbar,
    blocks,
    isPhone,
  });

  // --- Anwendungs-Programm Stufe 5 · die EIGENEN Auswertungen ---------------
  // Seit Steuerung Stufe 8 ohne jedes Tor: eine angelegte Kachel ist eine
  // Kachel. Die DEFINITIONEN bleiben wie bisher im Layout-Dokument, ein
  // ausgeblendeter Baustein behält seine Präferenz.
  const [eigenWerte, setEigenWerte] = useState<EigeneAuswertungWerte | null>(null);
  const [eigenDialog, setEigenDialog] = useState<
    { offen: true; bearbeiten: EigeneAuswertungDef | null } | null
  >(null);
  // vp-agg §2.4/B · die kanonische PV-ROLLE der Anlage: existiert eine
  // Standort-PV-Zuordnung, trägt die Cockpit-Zahl ein dezentes „berechnet" und
  // der Fluss zeigt die zusammengefasste Rolle statt telemetry.pv_power_kw. Der
  // Abruf frischt mit dem Live-Schnappschuss auf (`ovSite.live.ts`), damit die
  // Aufschlüsselung nicht neben der Flusszahl driftet. Fail-soft: ohne Antwort /
  // ohne Zuordnung bleibt die Fläche stumm (der Rückfall ist unmarkiert).
  const [pvRollen, setPvRollen] = useState<RollenKanonischerWert | null>(null);
  // ⚠ Der Abruf hängt an den GESPEICHERTEN Auswertungen, nicht am Entwurf: der
  // Server beantwortet genau die gespeicherten, und der Schlüssel ändert sich
  // damit exakt dann, wenn ein Speichern gelandet ist. Am Entwurf zu hängen
  // fragte beim Anlegen einmal zu früh (der Server kennt die Kachel noch nicht)
  // und danach nie wieder - die frisch gespeicherte Kachel bliebe für immer
  // ohne Zahl.
  const eigenIds = layout.eigeneGespeichert.map((d) => d.id).join('|');
  useEffect(() => {
    // Fail-soft wie jeder Zusatz-Abruf des Cockpits: ohne Antwort bleiben die
    // Kacheln stehen und sagen „noch keine Werte" - nie eine erfundene Zahl.
    if (eigenIds === '') {
      setEigenWerte(null);
      return undefined;
    }
    let aktiv = true;
    api.eigeneAuswertung(site.id).then(
      (w) => {
        if (aktiv) setEigenWerte(w);
      },
      () => {
        if (aktiv) setEigenWerte(null);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [site.id, eigenIds, reloadKey]);
  // vp-agg §2.4/B: die kanonische PV-Rolle der Anlage. Der Schlüssel schliesst
  // `ovSite.live.ts` ein, damit die Aufschlüsselung mit dem Live-Fluss mitzieht
  // statt bis zum nächsten Anlagenwechsel einzufrieren. Fail-soft.
  const liveTs = ovSite?.live?.ts ?? null;
  useEffect(() => {
    let aktiv = true;
    api.rollenWert(site.id, 'pv').then(
      (r) => {
        if (aktiv) setPvRollen(r);
      },
      () => {
        if (aktiv) setPvRollen(null);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [site.id, liveTs, reloadKey]);
  const eigenWerteById = useMemo(() => werteNachId(eigenWerte), [eigenWerte]);
  /**
   * Der Stift AN der Zeile einer eigenen Auswertung — nur dort. Ein Baustein
   * des Katalogs hat nichts zu bearbeiten, und ein Knopf ohne Wirkung wäre
   * genau die Zusage, die dieses Haus nicht macht.
   */
  const eigenStift = (zeile: { id: string; eigen?: boolean; label: string }) => {
    if (!zeile.eigen) return null;
    const def = layout.eigene.find((d) => d.id === zeile.id);
    if (!def) return null;
    return (
      <button
        type="button"
        className="vp-anpassen-icon"
        onClick={() => setEigenDialog({ offen: true, bearbeiten: def })}
        aria-label={`${zeile.label} ändern`}
        title="Ändern"
      >
        <Icon name="pencil" size={16} />
      </button>
    );
  };
  const eigenEinheiten = useMemo(() => {
    const out = new Map<string, string>();
    for (const e of siteEntityPins ?? []) {
      for (const m of e.capabilities?.measure ?? []) {
        out.set(`${e.id}:${m.channel}`, eigenEinheit(m.channel, m.unit));
      }
    }
    return out;
  }, [siteEntityPins]);
  // Der Lead kommt seit dieser Stufe aus der AUFLÖSUNG (Katalog -> Preset ->
  // Vorgabe -> Eigen); ohne gespeicherte Zeile ist das exakt die M0-Regel
  // peak -> Geld -> Fluss, die `leadBlock` oben schon liefert.
  const effektiverLead = layout.resolved.lead;
  const widgetsMitLead = ((): WidgetDef[] => {
    if (effektiverLead === lead) return shownWidgets;
    // Der Lead markiert nur EINE Kachel; die Menge bleibt dieselbe. Deshalb
    // wird die Kachel-Ableitung mit dem wirksamen Lead erneut gefahren und
    // danach DIESELBE Telefon-Dedupe angewandt - nie eine zweite Regel.
    const neu = cockpitWidgets({ ...widgetInput, lead: effektiverLead });
    return isPhone ? mobileWidgets(neu, { hasRings: heroView.rings.length > 0 }) : neu;
  })();
  const zeigt = (id: BausteinId) => layout.resolved.order.includes(id);

  /**
   * Der Knoten EINER eigenen Auswertung. Ohne Wert vom Server rendert sie
   * trotzdem — mit dem ehrlichen Satz statt einer erfundenen Zahl.
   */
  const eigenerKnoten = (id: string): ReactNode => {
    const def = layout.eigene.find((d) => d.id === id);
    if (!def) return null;
    // Eine Kachel, die der Server noch nicht kennt, hat NOCH KEINE Messwerte
    // verdient — sie ist schlicht ungespeichert. Das zu verwechseln wäre die
    // gefährlichere der beiden Auskünfte (der Kunde suchte einen Datenfehler).
    const gespeichert = layout.eigeneGespeichert.some((d) => d.id === id);
    const wert = eigenWerteById.get(id) ?? {
      ...def,
      wert: null,
      kanalart: null,
      komponente: null,
      entityType: null,
      hinweis: gespeichert
        ? 'Für diesen Tag liegen noch keine Messwerte vor.'
        : 'Wird berechnet, sobald Sie oben „Fertig“ gespeichert haben.',
      verlauf: [],
    };
    return (
      <EigenerBaustein
        wert={wert}
        einheit={eigenEinheiten.get(`${def.entityId}:${def.channel}`) ?? ''}
      />
    );
  };
  // Die Bausteine als Knoten unter ihrer Baustein-Id: der Stapel entsteht
  // danach aus der AUFGELÖSTEN Reihenfolge, nicht mehr aus einer hart
  // codierten Folge von JSX-Zeilen. Ohne gespeicherte Zeile kommt Zeichen für
  // Zeichen dieselbe Folge heraus (`migration.test.ts` / `AnlagenPage`-Tests).
  const bausteinNodes: Partial<Record<BausteinId, ReactNode>> = {
    energiefluss:
      ovSite == null ? (
        <Skeleton height={320} radius="var(--vp-radius-lg)" />
      ) : (
        <CockpitHero
          view={heroView}
          nachtragHref={`#/anlage/${site.id}/technik`}
          topology={adaptiveLive.topology}
          snapshot={siteSnapshot(ovSite.live)}
          stale={heroStale}
          sources={sources}
          pins={siteEntityPins}
          pvRollen={pvRollen}
          consumers={consumersView}
          onOpenConsumers={() => onOpenSub('steuerung')}
          onOpenSub={onOpenSub}
          /* Der Zeitraum steht in der Bilanz-Leiste, direkt über den
             Zahlen, die er regiert (Konzept §6.3) - nicht mehr als volle
             Seitenzeile für vier Knöpfe. Ohne Geld-Modus gibt es keinen
             Zeitraum zu wählen.
             Am Telefon (Stufe 2) trägt die EINE Geld-Karte darunter das
             Segment - dort gibt es keine Leiste. */
          periodSeg={
            !isPhone && zeigt('geld') && hasBlock(blocks, 'erloes-komposition') ? (
              <PeriodTabs range={range} onRange={switchRange} variant="seg" />
            ) : null
          }
          showRail={!isPhone && zeigt('geld')}
          /* Der Stift in der PV-Zusammensetzung — die Abkürzung zum
             Umbenennen dort, wo der Wunsch entsteht. Nach dem Speichern
             dieselbe Auffrischung wie jeder „Erneut versuchen"-Klick, damit
             der neue Name sofort überall steht. */
          rename={{
            siteId: site.id,
            boxRef: boxRefOf(devices, site.id),
            onRenamed: () => setReloadKey((k) => k + 1),
          }}
          /* Die Bestätigung ist AM Diagramm ablesbar (Speicher-Knoten),
             der Bühnenfuß liefert Satz und Grund. Ein Flusskonflikt
             (register-bestätigt, aber nicht fließend) entzieht den Haken -
             er wäre sonst genau die „lädt 3,3 kW ✓"-Lüge aus Pilsting. */
          controlConfirmed={
            controlView?.state === 'healthy' && cockpitFlow?.severity !== 'warn'
          }
          /* Die Lade-Kreise (Konzept §6, E3; Phase 1 / C2) - der Abzweig VOM
             HAUS und, für Säulen an einem EIGENEN Anschluss, ein Kreis am HUB.
             Beide aus DERSELBEN Ableitung, die auch die Kachel rendert.
             Sie hängen bewusst NICHT an `zeigt('laden')`: die Kachel ist
             abwählbar, der Fluss zeigt trotzdem, wohin der Strom geht (E4
             blendet nur die ZEILEN der Aufschlüsselung aus). Ohne Ladepunkt
             sind beide null und das Diagramm zeichengleich zu vorher. */
          charging={ladeKreise.haus}
          chargingOwn={ladeKreise.eigen}
          /* Am Telefon steht die Geld-Karte „direkt unterm Fluss"
             (Konzept) — der Bühnenfuß wandert deshalb unter die
             Fahrplan-Zeile, deren Aussage er fortsetzt (was ist geplant →
             was bestätigt der Wechselrichter). Er entfällt NICHT: er ist
             die einzige Fläche, die einen abweichenden Sollwert meldet. */
          footer={
            !isPhone && zeigt('steuerung') && (controlView || guardView) ? (
              <ControlStrip view={controlView} variant="bare" guard={guardView} />
            ) : null
          }
        />
      ),
    /* Mobil-Umbau Stufe 2: die EINE Geld-Karte direkt unter dem Fluss —
       Zahl, Zurechnung, Zeitraum-Segment und die Ringe als Chips. Sie
       ersetzt am Telefon die Bilanz-Leiste UND die zwei Geld-Kacheln
       (dieselbe Aussage stand dort bis zu viermal auf 550 px). Am Rechner
       wohnt sie IN der Bühne (`showRail`), deshalb hier nur am Telefon. */
    geld: isPhone ? (
      <div ref={moneyRef}>
        <MobileMoneyCard
          view={heroView}
          nachtragHref={`#/anlage/${site.id}/technik`}
          periodSeg={
            hasBlock(blocks, 'erloes-komposition') ? (
              <PeriodTabs range={range} onRange={switchRange} variant="seg" />
            ) : null
          }
        />
      </div>
    ) : null,
    fahrplan: fahrplanRow,
    steuerung:
      isPhone && (controlView || guardView) ? (
        <ControlStrip view={controlView} variant="card" guard={guardView} />
      ) : null,
    strompreis: strompreisRow,
    /* Die Kachel „Laden": reine Anzeige, der Kopf springt auf „Ladevorgänge",
       jede Zeile auf ihre Geräteseite. Ihre Fusszeile IST das Netzanschluss-
       Band, das dafür aus den Kennzahlen hierher gezogen ist. */
    laden: ladenView ? <LadenKachel view={ladenView} /> : null,
    /* Eine Kachel ist ein Absprung (V2): der Tipp navigiert direkt zum
       Ziel der Kachel - kein Modal mehr. */
    kacheln: <WidgetGrid widgets={widgetsMitLead} onSelect={jumpToWidget} />,
    /* Merge Option A · Stratum 3: Komponenten im Detail — das Board
       (sichtbar) + der kompakte Verlauf hinter „Verlauf ▾" (Q2). Die
       Abrufe starten erst nahe dem Viewport (lazy-mount). */
    komponenten: (
      <KomponentenSection
        site={site}
        topology={adaptiveLive.topology}
        adaptive={adaptiveLive.adaptive}
        stale={heroStale}
        range={range}
        at={at}
        dayTotals={dayTotalsEffective}
        charging={charging}
        consumerStatus={consumerStatus}
        ladenKachelSichtbar={zeigt('laden')}
        boxRef={boxRef}
      />
    ),
    /* Zustand (vp-cockpit-unten-ux-n3 PR 3): leise, wenn gesund — EINE
       Zeile; laut nur mit Befund (Ursache + Hebel je Zeile). Der
       Modus-Fuß wohnt IN der Fläche (D6) — der Stack endet mit einer
       Karte statt mit einem baumelnden Absatz. Gated auf die geladene
       Übersicht: vor der ersten Antwort gäbe es nur erfundene
       „noch nicht verbunden"-Befunde. id="zustand" bleibt das
       Sprungziel des Schalen-Abzeichens. */
    zustand:
      ovSite != null && health.length > 0 ? (
        <div className="vp-cockpit-health" id="zustand">
          <ZustandCard
            items={health}
            onOpenSub={onOpenSub}
            onOpenModus={() => onOpenSub('steuerung')}
          />
        </div>
      ) : null,
  };

  return (
    <>
      {/* Anwendungs-Programm Stufe 5: der geführte Dialog. Er hängt an der
          Seite (nicht am Anpassen-Modus), damit ein Speichern den Modus nicht
          aufreisst - der Kunde arrangiert weiter, wo er war. */}
      {eigenDialog && (
        <EigeneAuswertungDialog
          open
          siteId={site.id}
          bearbeiten={eigenDialog.bearbeiten}
          onSpeichern={(def) => {
            layout.setzeEigene(def);
            setEigenDialog(null);
          }}
          onEntfernen={(id) => {
            layout.entferneEigene(id);
            setEigenDialog(null);
          }}
          onAbbrechen={() => setEigenDialog(null)}
        />
      )}
      {/* vp-agg §2.5/C: der gerätefreie Gesamtwert-Assistent (Einstieg +
          Anzeige) ist aus der Cockpit-Bühne in die Auswertungen-/Verlauf-Fläche
          umgezogen (`MesswerteSection`). Die Cockpit-PV-Rolle (§2.4/B) bleibt
          hier - sie ist etwas anderes als ein frei zusammengestellter Wert. */}
      {/* Der Link „‹ Alle Anlagen" ist mit der Navigations-Runde „zwei
          Ebenen" ERSATZLOS entfallen (E3): der Pfad in der Kopfzeile
          („Portfolio › Solarpark Dachau ▾") IST der Rückweg, und zwei
          Rückwege auf einer Seite sind einer zu viel. */}

      {/* 1 · Kopf: Status + Warnungen bleiben oben sichtbar; Technik hinterm Zahnrad.
             Mobil-Umbau Stufe 2: am Telefon trägt die Topbar seit Stufe 1 die
             IDENTITÄT (Name als Wechsler + Zustands-Wort als Unterzeile), also
             ist dieser Block dort die zweite Kopie davon — er entfällt bis auf
             den Frische-Chip (die EINE Frischewahrheit, R4) und das Zahnrad.
             Die Überschrift bleibt als sr-only bestehen: 0 px hoch, aber die
             Seite verliert ihr Sprungziel nicht. */}
      <div className={`vp-page-head vp-anlage-head${isPhone ? ' is-phone' : ''}`}>
        {isPhone && <h1 className="vp-sr-only">{site.name}</h1>}
        <div className="titles">
          <h1>
            <span
              className={`vp-fleet-dot tone-${sentence?.tone ?? 'off'}`}
              aria-hidden="true"
            />
            {site.name}
          </h1>
          {showSetup ? (
            // M5: der Leer-Zustand spricht nicht von "offline", sondern vom Weg.
            <p className="vp-anlage-sentence tone-warn">{SETUP_STATUS_LINE}</p>
          ) : !showHeadSentence ? null : sentence ? (
            <p className={`vp-anlage-sentence tone-${sentence.tone}`}>{sentence.text}</p>
          ) : overviewFailed ? (
            <p className="vp-anlage-sentence tone-off">
              Der Status Ihrer Anlage konnte gerade nicht geladen werden.
            </p>
          ) : (
            <p className="vp-anlage-sentence tone-off">Status wird geladen …</p>
          )}
        </div>
        <div className="vp-anlage-badges">
          {/* R4: the ONE freshness chip of the merged home (head sentence +
              chip; the hero/board dim on `stale` from the same signal). */}
          {/* ⚠ AM TELEFON WOHNT DER CHIP IN EINEM RESERVIERTEN RAHMEN
              (Bewegung · P7). Er trifft erst mit den Übersichts-Daten ein und
              belegt bei 375 px eine eigene Zeile — bis P7 schob dieses
              Eintreffen den halben Bildschirm um 30 px nach unten (gemessener
              größter Einzelsprung des App-Starts, CLS 0,308). Die Zeile steht
              deshalb von Anfang an da; solange der Chip unbekannt ist, hält
              ein UNSICHTBARER Zwilling genau seine Höhe frei. Er misst sich
              selbst — hier steht keine Pixelzahl, die veralten kann.
              Geometrie und Begründung: `components/CockpitBlocks.css`. */}
          {isPhone && !showSetup ? (
            <span className="vp-anlage-chipzeile">
              {chip ? (
                <Badge variant={chip.tone} dot>
                  {chip.label}
                </Badge>
              ) : (
                <Badge aria-hidden="true" style={{ visibility: 'hidden' }}>
                  &nbsp;
                </Badge>
              )}
            </span>
          ) : (
            chip && (
              <Badge variant={chip.tone} dot>
                {chip.label}
              </Badge>
            )
          )}
          {/* Stammdaten-Abzeichen: sie ändern sich nie und beantworten keine
              Tagesfrage — am Telefon wohnen sie in den Einstellungen. */}
          {!isPhone && <Badge variant="tint">{plantKindLabel(site.plantKind)}</Badge>}
          {!isPhone && <NetzladenBadge erlaubt={site.netzladenErlaubt} small />}
          <div className="vp-anlage-actions">
            {/* Anwendungs-Programm Stufe 3 (E4): der Einstieg in den
                Anpassen-Modus wohnt in der Cockpit-Kopfzeile - dort, wo der
                Kunde auf das Cockpit schaut, das er anordnen will. Er erscheint
                nur, wenn es einen Stapel zum Anordnen gibt. */}
            {showStack && !layout.anpassen && (
              <button
                type="button"
                className="vp-gear-btn"
                onClick={layout.start}
                aria-label="Cockpit anpassen"
                title="Cockpit anpassen"
              >
                <Icon name="sliders" size={18} />
              </button>
            )}
            <button
              type="button"
              className="vp-gear-btn"
              onClick={() => onOpenSub('technik')}
              aria-label="Einstellungen"
              title="Einstellungen"
            >
              <Icon name="settings" size={18} />
            </button>
          </div>
        </div>
      </div>

      {ovSite?.batteryWithoutDevice && (
        <div className="vp-alert vp-alert-warn" style={{ marginBottom: 'var(--vp-space-4)' }}>
          {BATTERY_NO_DEVICE_WARNING}
        </div>
      )}

      {decision === 'pending' ? (
        /* ===== Zwischenzustand: die Entscheidungs-Eingaben laufen noch =====
           Der eigentliche Fix (Captain-Nachtrag 06.08.2026): solange
           `/entities`/`/topology`/die Übersichts-Zeile noch laufen, wird KEIN
           Layout gewählt - weder der Modul-Stapel noch der Einrichtungspfad
           noch der „nicht zugeordnet"-Endzustand. Layout-stabil, ruhig,
           begrenzt (siehe die knappe Frist oben in `decisionTimedOut`). */
        <AnlagePending />
      ) : decision === 'error' ? (
        /* ===== Ehrlicher Fehlerzustand statt Dauer-Spinner ================
           Ein entscheidungskritischer Abruf ist fehlgeschlagen ODER die
           knappe Frist ist überschritten - beides wird wie „fertig"
           behandelt: kein endloses Warten, sondern Wiederholen. */
        <ErrorState
          message="Diese Anlage konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : showSetup ? (
        /* ===== M5 · Der Leer-Zustand IST der Einrichtungspfad =============
           Ausprägung "Neu / leer" (report §3): keine Entitäten, keine Modi,
           noch nie Daten - also keine Platzhalter-Karten, sondern die drei
           Schritte zum fertigen EMS. */
        <AnlageSetup
          site={site}
          deviceCount={ovSite?.deviceCount ?? 0}
          onOpenSteuerung={() => onOpenSub('steuerung')}
          onOpenGeraete={() => onOpenSub('modell')}
          onReload={onReload}
          onStay={setSetupPinned}
        />
      ) : showStack ? (
        /* ===== v3 M2 · Das Live-Cockpit ==================================
           Der Hero trägt das BESTEHENDE Energiefluss-Diagramm groß und
           zentral (kein neues "Energie-Rad", BUILD.md §2) mit Autarkie/
           Eigenverbrauch als Ringen, dem Geld des Zeitraums und der einen
           Fahrplan-Zeile. Darunter das Widget-Raster: eine kompakte Kachel
           je Block/Modus, die WIRKLICH etwas beisteuert - ein Tipp öffnet
           ihr Modal (Jetzt | Verlauf). Was kein Modus und keine Quelle
           beisteuert, erscheint nicht - auch nicht als leere Karte.

           Der senkrechte Takt gehoert dem STAPEL, nicht den Bausteinen
           (`.vp-cockpit-stack` in CockpitBlocks.css): vorher brachte jeder
           Block seinen eigenen Aussenabstand mit und drei brachten gar keinen,
           also standen Kacheln, Boersenpreis und Fahrplan mit 0 px
           aneinander.

           `staffel` ist NUR beim ersten Bild dieser Sitzung gesetzt
           (Bewegungs-Programm P4 auf der Erinnerung von P6, `src/staffel.ts`)
           - danach ist es die leere Zeichenkette und der Stapel rendert
           Zeichen fuer Zeichen wie vorher. Der Versatz je Karte samt Deckel 8
           steht als reines CSS im P6-Block von `src/index.css`. */
        <div className={mitStaffel('vp-cockpit-stack', staffel)}>
          {sticky && !layout.anpassen && (
            <MobileStickyHead head={sticky} shown={scrolledPastMoney} />
          )}

          {/* Anwendungs-Programm Stufe 3 · der ANPASSEN-Modus (E4). Er liegt
              INLINE über dem echten Cockpit: der Kunde sieht beim Anordnen,
              was er anordnet. Am Telefon ist es dieselbe Baustein-Menge als
              Liste - auf 375 px ist ein Overlay über einem Diagramm nicht
              bedienbar. */}
          {layout.anpassen && (
            <AnpassenLeiste
              quelle={layout.resolved.quelle}
              resetSatz={layout.resetSatz}
              dirty={layout.dirty}
              saving={layout.saving}
              fehler={layout.fehler}
              band={layout.band}
              alsVorgabe={layout.alsVorgabe}
              onAlsVorgabe={layout.setAlsVorgabe}
              onFertig={layout.fertig}
              onAbbrechen={layout.abbrechen}
              onZuruecksetzen={layout.zuruecksetzen}
            />
          )}
          {/* Anwendungs-Programm Stufe 5: der EINE Weg zu einer eigenen
              Auswertung. Er steht im Anpassen-Modus, weil eine eigene Kachel
              genau das ist - eine Anordnungs-Entscheidung des Kunden. Seit
              Steuerung Stufe 8 steht er dort OHNE vorheriges Einschalten
              (Captain 25.08.2026: „Beobachten/Auswertung nur im Cockpit"). */}
          {layout.anpassen && (
            <div className="vp-eigen-neu">
              <Button
                variant="ghost"
                onClick={() => setEigenDialog({ offen: true, bearbeiten: null })}
                disabled={eigenDeckelSatz(layout.eigene.length) != null}
              >
                + Eigene Auswertung
              </Button>
              {/* vp-agg §2.5/C: „+ Gesamtwert" ist aus der Cockpit-Bühne entfernt
                  und lebt jetzt in „Verlauf › Messwerte" (der gerätefreie
                  Summenwert gehört zu den Auswertungen, nicht auf die Bühne). */}
              <p className="vp-eigen-hinweis">
                {eigenDeckelSatz(layout.eigene.length) ??
                  (layout.eigene.length === 0 ? EIGEN_LEER_SATZ : null)}
              </p>
            </div>
          )}
          {layout.anpassen && isPhone && (
            <AnpassenListe
              zeilen={layout.zeilen}
              onVerschieben={layout.verschieben}
              onSichtbar={layout.setSichtbar}
              onLead={layout.setLead}
              extra={eigenStift}
            />
          )}

          {/* Der Stapel entsteht aus der AUFGELÖSTEN Reihenfolge (Katalog ->
              Preset -> Vorgabe -> Eigen). Ohne gespeicherte Zeile ist das
              Zeichen für Zeichen die frühere hart codierte Folge. */}
          {layout.resolved.order.map((id) => {
            const node = istEigen(id) ? eigenerKnoten(id) : bausteinNodes[id];
            const zeile = layout.anpassen && !isPhone
              ? layout.zeilen.find((z) => z.id === id)
              : undefined;
            if (zeile) {
              return (
                <AnpassenHuelle
                  key={id}
                  zeile={zeile}
                  /* Am Rechner wohnen Geld-Leiste und Steuerungs-Fuß IN der
                     Bühne und haben deshalb keinen eigenen Knoten. Ihre ZEILE
                     erscheint trotzdem - sonst wären sie die einzigen zwei
                     Bausteine, die man am Rechner nicht ausblenden oder
                     hervorheben könnte. */
                  note={node == null ? ortsHinweis(id) : null}
                  onVerschieben={layout.verschieben}
                  onSichtbar={layout.setSichtbar}
                  onLead={layout.setLead}
                  extra={eigenStift(zeile)}
                >
                  {node ?? undefined}
                </AnpassenHuelle>
              );
            }
            if (node == null) return null;
            return <Fragment key={id}>{node}</Fragment>;
          })}

          {/* „Ausgeblendet (n)" bleibt erreichbar (§3.4) - ausblenden darf
              kein Weg ohne Rückweg sein. Am Telefon steht die Reihe schon in
              der Liste oben. */}
          {layout.anpassen && !isPhone && (
            <AusgeblendetZeile
              zeilen={layout.zeilen.filter((z) => !z.sichtbar)}
              onVerschieben={layout.verschieben}
              onSichtbar={layout.setSichtbar}
              onLead={layout.setLead}
              extra={eigenStift}
            />
          )}

          {/* vp-agg §2.5/C: die zusammengestellten Werte (Gesamtwerte) sind aus
              der Cockpit-Bühne nach „Verlauf › Messwerte" umgezogen - Einstieg
              und Anzeige leben dort gemeinsam (`MesswerteSection`). Die
              Cockpit-PV-Rolle unter dem Fluss (§2.4/B) bleibt hiervon
              unberührt. */}
        </div>
      ) : (
        /* ===== Ehrlicher Endzustand: Anlage MIT Daten, ohne Komponenten ====
           Captain-Nachtrag 06.08.2026 §3: der automatische v2-Backfill
           überspringt eine Anlage ohne EINDEUTIGES Gateway-Gerät (kein Gerät
           oder mehrere) - sie bleibt un-migriert, obwohl sie längst misst
           (eine Anlage ohne Gerät landet stattdessen im M5-Einrichtungspfad
           oben). Kein Ersatz-Layout mehr, das gleich wieder verschwindet -
           die NEUE Schale, plus eine ruhige, benennende Zeile und der
           konkrete Hebel (Anlagen-Modell / Zuordnung). */
        <AnlageUnassigned onOpenModell={() => onOpenSub('modell')} />
      )}

      {/* Single-Anlage customers have no Übersicht/Anlagen-Liste; their way to
          a SECOND Anlage is the always-visible "＋ Anlage hinzufügen" action in
          the shell header (App.tsx / AppShell, gated by showAddAnlageButton).
          From the second Anlage on, the list and fleet Übersicht carry it. */}
    </>
  );
}

/**
 * Der ruhige Zwischenzustand, solange die Entscheidungs-Eingaben laufen
 * (Captain-Nachtrag 06.08.2026): weder v1 noch der Modul-Stapel - ein
 * layout-stabiler Platzhalter, der weder wie das eine noch wie das andere
 * aussieht, damit nie eine Fassung zu sehen ist, die gleich wieder
 * verschwindet. Die Kopf-Informationen (Name, Status-Satz, Badges) bleiben
 * unverändert sichtbar - sie sind bereits Teil des immer gerenderten Kopfs.
 */
function AnlagePending() {
  return (
    <div className="vp-anlage-pending" role="status" aria-live="polite" aria-busy="true">
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      <Skeleton height={420} radius="var(--vp-radius-lg)" />
      <div className="vp-anlage-pending-grid">
        <Skeleton height={96} radius="var(--vp-radius-md)" />
        <Skeleton height={96} radius="var(--vp-radius-md)" />
        <Skeleton height={96} radius="var(--vp-radius-md)" />
      </div>
    </div>
  );
}

/**
 * Der ehrliche Endzustand einer Anlage, die MISST, aber (noch) keiner
 * v2-Komponente zugeordnet ist (Captain-Nachtrag 06.08.2026 §"Was entfällt"
 * Punkt 3). Der einzige heute bekannte Weg dorthin: der automatische Backfill
 * überspringt eine Anlage ohne EINDEUTIGES Gateway-Gerät (kein Gerät oder
 * mehrere) - eine Mehr-Geräte-Anlage bleibt dann un-migriert, obwohl sie
 * längst Daten liefert. Der frühere v1-Zonen-Dashboard-Rückfall ist mit
 * dieser Umstellung ENTFALLEN (kein Ersatz-Layout) - an seine Stelle tritt
 * diese ruhige, benennende Zeile mit dem konkreten Hebel, nie ein leeres
 * weißes Feld und nie ein Dauer-Spinner.
 */
function AnlageUnassigned({ onOpenModell }: { onOpenModell: () => void }) {
  return (
    <Card padding="lg" radius="lg" accent="primary" className="vp-resume-banner vp-anlage-unassigned">
      <div style={{ display: 'flex', gap: 'var(--vp-space-4)', flex: '1 1 360px', minWidth: 0 }}>
        <IconTile category="primary" size={48}>
          <Icon name="layers" size={22} />
        </IconTile>
        <div style={{ minWidth: 0 }}>
          <h4 style={{ marginBottom: 4 }}>Diese Anlage ist noch nicht zugeordnet</h4>
          <p className="vp-muted" style={{ margin: 0 }}>
            Ihre Anlage sendet bereits Messwerte, aber die Komponenten (PV, Speicher, Netz)
            fehlen - vermutlich, weil mehrere Geräte gemeldet werden. Ordnen Sie sie unter
            „Komponenten" zu.
          </p>
        </div>
      </div>
      <Button variant="primary" onClick={onOpenModell}>
        Zuordnung öffnen
      </Button>
    </Card>
  );
}
