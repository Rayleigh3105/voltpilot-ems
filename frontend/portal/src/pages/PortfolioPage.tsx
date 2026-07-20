import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import { api, type Earnings, type Overview, type Site } from '../api';
import { currentUser } from '../auth';
import { anlageRoute, type Route } from '../nav';
import {
  portfolioKpis,
  profileChip,
  roleBadges,
  siteNowKw,
  siteSavedToday,
  siteSoc,
  siteStatus,
  type RoleBadge,
} from '../portfolio';
import { eurAmount, fmtNum } from '../format';
import { AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawer';
import { AddDeviceDrawer } from '../components/DeviceDrawers';
import { EmptyState, ErrorState, Skeleton } from '../components/States';

/** Background refresh cadence (30 s poll pattern, like the fleet Übersicht). */
const POLL_MS = 30_000;
/** Re-render cadence of the freshness/liveness derivations. */
const TICK_MS = 5_000;

interface PortfolioProps {
  sites: Site[];
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
}

/**
 * The Betreiber PORTFOLIO landing (U5, design vp-ems-ui-overhaul §6 Face 4 +
 * §5.3): an aggregate KPI row (Σ Speicher, Portfolio-SoC, Erlös heute/Monat, Σ
 * vermiedene Spitze) over an operator table (Anlage · Profil · Entitäten · SoC
 * · jetzt · heute € · Status). Portfolio is the Betreiber SHELL, not an AE7
 * profile: every row drills into that Standort's OWN derived cockpit (the same
 * AnlagenPage the Endkunde shell renders - one cockpit, two shells). All
 * wording/derivation lives in the pure `portfolio.ts`; this only renders it.
 */
export function PortfolioPage({ sites, onNavigate, onReload, isAdmin = false }: PortfolioProps) {
  const user = currentUser();
  const firstName = (user.name || '').split(/\s+/)[0] || user.name;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    Promise.all([api.overview(), api.earnings('month')]).then(
      ([o, e]) => {
        if (!active) return;
        setOverview(o);
        setEarnings(e);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Freshness tick (5 s) + silent background poll (30 s): the page keeps its
  // last good data on a poll failure, exactly like the fleet Übersicht.
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(new Date());
      if (++ticks % Math.round(POLL_MS / TICK_MS) === 0) {
        api.overview().then((o) => setOverview(o), () => {});
        api.earnings('month').then((e) => setEarnings(e), () => {});
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const head = (
    <div className="vp-page-head">
      <div className="titles">
        <h1>Portfolio</h1>
        <p>
          {isAdmin
            ? 'Alle Anlagen dieses Mandanten auf einen Blick.'
            : `Guten Tag, ${firstName} - Ihr Anlagen-Portfolio auf einen Blick.`}
        </p>
      </div>
      <div className="actions">
        <Button variant="outline" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
          Anlage anlegen
        </Button>
        <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDeviceDrawer(true)}>
          Gerät hinzufügen
        </Button>
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
          <EmptyState
            icon="building"
            category="industry"
            title={isAdmin ? 'Dieser Mandant hat noch keine Anlage' : 'Noch keine Anlage im Portfolio'}
            description={
              isAdmin
                ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheint sie hier im Portfolio.'
                : 'Legen Sie Ihre erste Anlage an - danach sehen Sie hier Ihr ganzes Portfolio mit Kennzahlen und Status je Anlage.'
            }
            action={
              <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
                Anlage anlegen
              </Button>
            }
          />
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
            message="Das Portfolio konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
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
        <div className="vp-portfolio-kpis">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={92} radius="var(--vp-radius-lg)" />
          ))}
        </div>
        <Skeleton height={280} radius="var(--vp-radius-lg)" style={{ marginTop: 'var(--vp-space-5)' }} />
        {drawers}
      </>
    );
  }

  const kpis = portfolioKpis(overview, earnings, now);
  const earningsBySite = new Map((earnings?.sites ?? []).map((s) => [s.id, s]));

  return (
    <>
      {head}

      <div className="vp-portfolio-kpis">
        <KpiCard
          category="battery"
          icon={<Icon name="battery" size={20} />}
          value={
            kpis.storageKwh == null
              ? '-'
              : `${fmtNum(kpis.storageKwh, 'kWh', 0)} · ${fmtNum(kpis.storageKw, 'kW', 0)}`
          }
          label="Speicher gesamt"
        />
        <KpiCard
          category="dynamic"
          icon={<Icon name="battery-charging" size={20} />}
          value={kpis.portfolioSoc == null ? '-' : fmtNum(kpis.portfolioSoc, '%', 0)}
          label="Ø Ladestand"
        />
        <KpiCard
          category="primary"
          icon={<Icon name="euro" size={20} />}
          value={kpis.erloesHeute == null ? '-' : signedEur(kpis.erloesHeute)}
          label="Erlös heute"
        />
        <KpiCard
          category="primary"
          icon={<Icon name="euro" size={20} />}
          value={kpis.erloesRange == null ? '-' : signedEur(kpis.erloesRange)}
          label="Erlös diesen Monat"
        />
        {kpis.avoidedPeakEur != null && (
          <KpiCard
            category="industry"
            icon={<Icon name="activity" size={20} />}
            value={eurAmount(kpis.avoidedPeakEur)}
            label={
              kpis.avoidedPeakKw != null
                ? `Vermiedene Spitze (${fmtNum(kpis.avoidedPeakKw, 'kW', 0)})`
                : 'Vermiedene Spitze'
            }
          />
        )}
      </div>

      <Card style={{ padding: 0, overflow: 'hidden', marginTop: 'var(--vp-space-5)' }}>
        <table className="vp-table responsive vp-portfolio-table">
          <thead>
            <tr>
              <th>Anlage</th>
              <th>Profil</th>
              <th>Entitäten</th>
              <th>Ladestand</th>
              <th>PV jetzt</th>
              <th>Erlös heute</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {overview.sites.map((s) => {
              const chip = profileChip(s.usageProfile);
              const badges = roleBadges(s.roleCounts);
              const soc = siteSoc(s);
              const nowKw = siteNowKw(s, now);
              const heute = siteSavedToday(earningsBySite.get(s.id) ?? null, now);
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
                  <td data-label="Profil">
                    <Badge variant="tint" className={`vp-profile-chip vp-profile-${chip.kind}`}>
                      {chip.label}
                    </Badge>
                  </td>
                  <td data-label="Entitäten">
                    <EntitiesCell badges={badges} />
                  </td>
                  <td data-label="Ladestand">{soc == null ? '—' : fmtNum(soc, '%', 0)}</td>
                  <td data-label="PV jetzt">{nowKw == null ? '—' : fmtNum(nowKw, 'kW')}</td>
                  <td data-label="Erlös heute">{heute == null ? '—' : signedEur(heute)}</td>
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

      {drawers}
    </>
  );
}

/** The Σ-per-role "Entitäten" cell: an Icon + count per non-zero role. */
function EntitiesCell({ badges }: { badges: RoleBadge[] }) {
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

/** IconTile gradient per role (the design-system category colorway). */
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

/** "+1,57 €" for a gain, "-0,80 €" for a loss; a near-zero value is "+0,00 €". */
function signedEur(v: number): string {
  const value = Math.abs(v) < 0.005 ? 0 : v;
  return value >= 0 ? `+${eurAmount(value)}` : eurAmount(value);
}
