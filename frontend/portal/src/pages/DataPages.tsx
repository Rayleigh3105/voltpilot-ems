import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import {
  api,
  ApiError,
  type HistoryRange,
  type PriceHistory,
  type SchedulePlan,
  type Site,
  type WeatherForecast,
} from '../api';
import { eurAmount, fmtNum } from '../format';
import { isoDate, PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { SitePicker } from '../components/SitePicker';
import { InfoTip } from '../components/InfoTip';
import { PriceHistoryChart } from '../PriceHistoryChart';
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

/**
 * EUR/MWh -> "12,34 ct/kWh" (÷10), German-formatted. A regular space (not NBSP)
 * so the unit can wrap under the number in a narrow KPI card instead of being
 * clipped; the digits themselves stay grouped by the locale formatter.
 */
function ctPerKwh(eurMwh: number | null | undefined): string {
  if (eurMwh == null) return '-';
  return `${(Number(eurMwh) / 10).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ct/kWh`;
}

/** When the cheapest/most-expensive slot fell, at the range's granularity. */
function whenLabel(iso: string | null, range: HistoryRange): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (range === 'day') {
    return `${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
  }
  if (range === 'week') {
    return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}, ${d.toLocaleTimeString(
      'de-DE',
      { hour: '2-digit', minute: '2-digit' },
    )} Uhr`;
  }
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Short date for the coverage/partial-data note. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function MarktpreisePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const [range, setRange] = useState<HistoryRange>('day');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const at = isoDate(anchor);
  useEffect(() => {
    if (!site) {
      setHistory(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .priceHistory(site.id, range, at)
      .then((h) => active && setHistory(h))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id, range, at]);

  const nextDisabled = shiftAnchor(anchor, range, 1) > new Date();
  const summary = history?.summary ?? null;
  const buckets = history?.buckets ?? [];
  const hasData = buckets.length > 0 && (summary?.count ?? 0) > 0;
  const isDay = range === 'day';

  // Partial coverage: the collector only fetches today+tomorrow, so week/month/
  // year fill in over time. Flag when the stored data starts well after the
  // window opens (older prices were never collected).
  const partialFrom =
    !isDay && hasData && summary?.coverageStart && history
      ? new Date(summary.coverageStart).getTime() - new Date(history.from).getTime() > 36 * 3600 * 1000
      : false;

  return (
    <PageFrame
      title="Marktpreise"
      subtitle={`Börsen-Strompreise (Day-Ahead)${site ? ` - Gebotszone ${site.biddingZone}` : ''}: heute & morgen sowie der Rückblick über Tag, Woche, Monat und Jahr.`}
      {...props}
    >
      {/* Period navigation: Tag/Woche/Monat/Jahr + stepper + Heute. */}
      <div className="vp-page-head" style={{ marginBottom: 'var(--vp-space-5)', alignItems: 'center' }}>
        <div className="vp-seg" role="tablist" aria-label="Zeitraum">
          {PERIOD_RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              className={range === r.id ? 'active' : ''}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="vp-period-nav" style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            className="step"
            aria-label="Vorheriger Zeitraum"
            onClick={() => setAnchor(shiftAnchor(anchor, range, -1))}
          >
            <Icon name="chevron-left" size={18} />
          </button>
          <span className="label">{periodLabel(anchor, range)}</span>
          <button
            type="button"
            className="step"
            aria-label="Nächster Zeitraum"
            disabled={nextDisabled}
            onClick={() => setAnchor(shiftAnchor(anchor, range, 1))}
          >
            <Icon name="chevron-right" size={18} />
          </button>
          <button type="button" className="step" onClick={() => setAnchor(new Date())}>
            Heute
          </button>
        </div>
      </div>

      {loading && (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">Lade Börsenpreise…</p>
        </Card>
      )}
      {err && (
        <div className="vp-alert vp-alert-err">
          Die Börsenpreise konnten nicht geladen werden ({err}). Bitte versuchen Sie es
          später erneut.
        </div>
      )}

      {!loading && !err && !hasData && (
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="dynamic" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="euro" size={24} />
            </IconTile>
            <h3>Keine Börsenpreise in diesem Zeitraum</h3>
            <p>
              {isDay
                ? 'Die Börsenpreise werden automatisch geladen, sobald die Strombörse sie veröffentlicht (täglich am frühen Nachmittag für den Folgetag).'
                : 'Für diesen Zeitraum liegen noch keine gespeicherten Preise vor. Der Rückblick füllt sich Tag für Tag - schauen Sie später wieder vorbei oder wählen Sie einen jüngeren Zeitraum.'}
            </p>
          </div>
        </Card>
      )}

      {!loading && !err && hasData && summary && history && (
        <>
          {/* Headline: relatable ct/kWh average + the cheapest/most expensive slot. */}
          <section className="vp-kpis" aria-label="Preis-Kennzahlen">
            <KpiCard
              icon={<Icon name="euro" size={20} />}
              category="dynamic"
              value={ctPerKwh(summary.avgEurMwh)}
              label="Ø-Preis im Zeitraum"
              title={`Durchschnitt aller Viertelstunden im Zeitraum · ${fmtNum(summary.avgEurMwh, 'EUR/MWh')}`}
            />
            <KpiCard
              icon={<Icon name="trending-down" size={20} />}
              category="battery"
              value={ctPerKwh(summary.minEurMwh)}
              label={`Günstigste Zeit · ${whenLabel(summary.cheapestTs, range)}`}
              title={`Niedrigster Preis im Zeitraum · ${fmtNum(summary.minEurMwh, 'EUR/MWh')}`}
            />
            <KpiCard
              icon={<Icon name="trending-up" size={20} />}
              category="industry"
              value={ctPerKwh(summary.maxEurMwh)}
              label={`Teuerste Zeit · ${whenLabel(summary.mostExpensiveTs, range)}`}
              title={`Höchster Preis im Zeitraum · ${fmtNum(summary.maxEurMwh, 'EUR/MWh')}`}
            />
          </section>

          <section className="vp-section">
            <Card padding="lg" radius="lg">
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                <IconTile category="dynamic" size={40}>
                  <Icon name="euro" size={20} />
                </IconTile>
                <h2>
                  {isDay ? 'Day-Ahead heute & morgen' : 'Preisverlauf'} {site?.biddingZone ?? ''}
                </h2>
                <Badge variant="tint">
                  {history.bucket === 'PT15M'
                    ? '15-Minuten-Takt'
                    : history.bucket === 'PT1H'
                      ? 'stündlich'
                      : 'täglich (Ø, Min/Max)'}
                </Badge>
                <InfoTip title="Was zeigt dieser Zeitraum?" label="Erläuterung Preisverlauf">
                  {isDay
                    ? 'Die Day-Ahead-Preise der Strombörse in 15-Minuten-Schritten. Für heute enthält der Verlauf auch die bereits veröffentlichten Preise für morgen (gestrichelte Linie „Morgen“) - genau diese Preise nutzt Ihr Batterie-Fahrplan.'
                    : 'Der Rückblick fasst die Preise zusammen: die blaue Linie ist der Durchschnitt je ' +
                      (range === 'week' ? 'Stunde' : 'Tag') +
                      ', das hellblaue Band zeigt die Spanne zwischen dem günstigsten und teuersten Preis im jeweiligen Abschnitt.'}
                </InfoTip>
              </div>

              {/* EUR/MWh detail for the professional reader. */}
              <div className="vp-grid vp-grid-stats" style={{ marginBottom: 24 }}>
                <Stat value={fmtNum(summary.minEurMwh, '')} label="Minimum (EUR/MWh)" />
                <Stat value={fmtNum(summary.avgEurMwh, '')} label="Ø im Zeitraum (EUR/MWh)" />
                <Stat value={fmtNum(summary.maxEurMwh, '')} label="Maximum (EUR/MWh)" />
                <Stat
                  value={fmtNum(
                    summary.minEurMwh == null || summary.maxEurMwh == null
                      ? null
                      : summary.maxEurMwh - summary.minEurMwh,
                    '',
                  )}
                  label="Spanne (EUR/MWh)"
                />
              </div>

              <PriceHistoryChart history={history} />

              {partialFrom && summary.coverageStart && (
                <p className="vp-note" style={{ marginTop: 12 }}>
                  Hinweis: Für diesen Zeitraum liegen erst Preise ab dem{' '}
                  {shortDate(summary.coverageStart)} vor - ältere Börsenpreise wurden noch
                  nicht erfasst.
                </p>
              )}
              <p className="vp-note" style={{ marginTop: partialFrom ? 4 : 12 }}>
                Quelle: energy-charts.info (Fraunhofer ISE). {isDay
                  ? 'Ihr Batterie-Fahrplan nutzt genau diese Day-Ahead-Preise.'
                  : 'Preise sind marktweit je Gebotszone (nicht pro Anlage).'}
              </p>
            </Card>
          </section>
        </>
      )}
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
          <InfoTip title="Wie der Fahrplan berechnet wird">
            Der Fahrplan wird für jede Anlage einzeln alle 15 Minuten neu berechnet -
            für die nächsten 24 Stunden in 15-Minuten-Schritten. Ein Optimierungsmodell
            (MILP) plant den Batteriespeicher so, dass Ihre Stromkosten minimal werden:
            laden bei günstigem Strom oder PV-Überschuss, entladen wenn Strom teuer ist,
            Eigenverbrauch maximieren. Eingaben je Anlage sind die Börsen-Day-Ahead-Preise,
            die Last- und PV-Prognose, der aktuelle Ladestand, die Batteriegrenzen und die
            §14a-Netzgrenze. Weil jede Anlage eigene Eingaben hat, erhält sie ihren eigenen
            Fahrplan.
          </InfoTip>
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
