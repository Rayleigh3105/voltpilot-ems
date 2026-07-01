import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import {
  api,
  ApiError,
  type PriceSeries,
  type SchedulePlan,
  type Site,
  type WeatherForecast,
} from '../api';
import { eurAmount, fmtNum } from '../format';
import { SitePicker } from '../components/SitePicker';
import { PriceChart } from '../PriceChart';
import { WeatherChart } from '../WeatherChart';
import { ScheduleChart } from '../ScheduleChart';

/** Shared frame for the site-scoped data pages (picker + load/error states). */
function useSiteData<T>(
  site: Site | null,
  load: (siteId: string) => Promise<T>,
): { data: T | null; loading: boolean; err: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!site) {
      setData(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    load(site.id)
      .then((d) => active && setData(d))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id]);

  return { data, loading, err };
}

function PageFrame({
  title,
  subtitle,
  sites,
  selectedSite,
  onSelectSite,
  children,
}: {
  title: string;
  subtitle: string;
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="actions">
          <SitePicker sites={sites} value={selectedSite} onChange={onSelectSite} />
        </div>
      </div>
      {sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch kein Standort - legen Sie zuerst unter „Standorte“ einen an.
          </p>
        </Card>
      ) : (
        children
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export function MarktpreisePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const { data: series, loading, err } = useSiteData<PriceSeries>(site, (id) => api.prices(id));

  const points = series?.points ?? [];
  const nums = points.map((p) => p.priceEurMwh).filter((v): v is number => v != null);
  const min = nums.length ? Math.min(...nums) : null;
  const max = nums.length ? Math.max(...nums) : null;
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;

  return (
    <PageFrame
      title="Marktpreise"
      subtitle={`Börsenpreise für heute und morgen${site ? ` - Gebotszone ${site.biddingZone}` : ''}, in 15-Minuten-Auflösung.`}
      {...props}
    >
      <Card padding="lg" radius="lg">
        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
          <IconTile category="dynamic" size={40}>
            <Icon name="euro" size={20} />
          </IconTile>
          <h2>Day-Ahead {site?.biddingZone ?? ''}</h2>
          {series?.resolution && (
            <Badge variant="tint">{series.resolution === 'PT15M' ? '15-Minuten-Takt' : 'Stunden-Takt'}</Badge>
          )}
        </div>
        {loading && <p className="vp-muted">Lade Börsenpreise…</p>}
        {err && (
          <div className="vp-alert vp-alert-err">
            Die Börsenpreise konnten nicht geladen werden ({err}). Bitte versuchen Sie es
            später erneut.
          </div>
        )}
        {!loading && !err && points.length === 0 && (
          <p className="vp-muted">
            Noch keine Börsenpreise. Sie werden automatisch geladen, sobald die Strombörse
            sie veröffentlicht (täglich am frühen Nachmittag).
          </p>
        )}
        {!loading && !err && points.length > 0 && (
          <>
            <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
              <Stat value={fmtNum(min, '')} label="Minimum (EUR/MWh)" />
              <Stat value={fmtNum(avg, '')} label="Ø im Zeitraum (EUR/MWh)" />
              <Stat value={fmtNum(max, '')} label="Maximum (EUR/MWh)" />
              <Stat value={fmtNum(avg == null ? null : avg / 10, '', 2)} label="Ø in ct/kWh" />
            </div>
            <PriceChart series={series!} />
            <p className="vp-note" style={{ marginTop: 12 }}>
              Quelle: energy-charts.info (Fraunhofer ISE). Ihr Batterie-Fahrplan nutzt genau
              diese Preise.
            </p>
          </>
        )}
      </Card>
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------

export function WetterPage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const { data: forecast, loading, err } = useSiteData<WeatherForecast>(site, (id) => api.weather(id));

  const points = forecast?.points ?? [];
  const now = points[0] ?? null;
  const peakGhi = points.reduce<number | null>(
    (m, p) => (p.ghiWM2 != null && (m == null || p.ghiWM2 > m) ? p.ghiWM2 : m),
    null,
  );

  return (
    <PageFrame
      title="Wetter"
      subtitle={`Wettervorhersage${site ? ` für ${site.name}` : ''} - Grundlage der PV-Prognose.`}
      {...props}
    >
      <Card padding="lg" radius="lg">
        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
          <IconTile category="solar" size={40}>
            <Icon name="sun" size={20} />
          </IconTile>
          <h2>Vorhersage {site?.name ?? ''}</h2>
        </div>
        {loading && <p className="vp-muted">Lade Wettervorhersage…</p>}
        {err && (
          <div className="vp-alert vp-alert-err">
            Die Wettervorhersage konnte nicht geladen werden ({err}). Bitte versuchen Sie es
            später erneut.
          </div>
        )}
        {!loading && !err && points.length === 0 && (
          <p className="vp-muted">
            Noch keine Vorhersage. Sie wird automatisch geladen - der Standort benötigt
            dafür Koordinaten (unter „Standorte“ ergänzbar).
          </p>
        )}
        {!loading && !err && points.length > 0 && (
          <>
            <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
              <Stat value={fmtNum(now?.temperatureC, '°C')} label="Temperatur (nächste Stunde)" />
              <Stat value={fmtNum(now?.cloudCoverPct, '%', 0)} label="Bewölkung" />
              <Stat value={fmtNum(peakGhi, '', 0)} label="Max. Einstrahlung (W/m²)" />
              <Stat value={fmtNum(points.length, 'h', 0)} label="Vorhersagehorizont" />
            </div>
            <WeatherChart points={points} />
            <p className="vp-note" style={{ marginTop: 12 }}>
              Quelle: Open-Meteo, stündlich aktualisiert. Die Einstrahlung (GHI) fließt in
              die PV-Prognose Ihres Standorts ein.
            </p>
          </>
        )}
      </Card>
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------

export function FahrplanPage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const { data: plan, loading, err } = useSiteData<SchedulePlan>(site, (id) => api.schedule(id));

  const slots = plan?.slots ?? [];
  const today = new Date().toDateString();
  const savingsToday = slots
    .filter((s) => new Date(s.start).toDateString() === today)
    .reduce((sum, s) => sum + ((s.baselineCostEur ?? 0) - (s.costEur ?? 0)), 0);
  const savingsTotal = plan?.savingsEur ?? 0;
  const chargeKwh = slots.reduce((sum, s) => sum + Math.max(s.batteryKw ?? 0, 0), 0) / 4;
  const dischargeKwh = slots.reduce((sum, s) => sum + Math.max(-(s.batteryKw ?? 0), 0), 0) / 4;
  const generatedAt = plan?.generatedAt
    ? new Date(plan.generatedAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <PageFrame
      title="Fahrplan"
      subtitle={`Kostenoptimaler Batterie-Fahrplan${site ? ` für ${site.name}` : ''} aus Börsenpreisen und Prognosen.`}
      {...props}
    >
      <Card padding="lg" radius="lg">
        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
          <IconTile category="battery" size={40}>
            <Icon name="battery-charging" size={20} />
          </IconTile>
          <h2>Fahrplan {site?.name ?? ''}</h2>
        </div>
        {loading && <p className="vp-muted">Lade Fahrplan…</p>}
        {err && (
          <div className="vp-alert vp-alert-err">
            Der Fahrplan konnte nicht geladen werden ({err}). Bitte versuchen Sie es später
            erneut.
          </div>
        )}
        {!loading && !err && slots.length === 0 && (
          <p className="vp-muted">
            Noch kein Fahrplan. Der Optimierer plant Standorte mit Batteriespeicher
            alle 15 Minuten neu, sobald Day-Ahead-Preise vorliegen.
          </p>
        )}
        {!loading && !err && slots.length > 0 && (
          <>
            <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
              <Stat
                value={eurAmount(savingsToday)}
                label="Heute geplant gespart (ggü. ohne Speicher)"
              />
              <Stat value={eurAmount(savingsTotal)} label="Ersparnis im Planungszeitraum" />
              <Stat value={fmtNum(chargeKwh, 'kWh')} label="Geplant laden" />
              <Stat value={fmtNum(dischargeKwh, 'kWh')} label="Geplant entladen" />
            </div>
            <ScheduleChart plan={plan!} />
            <p className="vp-note" style={{ marginTop: 12 }}>
              Kostenoptimaler Batterie-Fahrplan in 15-Minuten-Schritten aus Börsenpreisen
              und Last-/PV-Prognose{generatedAt ? `, erstellt am ${generatedAt} Uhr` : ''}.
              Ihr Gerät begrenzt jeden Sollwert zusätzlich lokal (u. a. §14a EnWG).
            </p>
          </>
        )}
      </Card>
    </PageFrame>
  );
}
