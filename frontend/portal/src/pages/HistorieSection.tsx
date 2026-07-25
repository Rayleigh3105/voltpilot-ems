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
import { isoDate, PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';

import { InfoTip } from '../components/InfoTip';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { VerlaufExplorer } from '../components/VerlaufExplorer';
import { HistoryDayChart, HistoryEnergieChart } from '../HistoryChart';

/**
 * Historie has two faces: **Bilanz & Erlöse** (the money/energy balance - the
 * existing page, verbatim) and **Messwerte** (the new Verlauf-Explorer: every
 * physical measurement over a selectable range). "Geld führt", so Bilanz is the
 * default tab (owner Q1); a deep link (`?m=…`) opens Messwerte pre-focused. The
 * boundary is deliberate: the explorer shows raw physical measurements (kW, %),
 * the derived balance quantities (kWh, €, Autarkie/EV) stay in Bilanz where
 * their formulas + InfoTips live.
 */

type HistTab = 'bilanz' | 'messwerte';

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

/** The shared Tag/Woche/Monat/Jahr range control + stepper (both faces). */
function PeriodNav({
  range,
  anchor,
  onRange,
  onAnchor,
}: {
  range: HistoryRange;
  anchor: Date;
  onRange: (r: HistoryRange) => void;
  onAnchor: (d: Date) => void;
}) {
  const nextDisabled = shiftAnchor(anchor, range, 1) > new Date();
  return (
    <div className="vp-page-head" style={{ marginBottom: 'var(--vp-space-5)', alignItems: 'center' }}>
      <div className="vp-seg" role="tablist" aria-label="Zeitraum">
        {PERIOD_RANGES.map((r) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={range === r.id}
            className={range === r.id ? 'active' : ''}
            onClick={() => onRange(r.id)}
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
          onClick={() => onAnchor(shiftAnchor(anchor, range, -1))}
        >
          <Icon name="chevron-left" size={18} />
        </button>
        <span className="label">{periodLabel(anchor, range)}</span>
        <button
          type="button"
          className="step"
          aria-label="Nächster Zeitraum"
          disabled={nextDisabled}
          onClick={() => onAnchor(shiftAnchor(anchor, range, 1))}
        >
          <Icon name="chevron-right" size={18} />
        </button>
        <button type="button" className="step" onClick={() => onAnchor(new Date())}>
          Heute
        </button>
      </div>
    </div>
  );
}

/**
 * The "Bilanz & Erlöse" face: what the system DID, money lens first (captain:
 * Geld führt) and built for Nachvollziehbarkeit. Extracted verbatim from the
 * former Historie page; the period nav is now shared above the tabs.
 */
function BilanzFace({ site, range, anchor }: { site: Site; range: HistoryRange; anchor: Date }) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const at = isoDate(anchor);
  useEffect(() => {
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
  }, [site.id, range, at, reloadKey]);

  const totals = history?.totals ?? null;
  const buckets = history?.buckets ?? [];
  const isDay = range === 'day';

  return (
    <>
      {loading && (
        <Card padding="lg" radius="lg">
          <ChartCardSkeleton />
        </Card>
      )}
      {err && (
        <ErrorState
          message={`Die Historie konnte nicht geladen werden (${err}).`}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      )}

      {!loading && !err && history && buckets.length === 0 && (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="history"
            category="dynamic"
            title="Keine Daten in diesem Zeitraum"
            description="Sobald Ihr Gerät Messwerte liefert, entsteht hier die Historie: Kosten, Ersparnis und das Verhalten Ihrer Anlage - Tag für Tag nachvollziehbar. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
          />
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
                totals?.batterySavingsPlannedEur == null
                  ? '-'
                  : eurAmount(totals.batterySavingsPlannedEur)
              }
              label="Geplante Speicher-Ersparnis"
              title="Aus den gespeicherten Fahrplänen GEPLANT: Kosten gegenüber einem Betrieb ohne Speicher. Nicht die gemessene Ersparnis - die steht unter „Erlöse“."
            />
          </section>
          {(totals?.gridCostEur == null || totals?.batterySavingsPlannedEur == null) && (
            <p className="vp-note" style={{ marginTop: 8 }}>
              {totals?.gridCostEur == null && 'Für diesen Zeitraum liegen keine Börsenpreise vor. '}
              {totals?.batterySavingsPlannedEur == null &&
                'Für diesen Zeitraum liegt kein Batterie-Fahrplan vor - die geplante Ersparnis erscheint, sobald geplant wird.'}
            </p>
          )}

          {/* Energy KPIs below the money. */}
          <section className="vp-section">
            <Card padding="lg" radius="lg">
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
                <IconTile category="dynamic" size={40}>
                  <Icon name="zap" size={20} />
                </IconTile>
                <h2>Energie-Bilanz im Zeitraum</h2>
              </div>
              <div className="vp-grid vp-grid-stats">
                <Stat
                  value={pct(totals?.autarkiePct)}
                  label={
                    <>
                      Autarkiegrad
                      <InfoTip title="Autarkiegrad">
                        Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben (aus PV und
                        Speicher) - der Rest kam aus dem Netz. Formel: 1 −
                        Netzbezug/Verbrauch.
                      </InfoTip>
                    </>
                  }
                />
                <Stat
                  value={pct(totals?.eigenverbrauchPct)}
                  label={
                    <>
                      Eigenverbrauchsquote
                      <InfoTip title="Eigenverbrauchsquote">
                        Anteil Ihrer PV-Erzeugung, den Sie selbst genutzt statt eingespeist
                        haben. Formel: selbst genutzte PV / PV-Erzeugung.
                      </InfoTip>
                    </>
                  }
                />
                <Stat value={kwh(totals?.consumptionKwh)} label="Verbrauch" />
                <Stat value={kwh(totals?.pvGenerationKwh)} label="PV-Erzeugung" />
                <Stat value={kwh(totals?.gridImportKwh)} label="Netzbezug" />
                <Stat value={kwh(totals?.gridExportKwh)} label="Einspeisung" />
              </div>
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
                    <Badge variant="tint">Plan &amp; Ist</Badge>
                  ) : (
                    <Badge variant="off">kein Plan</Badge>
                  )}
                </div>
                <ChartSubtitle>
                  Was Ihr Speicher an diesem Tag wirklich getan hat - direkt über dem
                  Börsen-Strompreis, damit Sie sehen, dass er günstig lädt und teuer
                  entlädt.
                </ChartSubtitle>
                <HistoryDayChart history={history} />
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
                <h2>Energie: Erzeugung &amp; Verbrauch</h2>
                <Badge variant="tint">
                  {isDay ? '15-Minuten-Mittel' : range === 'week' ? 'stündlich' : 'täglich'}
                </Badge>
              </div>
              <ChartSubtitle>
                {isDay
                  ? 'Der Tagesverlauf Ihrer Anlage: wie viel Strom die PV erzeugt, wie viel das Haus verbraucht und wie viel aus dem Netz kommt oder eingespeist wird.'
                  : 'Erzeugung und Verbrauch je Abschnitt im gewählten Zeitraum - als Energiemengen in Kilowattstunden.'}
              </ChartSubtitle>
              <HistoryEnergieChart history={history} />
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
  );
}

/**
 * The "Historie & Erlöse" subpage: a top-level Messwerte | Bilanz & Erlöse tab
 * over a shared period nav. Bilanz is the default ("Geld führt", Q1); a deep
 * link `#/anlage/{id}/historie?m={entityId}:{channel}&z=…&at=…` opens Messwerte
 * pre-focused (`parseRoute` strips `?…`, so this parses the params itself).
 */
export function HistorieSection({ site }: { site: Site }) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [tab, setTab] = useState<HistTab>(init.target ? 'messwerte' : 'bilanz');
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  // A V2 cockpit jump (or back/forward) can change the deep-link while this
  // section stays mounted; re-seed the tab + period from it. The explorer's own
  // replaceState never fires hashchange, so this only reacts to real navigation.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      if (!p.target) return;
      setTab('messwerte');
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      <div className="vp-seg" role="tablist" aria-label="Ansicht" style={{ marginBottom: 'var(--vp-space-4)' }}>
        <button
          role="tab"
          aria-selected={tab === 'bilanz'}
          className={tab === 'bilanz' ? 'active' : ''}
          onClick={() => setTab('bilanz')}
        >
          Bilanz &amp; Erlöse
        </button>
        <button
          role="tab"
          aria-selected={tab === 'messwerte'}
          className={tab === 'messwerte' ? 'active' : ''}
          onClick={() => setTab('messwerte')}
        >
          Messwerte
        </button>
      </div>

      <PeriodNav range={range} anchor={anchor} onRange={setRange} onAnchor={setAnchor} />

      {tab === 'bilanz' ? (
        <BilanzFace site={site} range={range} anchor={anchor} />
      ) : (
        <VerlaufExplorer site={site} range={range} anchor={anchor} initialTargets={init.targets} />
      )}
    </>
  );
}
