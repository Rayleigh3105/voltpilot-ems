import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import {
  api,
  type Betriebsart,
  type Earnings,
  type EarningsRange,
  type Overview,
  type Site,
} from '../api';
import { DEFAULT_EARNINGS_RANGE } from '../anlage';
import { anwendungLabel } from '../anwendungen';
import { fleetDailySaved, fleetTonalitaet, premiumDetail, premiumIncluded } from '../fleet';
import { eurAmount, fmtNum } from '../format';
import { anlageRoute, type Route } from '../nav';
import {
  modeChips,
  roleBadges,
  siteNowKw,
  siteSavedToday,
  siteSoc,
  siteStatus,
  type ModeChip,
  type RoleBadge,
} from '../portfolio';
import {
  CANONICAL_PORTFOLIO,
  ladestandFussnote,
  portfolioAnwendungen,
  portfolioDichte,
  portfolioKennzahlen,
  tabellenSpalten,
  pvJetztFussnote,
  ruheSatz,
  verfuegbareBausteine,
  type Dichte,
  type PortfolioBausteinId,
  type PortfolioKennzahlen,
} from '../portfolioCockpit';
import { useCockpitLayout } from '../useCockpitLayout';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsPhone } from '../useIsPhone';
import { AnlageAnlegenDrawer } from './AnlageAnlegenDrawer';
import { AnpassenLeiste, AnpassenListe, AnpassenSteuerung } from './CockpitAnpassen';
import { AddDeviceDrawer } from './DeviceDrawers';
import { EarningsHero, FleetSiteCard, FleetStatusCard } from './FleetOverview';
import { ErrorState, Skeleton } from './States';

/** Background refresh cadence (30 s poll pattern, like every fleet surface). */
const POLL_MS = 30_000;
/** Re-render cadence of the freshness/liveness derivations. */
const TICK_MS = 5_000;

/**
 * DAS PORTFOLIO-COCKPIT (Anwendungs-Programm Stufe 4, Captain-Entscheid E5):
 * EINE Kunden-Fläche für jeden Mehr-Anlagen-Kunden, komponiert aus den
 * Anwendungen seiner Anlagen — die frühere feste `PortfolioPage` (Geld- und
 * Speicher-Kacheln zuerst) und die `FleetUebersicht` (ruhige Karten) sind
 * darin aufgegangen.
 *
 * **Die Betriebsart steuert nur noch DICHTE und TONALITÄT.** `betreiber`
 * bekommt die Tabelle (er vergleicht viele Anlagen in einer Zeile), jeder
 * andere die Karten; das ist die sichtbare U0/U5-Änderung für Endkunden ab
 * zwei Anlagen, und sie ist gewollt (E5).
 *
 * **Alles Rechnende liegt im reinen `portfolioCockpit.ts`**, die Anordnung im
 * ebenso reinen `cockpitLayout.ts` — hier wird nur gezeichnet. Der
 * Anpassen-Modus ist WÖRTLICH derselbe wie am Anlagen-Cockpit (`useCockpitLayout`
 * + `CockpitAnpassen`), nur mit der Fläche `portfolio` und dem Kunden-Scope:
 * ein zweiter Editor wäre eine zweite Bedienlogik für dieselbe Handlung.
 */
export interface PortfolioCockpitProps {
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** U0-Rahmen (effektiv, aus /tenant-context); null = unbekannt → Karten. */
  betriebsart?: Betriebsart | null;
  /** Der Kopf der Seite — Titel und Aktionen kommen von der Route. */
  kopf: { titel: string; satz: string };
  /** Der Kundenname für das Admin-Band des Anpassen-Modus. */
  kunde?: string | null;
}

