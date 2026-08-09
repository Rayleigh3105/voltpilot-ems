import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import {
  api,
  type Betriebsart,
  type Device,
  type Earnings,
  type EarningsRange,
  type Overview,
  type Site,
} from '../api';
import { DEFAULT_EARNINGS_RANGE } from '../anlage';
import { currentUser } from '../auth';
import { isFleetShell } from '../betriebsart';
import { fleetDailySaved, fleetKind, premiumDetail, premiumIncluded } from '../fleet';
import { anlageRoute, type Route } from '../nav';
import { AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawer';
import { AddDeviceDrawer } from '../components/DeviceDrawers';
import { ErrorState, Skeleton } from '../components/States';
import { EarningsHero, FleetSiteCard, FleetStatusCard } from '../components/FleetOverview';
import { AnlageSeite } from './AnlagenPage';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsPhone } from '../useIsPhone';

/** Background refresh cadence of the live widgets (30 s poll pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness note. */
const TICK_MS = 5_000;

interface UebersichtProps {
  sites: Site[];
  devices: Device[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** U0 shell frame (effective, from /tenant-context); null = unknown. */
  betriebsart?: Betriebsart | null;
}

/**
 * The ADAPTIVE Übersicht landing of the ENDKUNDE (cockpit) shell: with one
 * Anlage the Übersicht IS the Anlagen-Seite (their whole world is one Anlage,
 * no duplicated hero blocks); with 2-3 Anlagen they get the calm CARD overview
 * (money hero, fleet status sentence, per-Anlage cards; a card tap opens that
 * Anlage's page #/anlage/{id}) - by design never a portfolio table (design
 * vp-ems-ui-overhaul §2.3).
 *
 * A BETREIBER tenant does NOT land here: since U5 (#516) the Betreiber shell
 * lands on the real Portfolio page (PortfolioPage - aggregate KPIs + operator
 * table); the shell decision (betriebsart.ts showPortfolioNav) never routes a
 * betreiber to this Übersicht.
 */
export function UebersichtPage(props: UebersichtProps) {
  if (props.sites.length === 0) {
    return <UebersichtEmpty {...props} />;
  }
  if (!isFleetShell(props.betriebsart ?? null, props.sites.length)) {
    const site = props.sites[0];
    return (
      <AnlageSeite
        sites={props.sites}
        devices={props.devices}
        route={anlageRoute(site.id)}
        onNavigate={props.onNavigate}
        onReload={props.onReload}
        isAdmin={props.isAdmin}
        site={site}
        onOpenSub={(sub) => props.onNavigate(anlageRoute(site.id, sub))}
        onBackToList={null}
      />
    );
  }
  return (
    <FleetUebersicht
      {...props}
      onOpenSite={(id) => {
        props.onSelectSite(id);
        props.onNavigate(anlageRoute(id));
      }}
    />
  );
}

/** Empty-state: onboarding entry for customers, neutral notice for admins. */
function UebersichtEmpty({ onReload, isAdmin = false }: UebersichtProps) {
  const [siteDrawer, setSiteDrawer] = useState(false);
  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>{isAdmin ? 'Übersicht' : 'Willkommen bei VoltPilot'}</h1>
          <p>
            {isAdmin
              ? 'Dieser Mandant hat noch keine Anlage.'
              : 'Legen Sie Ihre Anlage an, um Ihr Gerät zu verbinden und Live-Daten, Fahrplan und Erlöse zu sehen.'}
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
              ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheinen hier ihre Live-Daten, Marktpreise, Wetter und der Batterie-Fahrplan. Sie können im Namen des Mandanten eine Anlage anlegen.'
              : 'Eine Anlage bündelt Ihr Gerät, Live-Daten, Marktpreise, Wetter und den Batterie-Fahrplan. Danach verbinden Sie Ihr Gerät in wenigen Schritten.'}
          </p>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
            {isAdmin ? 'Anlage anlegen' : 'Erste Anlage anlegen'}
          </Button>
        </div>
      </Card>
      <AnlageAnlegenDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </>
  );
}

