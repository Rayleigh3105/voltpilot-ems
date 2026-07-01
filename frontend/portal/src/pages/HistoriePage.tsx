import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import {
  api,
  ApiError,
  type History,
  type HistoryRange,
  type ProtocolEvent,
  type Site,
} from '../api';
import { eurAmount, NBSP } from '../format';
import { SitePicker } from '../components/SitePicker';
import { HistoryDayChart, HistoryEnergyChart } from '../HistoryChart';

/**
 * Historie: what the system DID, money lens first (captain: Geld führt) and
 * built for Nachvollziehbarkeit - the day view puts the actual battery
 * behavior directly over the price curve (plus the plan overlay), and the
 * Tagesprotokoll narrates the day in plain German.
 */

const RANGES: { id: HistoryRange; label: string }[] = [
  { id: 'day', label: 'Tag' },
  { id: 'week', label: 'Woche' },
  { id: 'month', label: 'Monat' },
  { id: 'year', label: 'Jahr' },
];

/** Local calendar date as the API's `at` param (YYYY-MM-DD). */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function shiftAnchor(anchor: Date, range: HistoryRange, dir: 1 | -1): Date {
  const d = new Date(anchor);
  if (range === 'day') d.setDate(d.getDate() + dir);
  if (range === 'week') d.setDate(d.getDate() + 7 * dir);
  if (range === 'month') d.setMonth(d.getMonth() + dir, 1);
  if (range === 'year') d.setFullYear(d.getFullYear() + dir, 0, 1);
  return d;
}