export function PortfolioCockpit({
  sites,
  onNavigate,
  onReload,
  isAdmin = false,
  betriebsart = null,
  kopf,
  kunde = null,
}: PortfolioCockpitProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  const [earnFailed, setEarnFailed] = useState(false);
  const [range, setRange] = useState<EarningsRange>(DEFAULT_EARNINGS_RANGE);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);
  const isPhone = useIsPhone();

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
  }, [reloadKey]);

  useEffect(() => {
    let active = true;
    api.earnings(range).then(
      (e) => {
        if (!active) return;
        setEarnings(e);
        setEarnFailed(false);
      },
      () => {
        if (active) setEarnFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey, range]);

  const rangeRef = useRef(range);
  rangeRef.current = range;
  useFreshnessPoll(() => {
    setNow(new Date());
    api.overview().then(
      (o) => setOverview(o),
      () => {},
    );
    api.earnings(rangeRef.current).then(
      (e) => setEarnings(e),
      () => {},
    );
  }, POLL_MS);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const dichte = portfolioDichte(betriebsart);
  const configById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const kennzahlen = useMemo(
    () => portfolioKennzahlen(overview, earnings, now),
    [overview, earnings, now],
  );
  const anwendungen = useMemo(
    () => portfolioAnwendungen(overview, configById),
    [overview, configById],
  );
  const verfuegbar = useMemo(
    () =>
      verfuegbareBausteine({
        anwendungen,
        kennzahlen,
        anlagen: overview?.sites.length ?? 0,
      }),
    [anwendungen, kennzahlen, overview],
  );

  const layout = useCockpitLayout<PortfolioBausteinId>({
    schluessel: 'portfolio',
    flaeche: 'portfolio',
    canonical: CANONICAL_PORTFOLIO,
    verfuegbar,
    // Das Portfolio hat keine Bühne: es gibt dort keinen lead-fähigen
    // Baustein, also auch keinen Stern (der Server lehnt jeden Lead ab).
    blocks: [],
    kunde,
    quelle: {
      laden: () => api.tenantCockpitLayout('portfolio'),
      speichern: (layer, document) =>
        api.saveTenantCockpitLayout(layer, document, 'portfolio'),
      zuruecksetzen: (layer) => api.resetTenantCockpitLayout(layer, 'portfolio'),
    },
  });

  const aktionen = (
    <>
      <Button
        variant="outline"
        iconLeft={<Icon name="plus" size={18} />}
        onClick={() => setSiteDrawer(true)}
      >
        Anlage anlegen
      </Button>
      <Button
        variant="primary"
        iconLeft={<Icon name="plus" size={18} />}
        onClick={() => setDeviceDrawer(true)}
      >
        Gerät hinzufügen
      </Button>
    </>
  );

  const head = (
    <div className="vp-page-head">
      <div className="titles">
        <h1>{kopf.titel}</h1>
        <p>{kopf.satz}</p>
      </div>
      <div className="actions">
        {!isPhone && aktionen}
        {overview != null && !layout.anpassen && (
          <Button
            variant="ghost"
            iconLeft={<Icon name="sliders" size={18} />}
            onClick={layout.start}
          >
            Anpassen
          </Button>
        )}
      </div>
    </div>
  );

  const drawers = (
    <>
      <AnlageAnlegenDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        existingSites={sites}
        onChanged={(createdSiteId) => {
          onReload(createdSiteId);
          setReloadKey((k) => k + 1);
        }}
      />
      <AddDeviceDrawer
        open={deviceDrawer}
        onClose={() => setDeviceDrawer(false)}
        sites={sites}
        onClaimed={() => {
          onReload();
          setReloadKey((k) => k + 1);
        }}
      />
    </>
  );

  if (sites.length === 0) {
    return (
      <>
        {head}
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="solar" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="sun" size={24} />
            </IconTile>
            <h3>{isAdmin ? 'Dieser Mandant hat noch keine Anlage' : 'Noch keine Anlage'}</h3>
            <p>
              {isAdmin
                ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheint sie hier.'
                : 'Legen Sie Ihre erste Anlage an — danach sehen Sie hier alle Ihre Anlagen mit ihren Kennzahlen und ihrem Zustand.'}
            </p>
            <Button
              variant="primary"
              iconLeft={<Icon name="plus" size={18} />}
              onClick={() => setSiteDrawer(true)}
            >
              {isAdmin ? 'Anlage anlegen' : 'Erste Anlage anlegen'}
            </Button>
          </div>
        </Card>
        {drawers}
      </>
    );
  }

  if (overview == null && failed) {
    return (
      <>
        {head}
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Ihr Portfolio konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
        {drawers}
      </>
    );
  }

  if (overview == null) {
    return (
      <>
        {head}
        <div className="vp-fleet-top">
          <Skeleton height={240} radius="var(--vp-radius-lg)" />
          <Skeleton height={120} radius="var(--vp-radius-lg)" />
        </div>
        <div className="vp-portfolio-kpis" style={{ marginTop: 'var(--vp-space-5)' }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={92} radius="var(--vp-radius-lg)" />
          ))}
        </div>
        {drawers}
      </>
    );
  }

  const zeileVon = (id: PortfolioBausteinId) => layout.zeilen.find((z) => z.id === id) ?? null;
  const anlagenZahl = overview.sites.length;
  const ruhe = ruheSatz(layout.resolved.order);

  /** Ein Baustein IM Anpassen-Modus: seine Bedienelemente über dem Inhalt. */
  const huelle = (id: PortfolioBausteinId, inhalt: React.ReactNode) => {
    const zeile = zeileVon(id);
    if (!layout.anpassen || zeile == null || isPhone) return inhalt;
    return (
      <section className="vp-anpassen-huelle" aria-label={zeile.label} key={id}>
        <AnpassenSteuerung
          zeile={zeile}
          onVerschieben={layout.verschieben}
          onSichtbar={layout.setSichtbar}
          onLead={() => {}}
        />
        <div className="vp-anpassen-inhalt">{inhalt}</div>
      </section>
    );
  };

  const hero =
    earnings == null && !earnFailed ? (
      <Skeleton height={300} radius="var(--vp-radius-lg)" />
    ) : (
      <EarningsHero
        kind={fleetTonalitaet(
          overview.sites.map((s) => ({
            profil: configById.get(s.id)?.profil ?? null,
            plantKind: s.plantKind,
          })),
        )}
        money={earnings ? earnings.totals : null}
        dailySaved={earnings ? fleetDailySaved(earnings.sites) : []}
        range={range}
        dataRange={earnings?.range}
        onRange={setRange}
        now={now}
        unavailable={earnFailed}
        premium={earnings ? premiumIncluded(earnings.sites) : false}
        premiumDetail={earnings ? premiumDetail(earnings.sites) : null}
      />
    );

  const statusKarte = <FleetStatusCard overview={overview} now={now} />;

  /*
   * Die DICHTE-Regel für den Kopf der Karten-Fassung: Status und Geld stehen
   * nebeneinander, solange sie kanonisch benachbart sind (der Normalfall) —
   * genau das Bild, das die frühere `FleetUebersicht` hatte. Verschiebt der
   * Kunde das Geld woanders hin, rendert es an SEINER Stelle als voller Held
   * und der Status steht allein; die Anordnung gewinnt vor der Kosmetik.
   */
  const paarOben =
    dichte === 'karten' &&
    !layout.anpassen &&
    layout.resolved.order[0] === 'flotten-status' &&
    layout.resolved.order[1] === 'erloese';

  const knoten: React.ReactNode[] = [];
  let kacheln: React.ReactNode[] = [];
  const kachelBlockSchliessen = () => {
    if (kacheln.length === 0) return;
    knoten.push(
      <div className="vp-portfolio-kpis" key={`kpis-${knoten.length}`}>
        {kacheln}
      </div>,
    );
    kacheln = [];
  };

  for (const id of layout.resolved.order) {
    if (paarOben && (id === 'flotten-status' || id === 'erloese')) continue;
    const kachel = kachelFuer(id, kennzahlen, dichte, anlagenZahl);
    if (kachel != null) {
      kacheln.push(
        layout.anpassen && !isPhone ? (
          huelle(id, kachel)
        ) : (
          <div key={id} className="vp-portfolio-kachel">
            {kachel}
          </div>
        ),
      );
      continue;
    }
    kachelBlockSchliessen();
    if (id === 'flotten-status') {
      knoten.push(<div key={id}>{huelle(id, statusKarte)}</div>);
    } else if (id === 'erloese') {
      knoten.push(<div key={id}>{huelle(id, hero)}</div>);
    } else if (id === 'anlagen') {
      knoten.push(
        <div key={id}>
          {huelle(
            id,
            dichte === 'tabelle' ? (
              <AnlagenTabelle
                overview={overview}
                earnings={earnings}
                sites={sites}
                now={now}
                onNavigate={onNavigate}
              />
            ) : (
              <AnlagenKarten
                overview={overview}
                earnings={earnings}
                now={now}
                onOpen={(sid) => onNavigate(anlageRoute(sid))}
              />
            ),
          )}
        </div>,
      );
    }
  }
  kachelBlockSchliessen();

  return (
    <>
      {head}
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
          // Das Portfolio hat keine Bühne, also auch keinen Stern.
          mitStern={false}
        />
      )}
      {layout.anpassen && isPhone && (
        <AnpassenListe
          zeilen={layout.zeilen}
          onVerschieben={layout.verschieben}
          onSichtbar={layout.setSichtbar}
          onLead={() => {}}
        />
      )}

      {paarOben && (
        <div className="vp-fleet-top">
          {hero}
          {statusKarte}
        </div>
      )}
      {ruhe && (
        <Card padding="lg" radius="lg" className="vp-portfolio-ruhe">
          <p className="vp-muted">{ruhe}</p>
        </Card>
      )}
      {knoten}
      {isPhone && <div className="vp-fleet-actions">{aktionen}</div>}
      {drawers}
    </>
  );
}