/**
 * Fleet mode: one tenant-wide overview request (30 s background poll like the
 * single-site widgets) renders the hero + status sentence + Anlagen cards. No
 * Ø-Preis KPI here (captain decision - meaningless across bidding zones);
 * price detail lives on each Anlage and on the Marktpreise page.
 */
function FleetUebersicht({
  onOpenSite,
  onReload,
  sites,
}: UebersichtProps & { onOpenSite: (id: string) => void }) {
  const user = currentUser();
  const firstName = (user.name || '').split(/\s+/)[0] || user.name;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnFailed, setEarnFailed] = useState(false);
  // Realized-earnings hero period. Die Voreinstellung ist „Heute" und kommt aus
  // derselben Konstante wie im Cockpit (`anlage.ts`, Captain 2026-07-30) - der
  // Umschalter darf auf zwei Flächen nicht verschieden voreingestellt sein.
  const [range, setRange] = useState<EarningsRange>(DEFAULT_EARNINGS_RANGE);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

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

  // The measured money numbers - refetched when the hero period changes; the
  // hero keeps the previous numbers until the new ones arrive (no flash).
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

  // Freshness tick (5 s) + silent background poll (30 s) - the page keeps its
  // last good data on a poll failure, exactly like the single-site widgets.
  // Der DATEN-Takt läuft über `useFreshnessPoll`, damit die Rückkehr in einen
  // verdeckten Tab (dort drosselt/friert der Browser die Takte ein) SOFORT
  // nachholt statt erst 30 s später - sonst begrüßt die Seite den
  // zurückkehrenden Kunden mit dem Stand von vorhin. Die Uhr tickt daneben
  // weiter (nur Anzeige) und wird beim Nachholen mitgesetzt.
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

  const earningsBySite = new Map((earnings?.sites ?? []).map((s) => [s.id, s]));

  /*
   * Feinschliff (Mobil-Umbau Stufe 4): die zwei Aktions-Knoepfe standen VOR dem
   * Geld-Helden - zwei volle Zeilen Einrichtung ueber der Frage, wegen der man
   * die Uebersicht oeffnet. Am Telefon wandern sie unter die Anlagen-Karten;
   * am Rechner bleiben sie in der Kopfzeile, wo sie neben dem Titel liegen und
   * nichts verdraengen.
   */
  const isPhone = useIsPhone();
  const aktionen = (
    <>
      <Button variant="outline" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
        Anlage anlegen
      </Button>
      <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDeviceDrawer(true)}>
        Gerät hinzufügen
      </Button>
    </>
  );

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Guten Tag, {firstName}</h1>
          <p>Alle Ihre Anlagen auf einen Blick.</p>
        </div>
        {!isPhone && <div className="actions">{aktionen}</div>}
      </div>

      {overview == null && failed ? (
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Die Übersicht konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
      ) : overview == null ? (
        <>
          <div className="vp-fleet-top">
            <Skeleton height={240} radius="var(--vp-radius-lg)" />
            <Skeleton height={120} radius="var(--vp-radius-lg)" />
          </div>
          <section className="vp-section">
            <div className="vp-grid vp-fleet-grid">
              <Skeleton height={190} radius="var(--vp-radius-lg)" />
              <Skeleton height={190} radius="var(--vp-radius-lg)" />
              <Skeleton height={190} radius="var(--vp-radius-lg)" />
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="vp-fleet-top">
            {earnings == null && !earnFailed ? (
              <Skeleton height={300} radius="var(--vp-radius-lg)" />
            ) : (
              <EarningsHero
                kind={fleetKind(overview.sites.map((s) => s.plantKind))}
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
            )}
            <FleetStatusCard overview={overview} now={now} />
          </div>

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
                  earnings={earningsBySite.get(s.id) ?? null}
                  now={now}
                  onOpen={() => onOpenSite(s.id)}
                />
              ))}
            </div>
            {isPhone && <div className="vp-fleet-actions">{aktionen}</div>}
          </section>
        </>
      )}

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
}