/** ISO-8601 week number (Monday-start), for the week label. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function periodLabel(anchor: Date, range: HistoryRange): string {
  if (range === 'day') {
    return anchor.toLocaleDateString('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }
  if (range === 'week') {
    const monday = new Date(anchor);
    const off = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - off);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const fmt = (x: Date) => x.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    return `KW ${isoWeek(anchor)} · ${fmt(monday)} - ${fmt(sunday)}`;
  }
  if (range === 'month') {
    return anchor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  }
  return String(anchor.getFullYear());
}

const EVENT_ICONS: Record<ProtocolEvent['type'], { icon: IconName; label: string }> = {
  'batterie-laden': { icon: 'arrow-up', label: 'Laden' },
  'batterie-entladen': { icon: 'arrow-down', label: 'Entladen' },
  'pv-spitze': { icon: 'sun', label: 'PV' },
  'preis-tief': { icon: 'trending-down', label: 'Preis-Tief' },
  'preis-hoch': { icon: 'trending-up', label: 'Preis-Hoch' },
};

function kwh(v: number | null | undefined): string {
  return v == null ? '-' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}kWh`;
}

function pct(v: number | null | undefined): string {
  return v == null ? '-' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}%`;
}

export function HistoriePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  const [range, setRange] = useState<HistoryRange>('day');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [history, setHistory] = useState<History | null>(null);
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
      .history(site.id, range, at)
      .then((h) => active && setHistory(h))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id, range, at]);

  const nextDisabled = shiftAnchor(anchor, range, 1) > new Date();
  const totals = history?.totals ?? null;
  const buckets = history?.buckets ?? [];
  const isDay = range === 'day';

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Historie</h1>
          <p>
            Was Ihre Anlage getan hat - und was es gekostet oder gespart hat
            {site ? ` (${site.name})` : ''}.
          </p>
        </div>
        <div className="actions">
          <SitePicker sites={props.sites} value={props.selectedSite} onChange={props.onSelectSite} />
        </div>
      </div>

      {props.sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch kein Standort - legen Sie zuerst unter „Standorte“ einen an.
          </p>
        </Card>
      ) : (
        <>
          {/* Period navigation: Tag/Woche/Monat/Jahr + stepper + Heute. */}
          <div
            className="vp-page-head"
            style={{ marginBottom: 'var(--vp-space-5)', alignItems: 'center' }}
          >
            <div className="vp-seg" role="tablist" aria-label="Zeitraum">
              {RANGES.map((r) => (
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
              <p className="vp-muted">Lade Historie…</p>
            </Card>
          )}
          {err && (
            <div className="vp-alert vp-alert-err">
              Die Historie konnte nicht geladen werden ({err}). Bitte versuchen Sie es
              später erneut.
            </div>
          )}

          {!loading && !err && history && buckets.length === 0 && (
            <Card padding="lg" radius="lg">
              <div className="vp-empty">
                <IconTile category="dynamic" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
                  <Icon name="history" size={24} />
                </IconTile>
                <h3>Keine Daten in diesem Zeitraum</h3>
                <p>
                  Sobald Ihr Gerät Messwerte liefert, entsteht hier die Historie:
                  Kosten, Ersparnis und das Verhalten Ihrer Anlage - Tag für Tag
                  nachvollziehbar. Wählen Sie einen anderen Zeitraum oder schauen
                  Sie später wieder vorbei.
                </p>
              </div>
            </Card>
          )}

          {!loading && !err && history && buckets.length > 0 && (
            <>
              {/* Money headline first (captain: Geld führt). */}
              <section className="vp-kpis" aria-label="Zeitraum-Bilanz">
                <KpiCard
                  icon={<Icon name="euro" size={20} />}
                  category="dynamic"
                  value={totals?.gridCostEur == null ? '-' : eurAmount(totals.gridCostEur)}
                  label="Stromkosten (Netzbezug)"
                  title="Bezogene Energie × zugehöriger Börsenpreis, je Viertelstunde"
                />
                <KpiCard
                  icon={<Icon name="battery-charging" size={20} />}
                  category="battery"
                  value={
                    totals?.batterySavingsEur == null ? '-' : eurAmount(totals.batterySavingsEur)
                  }
                  label="Speicher-Ersparnis"
                  title="Aus den gespeicherten Fahrplänen: Kosten gegenüber einem Betrieb ohne Speicher"
                />
              </section>
              {(totals?.gridCostEur == null || totals?.batterySavingsEur == null) && (
                <p className="vp-note" style={{ marginTop: 8 }}>
                  {totals?.gridCostEur == null && 'Für diesen Zeitraum liegen keine Börsenpreise vor. '}
                  {totals?.batterySavingsEur == null &&
                    'Für diesen Zeitraum liegt kein Batterie-Fahrplan vor - die Ersparnis erscheint, sobald geplant wird.'}
                </p>
              )}

              {/* Energy KPIs below the money. */}
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-grid vp-grid-stats">
                    <Stat value={pct(totals?.autarkiePct)} label="Autarkiegrad" />
                    <Stat value={pct(totals?.eigenverbrauchPct)} label="Eigenverbrauchsquote" />
                    <Stat value={kwh(totals?.consumptionKwh)} label="Verbrauch" />
                    <Stat value={kwh(totals?.pvGenerationKwh)} label="PV-Erzeugung" />
                    <Stat value={kwh(totals?.gridImportKwh)} label="Netzbezug" />
                    <Stat value={kwh(totals?.gridExportKwh)} label="Einspeisung" />
                  </div>
                  <p className="vp-note" style={{ marginTop: 12 }}>
                    Autarkiegrad = 1 − Netzbezug/Verbrauch · Eigenverbrauchsquote =
                    selbst genutzte PV/PV-Erzeugung.
                  </p>
                </Card>
              </section>

              {/* Day view: the traceability centerpiece - battery over price. */}
              {isDay && (
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                      <IconTile category="battery" size={40}>
                        <Icon name="battery" size={20} />
                      </IconTile>
                      <h2>Speicher &amp; Preis</h2>
                      {history.plan.length > 0 ? (
                        <Badge variant="tint">Plan-Overlay</Badge>
                      ) : (
                        <Badge variant="off">kein Plan</Badge>
                      )}
                    </div>
                    <HistoryDayChart history={history} />
                    <p className="vp-note" style={{ marginTop: 12 }}>
                      Tatsächliches Batterieverhalten (grün = laden, rot = entladen) über dem
                      Börsenpreis - Laden in günstigen Viertelstunden ist direkt
                      sichtbar{history.plan.length > 0
                        ? '; gestrichelt zum Vergleich: der geplante Fahrplan'
                        : ''}.
                    </p>
                  </Card>
                </section>
              )}

              {/* Energy series of the period. */}
              <section className="vp-section">
                <Card padding="lg" radius="lg">
                  <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                    <IconTile category="dynamic" size={40}>
                      <Icon name="activity" size={20} />
                    </IconTile>
                    <h2>Energie</h2>
                    <Badge variant="tint">
                      {isDay ? '15-Minuten-Mittel' : range === 'week' ? 'stündlich' : 'täglich'}
                    </Badge>
                  </div>
                  <HistoryEnergyChart history={history} />
                </Card>
              </section>

              {/* Tagesprotokoll (day only): the day narrated in plain German. */}
              {isDay && (
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                      <IconTile category="home" size={40}>
                        <Icon name="list" size={20} />
                      </IconTile>
                      <h2>Tagesprotokoll</h2>
                    </div>
                    {history.protocol.length === 0 ? (
                      <p className="vp-muted">
                        Keine besonderen Ereignisse an diesem Tag - keine nennenswerte
                        Batterie-Aktivität, PV-Erzeugung oder Preisspreizung erkannt.
                      </p>
                    ) : (
                      <ul className="vp-timeline">
                        {history.protocol.map((e, i) => {
                          const fmt = (iso: string) =>
                            new Date(iso).toLocaleTimeString('de-DE', {
                              hour: '2-digit',
                              minute: '2-digit',
                            });
                          const oneSlot =
                            new Date(e.end).getTime() - new Date(e.start).getTime() <= 15 * 60000;
                          return (
                            <li key={`${e.type}-${e.start}-${i}`}>
                              <span className="t">
                                {oneSlot ? fmt(e.start) : `${fmt(e.start)} - ${fmt(e.end)}`}
                              </span>
                              <span className="ico" aria-hidden="true">
                                {EVENT_ICONS[e.type] ? (
                                  <Icon name={EVENT_ICONS[e.type].icon} size={16} />
                                ) : null}
                              </span>
                              <span className="txt">{e.text}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <p className="vp-note" style={{ marginTop: 12 }}>
                      Automatisch aus Messwerten und Börsenpreisen des Tages abgeleitet.
                    </p>
                  </Card>
                </section>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