/**
 * Die Kachel eines Bausteins — oder `null`, wenn er keine ist (Status, Geld in
 * der Karten-Dichte, die Anlagen-Liste). Jede Kachel rendert nur, was sie
 * belegen kann: `portfolioKennzahlen` liefert `null` statt einer erfundenen 0,
 * und `verfuegbareBausteine` hat solche Bausteine schon vorher aussortiert.
 */
function kachelFuer(
  id: PortfolioBausteinId,
  k: PortfolioKennzahlen,
  dichte: Dichte,
  anlagen: number,
): React.ReactNode {
  switch (id) {
    case 'erloese':
      // In der Karten-Dichte ist das Geld der HELD (das frühere
      // FleetUebersicht-Bild), in der Tabellen-Dichte zwei Kacheln.
      return dichte === 'karten' ? null : (
        <div className="vp-portfolio-kpi-paar">
          <KpiCard
            category="primary"
            icon={<Icon name="euro" size={20} />}
            value={k.erloesHeuteEur == null ? '—' : signedEur(k.erloesHeuteEur)}
            label="Erlös heute"
          />
          <KpiCard
            category="primary"
            icon={<Icon name="euro" size={20} />}
            value={k.erloesZeitraumEur == null ? '—' : signedEur(k.erloesZeitraumEur)}
            label="Erlös im Zeitraum"
          />
        </div>
      );
    case 'speicher':
      return (
        <div className="vp-portfolio-kpi-paar">
          <KpiCard
            category="battery"
            icon={<Icon name="battery" size={20} />}
            value={k.speicherKwh == null ? '—' : fmtNum(k.speicherKwh, 'kWh', 0)}
            label={
              <>
                Speicher gesamt
                {k.speicherKw != null && (
                  <span className="vp-kpi-second">
                    {fmtNum(k.speicherKw, 'kW', 0)} Ladeleistung
                  </span>
                )}
              </>
            }
          />
          {k.ladestandPct != null && (
            <KpiCard
              category="dynamic"
              icon={<Icon name="battery-charging" size={20} />}
              value={fmtNum(k.ladestandPct, '%', 0)}
              label={
                <>
                  Ladestand
                  <span className="vp-kpi-second">{ladestandFussnote(k, anlagen)}</span>
                </>
              }
            />
          )}
        </div>
      );
    case 'lastspitzen':
      return (
        <KpiCard
          category="industry"
          icon={<Icon name="activity" size={20} />}
          value={k.vermiedeneSpitzeEur == null ? '—' : eurAmount(k.vermiedeneSpitzeEur)}
          label={
            k.vermiedeneSpitzeKw != null
              ? `Vermiedene Spitze (${fmtNum(k.vermiedeneSpitzeKw, 'kW', 0)})`
              : 'Vermiedene Spitze'
          }
        />
      );
    case 'ladepunkte':
      return (
        <KpiCard
          category="ev"
          icon={<Icon name="zap" size={20} />}
          value={k.ladepunkte == null ? '—' : String(k.ladepunkte)}
          label="Ladepunkte"
        />
      );
    case 'pv-jetzt':
      return (
        <KpiCard
          category="solar"
          icon={<Icon name="sun" size={20} />}
          value={k.pvJetztKw == null ? '—' : fmtNum(k.pvJetztKw, 'kW')}
          label={
            <>
              PV jetzt
              {pvJetztFussnote(k, anlagen) && (
                <span className="vp-kpi-second">{pvJetztFussnote(k, anlagen)}</span>
              )}
            </>
          }
        />
      );
    case 'erzeugung-heute':
      return (
        <KpiCard
          category="solar"
          icon={<Icon name="sun" size={20} />}
          value={k.erzeugungHeuteKwh == null ? '—' : fmtNum(k.erzeugungHeuteKwh, 'kWh', 0)}
          label="Erzeugung heute"
        />
      );
    case 'verbrauch-heute':
      return (
        <KpiCard
          category="industry"
          icon={<Icon name="home" size={20} />}
          value={k.verbrauchHeuteKwh == null ? '—' : fmtNum(k.verbrauchHeuteKwh, 'kWh', 0)}
          label="Verbrauch heute"
        />
      );
    case 'netz-heute':
      return (
        <div className="vp-portfolio-kpi-paar">
          <KpiCard
            category="industry"
            icon={<Icon name="activity" size={20} />}
            value={k.bezugHeuteKwh == null ? '—' : fmtNum(k.bezugHeuteKwh, 'kWh', 0)}
            label="Netzbezug heute"
          />
          <KpiCard
            category="solar"
            icon={<Icon name="activity" size={20} />}
            value={k.einspeisungHeuteKwh == null ? '—' : fmtNum(k.einspeisungHeuteKwh, 'kWh', 0)}
            label="Einspeisung heute"
          />
        </div>
      );
    default:
      return null;
  }
}

