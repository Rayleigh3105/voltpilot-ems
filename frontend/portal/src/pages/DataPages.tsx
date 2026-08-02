import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import {
  api,
  ApiError,
  ONLINE_WINDOW_MS,
  type ControlStatus,
  type CurtailmentStatus,
  type HistoryRange,
  type PriceHistory,
  type SchedulePlan,
  type Site,
  type TelemetryPoint,
  type WeatherForecast,
} from '../api';
import { eurAmount, fmtNum } from '../format';
import { isoDate, PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { SitePicker } from '../components/SitePicker';
import { InfoTip } from '../components/InfoTip';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { PriceHistoryChart } from '../PriceHistoryChart';
import { WeatherChart } from '../WeatherChart';
import { hoursAhead, nextHourIndex } from '../weather';
import { ScheduleChart } from '../ScheduleChart';
import { bankedValueLine, horizonHint, planStaleNote, savingsTodayEur } from '../schedule';
import { FALLBACK_14A_NOTE, FORECAST_FOOTNOTE, phases } from '../fahrplanWhy';
import { FahrplanWhyPanel } from '../components/FahrplanWhy';
import { filmKicker, filmRows, naechsterEinsatz } from '../fahrplanFilm';
import { jetztHeld } from '../fahrplanJetzt';
import { JetztHeld, TagesFilm } from '../components/FahrplanJetzt';
import { controlReasonSlot } from '../control';
import { curtailTruth } from '../curtailment';
import { buildSnapshot } from '../live';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { ProvBadge } from '../components/HistorieWelt';

/** Shared frame for the site-scoped data pages (picker + load/error states). */
function useSiteData<T>(
  site: Site | null,
  load: (siteId: string) => Promise<T>,
): { data: T | null; loading: boolean; err: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [site?.id, reloadKey]);

  return { data, loading, err, reload: () => setReloadKey((k) => k + 1) };
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
            Noch keine Anlage - legen Sie zuerst unter „Meine Anlage“ eine an.
          </p>
        </Card>
      ) : !sites.some((s) => s.id === selectedSite) ? (
        // Sites exist but the selection hasn't resolved yet: show a loading
        // state, not the "you have no prices/weather" empty copy (m2).
        <Card padding="lg" radius="lg">
          <ChartCardSkeleton />
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
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [site?.id, range, at, reloadKey]);

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
          <ChartCardSkeleton />
        </Card>
      )}
      {err && (
        <ErrorState
          message={`Die Börsenpreise konnten nicht geladen werden (${err}).`}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
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
              <div className="vp-grid vp-grid-stats" style={{ marginBottom: 'var(--vp-space-5)' }}>
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
                <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
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

/** The Wetter subpage of one Anlage: the forecast feeding its PV-Prognose. */
export function WetterSection({ site }: { site: Site }) {
  const { data: forecast, loading, err, reload } = useSiteData<WeatherForecast>(site, (id) => api.weather(id));

  const points = forecast?.points ?? [];
  // The run's series starts at 00:00 UTC (hours already in the past) - the hero
  // must pick the UPCOMING hour, never points[0] (the real "temperatures do not
  // match the chart" bug; see weather.ts).
  const nowMs = Date.now();
  const nextIdx = nextHourIndex(points, nowMs);
  const now = nextIdx >= 0 ? points[nextIdx] : null;
  const horizon = hoursAhead(points, nowMs);
  const peakGhi = points.reduce<number | null>(
    (m, p) => (p.ghiWM2 != null && (m == null || p.ghiWM2 > m) ? p.ghiWM2 : m),
    null,
  );

  return (
    <Card padding="lg" radius="lg">
      <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
        <IconTile category="solar" size={40}>
          <Icon name="sun" size={20} />
        </IconTile>
        <h2>Vorhersage {site.name}</h2>
      </div>
      {loading && <ChartCardSkeleton />}
      {err && (
        <ErrorState
          message={`Die Wettervorhersage konnte nicht geladen werden (${err}).`}
          onRetry={reload}
        />
      )}
      {!loading && !err && points.length === 0 && (
        <p className="vp-muted">
          Noch keine Vorhersage. Sie wird automatisch geladen - die Anlage benötigt
          dafür einen Standort auf der Karte (auf der Anlagen-Seite unter
          „Standort &amp; Einstellungen“ ergänzbar).
        </p>
      )}
      {!loading && !err && points.length > 0 && (
        <>
          <div className="vp-grid vp-grid-stats" style={{ marginBottom: 'var(--vp-space-5)' }}>
            <Stat value={fmtNum(now?.temperatureC, '°C')} label="Temperatur (nächste Stunde)" />
            <Stat value={fmtNum(now?.cloudCoverPct, '%', 0)} label="Bewölkung" />
            <Stat value={fmtNum(peakGhi, '', 0)} label="Max. Einstrahlung (W/m²)" />
            <Stat value={fmtNum(horizon, 'h', 0)} label="Vorhersagehorizont" />
          </div>
          <WeatherChart points={points} />
          <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
            Quelle: Open-Meteo, stündlich aktualisiert. Die Einstrahlung (GHI) fließt in
            die PV-Prognose Ihrer Anlage ein.
          </p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

/** Wie weit zurück die Live-Messwerte des Helden geholt werden. */
const LIVE_WINDOW_MS = 15 * 60 * 1000;
/** Der stille Auffrischungs-Takt der beiden Live-Wahrheiten (30-s-Muster). */
const LIVE_POLL_MS = 30_000;

/**
 * D3: am Telefon startet das Detail-Diagramm EINGEKLAPPT (der Film trägt die
 * Erzählung), am Rechner offen. Nur der Startwert - eine spätere Wahl des
 * Kunden gewinnt, auch wenn er das Fenster dreht.
 */
function chartOpenByDefault(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(max-width: 720px)').matches;
}

/**
 * Die Fahrplan-Seite einer Anlage — VIER BLÖCKE in der Reihenfolge der
 * Kundenfragen (Konzept `vp-fahrplan-kunde-konzept` §6, Entscheide D1–D4):
 *
 *   1 JETZT-Held      „Was macht meine Batterie gerade — und läuft das
 *                      richtig?" (+ „muss ich etwas tun?" + das Warum)
 *   2 Film des Tages   „Was passiert als Nächstes?" — die Phasen als erzählte
 *                      Liste mit Jetzt-Anker; der GANZE Tag (die gelaufenen
 *                      Phasen abgehakt), „Morgen" eingeklappt
 *   3 Euro-Zeile       „Was bringt mir das?" — EINE Zeile mit dem Abzeichen
 *                      „Geplant" (die gemessene Ersparnis wohnt in den Erlösen)
 *   4 Diagramm         die Vertiefung: am Telefon eingeklappt, am Rechner
 *                      offen, mit drei Schicht-Schaltern statt neun Pills
 *
 * Vorher begann die Seite mit drei Planungs-KPIs und führte in ein
 * Sieben-Reihen-Diagramm; bis zur ersten Datenkurve lagen am Telefon 1.763 px.
 * Die Frage, mit der fast jeder Besuch beginnt, hatte keinen Ort.
 *
 * Alle Ableitung ist rein und getestet (`fahrplanJetzt.ts`, `fahrplanFilm.ts`,
 * `fahrplanWhy.ts`, `schedule.ts`) — hier steht nur das Gerüst und das Holen
 * der Daten. Ein Plan OHNE die persistierten Warum-Fakten degradiert wie
 * bisher: kein Film, kein Held-Grund, nur Euro-Zeile und Diagramm.
 */
export function FahrplanSection({ site }: { site: Site }) {
  const { data: plan, loading, err, reload } = useSiteData<SchedulePlan>(site, (id) => api.schedule(id));
  const [selSlot, setSelSlot] = useState<number | null>(null);
  const [selPhase, setSelPhase] = useState<number | null>(null);
  // Der Held braucht zwei weitere Wahrheiten neben dem Plan: das Rücklesen des
  // Geräts (Ausführung) und die Live-Telemetrie (Messung). Beide werden
  // FAIL-SOFT geholt - fehlt eine, sagt der Held das ehrlich, statt zu raten.
  const [control, setControl] = useState<ControlStatus | null>(null);
  // ... und - seit PR 3 - die Abregel-Wahrheit: setzt die Anlage eine geplante
  // Drosselung überhaupt um? Ein eigener Abruf, weil der Herzschlag-Block
  // unabhängig vom Rücklese-Block kommt; 204/Fehler => null => Plan-Wortlaut.
  const [curtailStatus, setCurtailStatus] = useState<CurtailmentStatus | null>(null);
  const [points, setPoints] = useState<TelemetryPoint[]>([]);
  const [now, setNow] = useState<Date>(() => new Date());
  const [chartOpen, setChartOpen] = useState<boolean>(chartOpenByDefault);
  // Der GANZE Tag für den Film (Tages-Splice, „wie der Tag geplant war") -
  // ebenfalls FAIL-SOFT: eine api ohne diese Lesart antwortet mit 400, dann
  // bleibt der Film exakt bei der Rest-des-Tages-Fassung des jüngsten Laufs.
  const [dayPlan, setDayPlan] = useState<SchedulePlan | null>(null);

  const siteId = site.id;
  const loadLive = useCallback(() => {
    setNow(new Date());
    api
      .controlStatus(siteId)
      .then((c) => setControl(c))
      .catch(() => undefined);
    api
      .curtailmentStatus(siteId)
      .then((c) => setCurtailStatus(c))
      .catch(() => undefined);
    api
      .telemetry(siteId, new Date(Date.now() - LIVE_WINDOW_MS).toISOString())
      .then((p) => setPoints(p))
      .catch(() => undefined);
  }, [siteId]);

  useEffect(() => {
    setControl(null);
    setCurtailStatus(null);
    setPoints([]);
    loadLive();
  }, [loadLive]);
  useFreshnessPoll(loadLive, LIVE_POLL_MS);

  useEffect(() => {
    let active = true;
    setDayPlan(null);
    api
      .schedule(siteId, 'day')
      .then((p) => active && setDayPlan(p))
      .catch(() => active && setDayPlan(null));
    return () => {
      active = false;
    };
  }, [siteId]);

  const slots = plan?.slots ?? [];
  const slotMinutes = plan?.slotMinutes ?? 15;
  // The why-layer gate: [] unless EVERY slot carries a known role.
  const whyPhases = useMemo(() => phases(slots, slotMinutes), [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasWhy = whyPhases.length > 0;
  // Null (never a fabricated 0,00 €) when today carries no priced plan slot -
  // e.g. the newest run is yesterday's (audit F1).
  const savingsToday = savingsTodayEur(slots, now);
  // Honest freshness banner: the newest run is stale.
  const staleNote = planStaleNote(plan?.generatedAt, slots, now, slotMinutes);
  // Energy = mean power over each slot × slot length in hours. Derive slots-per-
  // hour from the plan's authoritative slotMinutes instead of hardcoding /4, so
  // a non-15-min slot length stays correct.
  const slotsPerHour = plan && plan.slotMinutes > 0 ? 60 / plan.slotMinutes : 4;
  const chargeKwh = slots.reduce((sum, s) => sum + Math.max(s.batteryKw ?? 0, 0), 0) / slotsPerHour;
  const dischargeKwh =
    slots.reduce((sum, s) => sum + Math.max(-(s.batteryKw ?? 0), 0), 0) / slotsPerHour;
  const generatedAt = plan?.generatedAt
    ? new Date(plan.generatedAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  // FK2: banked terminal value + horizon-edge hint (pure derivations).
  const banked = bankedValueLine(plan?.bankedValueEur);
  const horizonNote = horizonHint(slots, now, slotMinutes);

  // Block 2 - der GANZE Tag, wenn der Splice ihn trägt. Die Warum-Ebene ist
  // per Konstruktion alles-oder-nichts (`phases()` liefert [] sobald EIN Slot
  // keine Rolle trägt), also ist eine nicht-leere Phasenliste zugleich der
  // Fail-soft-Schalter: ohne sie (ältere api, Splice ohne Warum-Spalten) rendert
  // der Film zeichengleich den jüngsten Lauf, also den Rest des Tages.
  const daySlots = dayPlan?.slots ?? [];
  const dayPhases = useMemo(() => phases(daySlots, slotMinutes), [dayPlan, slotMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const wholeDay = dayPhases.length > 0;
  const filmSlots = wholeDay ? daySlots : slots;
  const filmPhases = wholeDay ? dayPhases : whyPhases;
  const hasFilm = filmPhases.length > 0;
  // Der Ausblick des Helden liest dieselbe Ableitung - eine Quelle, zwei
  // Verbraucher.
  const film = useMemo(
    () => filmRows(filmPhases, filmSlots, site.plantKind, now),
    [filmPhases, filmSlots, site.plantKind, now],
  );
  // Block 1 - die drei Wahrheiten im Jetzt.
  const snapshot = useMemo(() => buildSnapshot(points), [points]);
  const newestTs = points.length > 0 ? points[points.length - 1].ts : null;
  const snapshotFresh =
    newestTs != null && now.getTime() - new Date(newestTs).getTime() <= ONLINE_WINDOW_MS;
  // Die Beleg-Lage der Abregelung, EINMAL abgeleitet und an alle drei Flächen
  // gereicht (Held, Slot-Panel, Phasen-Panel) - so können sie sich nicht
  // widersprechen. Sie gilt nur für den laufenden Slot: die Panels filtern
  // darauf über den Index (`curtailTruthForSlot`).
  const curtail = useMemo(() => curtailTruth(curtailStatus, now), [curtailStatus, now]);
  const activeSlot = controlReasonSlot(slots, now, slotMinutes);
  // `controlReasonSlot` liefert ein Element DIESES Arrays zurück, `indexOf` ist
  // also exakt - und es gibt keine zweite „welcher Slot läuft"-Regel.
  const activeSlotIdx = activeSlot ? slots.indexOf(activeSlot) : -1;
  const activeFilmSlot = controlReasonSlot(filmSlots, now, slotMinutes);
  const activeFilmIdx = activeFilmSlot ? filmSlots.indexOf(activeFilmSlot) : -1;
  const held = useMemo(
    () =>
      jetztHeld({
        slot: controlReasonSlot(slots, now, slotMinutes),
        control,
        // Steuerbar ist die Anlage genau dann, wenn der Plan ein Gerät hat -
        // dieselbe Regel wie auf dem Cockpit (`batteryLinked`).
        expectControl: plan?.deviceId != null,
        snapshot,
        snapshotFresh,
        planStale: staleNote != null,
        nextPhase: naechsterEinsatz(film),
        curtail,
        plantKind: site.plantKind,
        now,
      }),
    [slots, slotMinutes, control, curtail, plan?.deviceId, snapshot, snapshotFresh, staleNote, film, site.plantKind, now],
  );

  const closePanel = () => {
    setSelPhase(null);
    setSelSlot(null);
  };
  // ZWEI Panels, weil zwei Listen: die Filmzeile zeigt auf die Phasen des
  // GANZEN Tages, die angetippte Viertelstunde im Diagramm auf die Slots des
  // jüngsten Laufs. Ein geteiltes Panel würde bei aktivem Splice in die
  // falsche Liste greifen.
  const phasePanel = hasFilm ? (
    <FahrplanWhyPanel
      phases={filmPhases}
      slots={filmSlots}
      plantKind={site.plantKind}
      slotMinutes={slotMinutes}
      selectedPhase={selPhase}
      selectedSlot={null}
      curtail={curtail}
      currentSlotIndex={activeFilmIdx}
      onClose={closePanel}
    />
  ) : null;
  const slotPanel = hasWhy ? (
    <FahrplanWhyPanel
      phases={whyPhases}
      slots={slots}
      plantKind={site.plantKind}
      slotMinutes={slotMinutes}
      selectedPhase={null}
      selectedSlot={selSlot}
      curtail={curtail}
      currentSlotIndex={activeSlotIdx}
      onClose={closePanel}
    />
  ) : null;

  // `plan === null` bis der erste Abruf zurück ist: sonst blitzte für einen
  // Frame „Noch kein Fahrplan" auf, bevor der Ladezustand greift.
  if (loading || (plan == null && err == null)) {
    return (
      <Card padding="lg" radius="lg">
        <ChartCardSkeleton stats={0} />
      </Card>
    );
  }
  if (err) {
    return (
      <ErrorState message={`Der Fahrplan konnte nicht geladen werden (${err}).`} onRetry={reload} />
    );
  }
  if (slots.length === 0) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="battery-charging"
          category="battery"
          title="Noch kein Fahrplan"
          description="Sobald Ihre Anlage einen Batteriespeicher meldet und Börsenpreise vorliegen, plant VoltPilot alle 15 Minuten einen kostenoptimalen Tagesfahrplan - er erscheint dann automatisch hier."
        />
      </Card>
    );
  }

  return (
    <>
      {/* ---- Block 1: der JETZT-Held (F1 + F5 + F2) ---- */}
      <JetztHeld view={held} />

      {/* Ein Plan älter als ~2 h ist nicht der Plan von heute - das steht
          direkt unter dem Helden, nicht in einer grauen Fußnote (audit F2). */}
      {staleNote && (
        <div className="vp-alert vp-alert-warn" role="status" style={{ margin: '0 0 var(--vp-space-4)' }}>
          {staleNote}
        </div>
      )}

      {/* ---- Block 2: der Film des Tages (F3) ---- */}
      {hasFilm && (
        <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-4)' }}>
          <div className="vp-jetzt-kick">
            {/* „Der ganze Tag", sobald der Splice die Vormittags-Phasen trägt -
                sonst die bisherige Beschriftung. EIN Abzeichen für die ganze
                Karte: hier stehen nur geplante Zahlen, auch in der Vergangenheit. */}
            <span className="vp-card-label">{filmKicker(film)}</span>
            <ProvBadge art="geplant" />
          </div>
          <TagesFilm
            view={film}
            selected={selPhase}
            onSelect={(i) => {
              setSelPhase((cur) => (cur === i ? null : i));
              setSelSlot(null);
            }}
            panel={selPhase != null ? phasePanel : null}
          />
          <p className="vp-note" style={{ margin: 'var(--vp-space-3) 0 0' }}>
            Phase antippen: warum der Speicher das tut, mit den Zahlen dahinter.
            Was heute wirklich passiert ist, steht unter{' '}
            <a href={`#/anlage/${site.id}/messwerte`}>Messwerte</a>.
          </p>
        </Card>
      )}

      {/* ---- Block 3: die Euro-Zeile (F4) ---- */}
      <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-4)' }}>
        <div className="vp-jetzt-kick">
          <span className="vp-card-label">Ihr Vorteil</span>
          <ProvBadge art="geplant" />
        </div>
        {savingsToday == null ? (
          <p className="vp-note" style={{ margin: 0 }}>
            Für heute liegt noch kein Fahrplan vor.
          </p>
        ) : (
          <p className="vp-fp-euro">
            {/* Sign-honest wie überall im Portal: ein Plus wird ausgeschrieben,
                ein Minus trägt sein eigenes Zeichen (`eurAmount`). */}
            <b>
              Heute geplant:{' '}
              {savingsToday > 0 ? `+${eurAmount(savingsToday)}` : eurAmount(savingsToday)}
            </b>
            <span className="sub">
              gegenüber einem Betrieb ohne Speicher
              <InfoTip title="Wie diese Zahl zu lesen ist">
                Verglichen wird mit einem Betrieb ganz ohne Batteriespeicher.
                Energie, die der Fahrplan über den Tag hinaus im Speicher lässt,
                ist hier noch nicht mitgezählt: sie wird mit ihrem erwarteten
                Nutzen am Folgetag bewertet und als eigene Zeile ausgewiesen. An
                Tagen, an denen viel Energie für den Folgetag gespeichert wird,
                kann die Zahl deshalb klein oder sogar negativ sein – der
                gespeicherte Wert kommt morgen zurück.
              </InfoTip>
            </span>
          </p>
        )}
        {banked && <p className="vp-fp-euro-note">{banked}</p>}
      </Card>

      {/* ---- Block 4: das Diagramm als Aufklapp-Ebene (F6 + F7) ---- */}
      <Card padding="lg" radius="lg">
        <div className="vp-fp-fold-head">
          <button
            type="button"
            className={`vp-fp-fold-toggle${chartOpen ? ' is-open' : ''}`}
            aria-expanded={chartOpen}
            onClick={() => setChartOpen((o) => !o)}
          >
            <Icon name="chevron-down" size={18} />
            Diagramm im Detail
          </button>
          <InfoTip title="Wie der Fahrplan berechnet wird">
            Der Fahrplan wird für jede Anlage einzeln alle 15 Minuten neu berechnet -
            für die nächsten 24 Stunden in 15-Minuten-Schritten. Ein Optimierungsmodell
            plant den Batteriespeicher so, dass Ihre Stromkosten minimal werden:
            laden bei günstigem Strom oder PV-Überschuss, entladen wenn Strom teuer ist,
            Eigenverbrauch maximieren. Eingaben je Anlage sind die Börsen-Day-Ahead-Preise,
            die Last- und PV-Prognose, der aktuelle Ladestand, die Batteriegrenzen und die
            §14a-Netzgrenze. Weil jede Anlage eigene Eingaben hat, erhält sie ihren eigenen
            Fahrplan.
          </InfoTip>
        </div>

        {chartOpen && (
          <>
            <ChartSubtitle>
              Balken = Ihr Speicher, Linie = der Börsen-Strompreis dahinter; alles links
              vom „Jetzt“ ist bereits vergangen. Details je Viertelstunde per Tipp.
            </ChartSubtitle>
            <ScheduleChart
              plan={plan!}
              onSlotClick={
                hasWhy
                  ? (i) => {
                      setSelSlot((cur) => (cur === i ? null : i));
                      setSelPhase(null);
                    }
                  : undefined
              }
              selectedIndex={hasWhy ? selSlot : undefined}
            />
            {selSlot != null && slotPanel}
            {/* Die Energiesummen sind Diagramm-KONTEXT, kein Seiten-Einstieg -
                deshalb stehen sie hier unten und nicht mehr als KPI-Reihe oben. */}
            <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
              Über den ganzen Planungszeitraum: {fmtNum(chargeKwh, 'kWh')} geplantes Laden,{' '}
              {fmtNum(dischargeKwh, 'kWh')} geplantes Entladen.
            </p>
            {/* F6: the per-slot explanation ("Warum") only exists for plans a
                current optimizer wrote - the columns fill forward, never
                backwards. Say it in one line so its absence does not read as a
                missing feature (and never fabricate a reason). */}
            {!hasWhy && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                Die Begründung je Viertelstunde erscheint mit dem nächsten Planungslauf.
              </p>
            )}
            {/* Fallback-build honesty: the §14a limit could not be fully
                scheduled - the device enforces it additionally. */}
            {hasWhy && plan?.fallback14a === true && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                {FALLBACK_14A_NOTE}
              </p>
            )}
            {/* Horizon-edge honesty (FK2): the morning plan legitimately ends at
                midnight until tomorrow's prices publish - say so, calmly. */}
            {horizonNote && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>{horizonNote}</p>
            )}
            {/* Forecast honesty (why-layer): the plan rests on forecasts. */}
            {hasWhy && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                {FORECAST_FOOTNOTE} <a href="#/prognose">Zur Prognosequalität →</a>
              </p>
            )}
            <p className="vp-note" style={{ marginTop: 'var(--vp-space-4)' }}>
              Kostenoptimaler Batterie-Fahrplan in 15-Minuten-Schritten aus Börsenpreisen
              und Last-/PV-Prognose{generatedAt ? `, erstellt am ${generatedAt} Uhr` : ''}.
              Ihr Gerät begrenzt jeden Sollwert zusätzlich lokal (u. a. §14a EnWG).
            </p>
          </>
        )}
      </Card>
    </>
  );
}