/** Die Anlagen als KARTEN — die ruhige Dichte (Endkunde, unbekannter Rahmen). */
function AnlagenKarten({
  overview,
  earnings,
  now,
  onOpen,
}: {
  overview: Overview;
  earnings: Earnings | null;
  now: Date;
  onOpen: (siteId: string) => void;
}) {
  const bySite = new Map((earnings?.sites ?? []).map((s) => [s.id, s]));
  return (
    <section className="vp-section" aria-label="Meine Anlagen">
      <div className="vp-section-head">
        <IconTile category="solar" size={40}>
          <Icon name="sun" size={20} />
        </IconTile>
        <h2>Meine Anlagen</h2>
        <Badge variant="tint">{overview.sites.length}</Badge>
      </div>
      <div className="vp-grid vp-fleet-grid">
        {overview.sites.map((s) => (
          <FleetSiteCard
            key={s.id}
            site={s}
            earnings={bySite.get(s.id) ?? null}
            now={now}
            onOpen={() => onOpen(s.id)}
          />
        ))}
      </div>
    </section>
  );
}

/** Die Anlagen als TABELLE — die Betreiber-Dichte (viele Anlagen, eine Zeile). */
function AnlagenTabelle({
  overview,
  earnings,
  sites,
  now,
  onNavigate,
}: {
  overview: Overview;
  earnings: Earnings | null;
  sites: Site[];
  now: Date;
  onNavigate: (route: Route) => void;
}) {
  const bySite = new Map((earnings?.sites ?? []).map((s) => [s.id, s]));
  const configById = new Map(sites.map((s) => [s.id, s]));
  // Eine Spalte, die KEINE Anlage füllen kann, wird weggelassen statt als
  // Reihe von „—" hingestellt (die Kachel-Regel, eine Ebene tiefer).
  const spalten = tabellenSpalten(overview, earnings, now);
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table className="vp-table responsive vp-portfolio-table">
        <thead>
          <tr>
            <th>Anlage</th>
            <th>Anwendungen</th>
            <th>Komponenten</th>
            {spalten.ladestand && <th>Ladestand</th>}
            <th>PV jetzt</th>
            {spalten.erloes && <th>Erlös heute</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {overview.sites.map((s) => {
            const chips = modeChips(s, configById.get(s.id) ?? null);
            const badges = roleBadges(s.roleCounts);
            const soc = siteSoc(s);
            const nowKw = siteNowKw(s, now);
            const heute = siteSavedToday(bySite.get(s.id) ?? null, now);
            const status = siteStatus(s);
            return (
              <tr key={s.id} className="clickable" onClick={() => onNavigate(anlageRoute(s.id))}>
                <td data-label="Anlage">
                  <div className="vp-cell-main">
                    <b>{s.name}</b>
                    {s.batteryWithoutDevice && (
                      <span className="vp-cell-sub vp-portfolio-warn">
                        <Icon name="alert-triangle" size={13} /> Speicher ohne Gerät
                      </span>
                    )}
                  </div>
                </td>
                <td data-label="Anwendungen">
                  <AnwendungenZelle site={s} chips={chips} />
                </td>
                <td data-label="Komponenten">
                  <KomponentenZelle badges={badges} />
                </td>
                {spalten.ladestand && (
                  <td data-label="Ladestand">{soc == null ? '—' : fmtNum(soc, '%', 0)}</td>
                )}
                <td data-label="PV jetzt">{nowKw == null ? '—' : fmtNum(nowKw, 'kW')}</td>
                {spalten.erloes && (
                  <td data-label="Erlös heute">{heute == null ? '—' : signedEur(heute)}</td>
                )}
                <td data-label="Status">
                  <Badge variant={status.tone} dot>
                    {status.label}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Die Anwendungs-Zelle. Sie nennt seit Stufe 4 die AKTIVEN Anwendungen des
 * Servers, wo die Zeile sie trägt — sie kennen den gespeicherten Kundenwillen,
 * den die reine M0-Projektion nicht sehen kann. Ohne das Feld (älteres
 * Backend) bleibt es bei den Modus-Chips, nie bei einer Erfindung.
 */
function AnwendungenZelle({
  site,
  chips,
}: {
  site: Overview['sites'][number];
  chips: ModeChip[];
}) {
  const namen = site.anwendungen
    ? site.anwendungen.map((id) => ({ key: id, kind: id, label: anwendungLabel(id) }))
    : chips;
  if (namen.length === 0) {
    return <span className="vp-muted">—</span>;
  }
  return (
    <div className="vp-mode-chips">
      {namen.map((c) => (
        <span key={c.key} className={`vp-mode-chip vp-mode-${c.kind}`}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** Die Σ-per-Rolle-Zelle: ein Icon + Zähler je nicht-leerer Rolle. */
function KomponentenZelle({ badges }: { badges: RoleBadge[] }) {
  if (badges.length === 0) {
    return <span className="vp-muted">—</span>;
  }
  return (
    <div className="vp-entity-badges">
      {badges.map((b) => (
        <span key={b.role} className="vp-entity-badge" title={`${b.count} ${b.label}`}>
          <IconTile category={iconTileCategory(b.role)} size={22}>
            <Icon name={b.icon} size={13} />
          </IconTile>
          <span className="vp-entity-count">{b.count}</span>
        </span>
      ))}
    </div>
  );
}

function iconTileCategory(role: RoleBadge['role']): 'solar' | 'battery' | 'ev' | 'industry' {
  switch (role) {
    case 'pv':
      return 'solar';
    case 'storage':
      return 'battery';
    case 'consumer':
      return 'ev';
    default:
      return 'industry';
  }
}

/** „+1,57 €" für einen Gewinn, „-0,80 €" für einen Verlust. */
function signedEur(v: number): string {
  const value = Math.abs(v) < 0.005 ? 0 : v;
  return value >= 0 ? `+${eurAmount(value)}` : eurAmount(value);
}
