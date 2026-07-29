import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
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
import {
  energieBilanz,
  summenTitel,
  zeitraumHinweis,
  type EnergieFarbe,
  type EnergieSumme,
} from '../energieBilanz';
import { chartTheme } from '../chartTheme';

import { InfoTip } from '../components/InfoTip';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { VerlaufExplorer } from '../components/VerlaufExplorer';
import { HistoryDayChart, HistoryEnergieChart } from '../HistoryChart';

import '../components/Historie.css';

/**
 * Historie, Struktur **B1** des Owner-Entwurfs (`data/vp-ui-pv-hist-d8`).
 *
 * Zwei Top-Level-Tabs — **„Energie" (Standard) | „Erlöse"** — und im
 * Energie-Tab ein Umschalter **Übersicht | Messwerte**. Das behebt den
 * eigentlichen STRUKTURFEHLER: die Energiediagramme lagen unter dem GELD-Tab
 * („Bilanz & Erlöse"), sodass die Energiegeschichte der Anlage — genau das,
 * wofür man eine Historie öffnet — nicht führte und weder Batterie noch
 * Ladestand zeigte. Alle sechs recherchierten Referenzprodukte (Fronius
 * Solar.web, SolarEdge, Home Assistant Energy, Victron VRM, OpenEMS, evcc)
 * führen mit der Energie.
 *
 * „Erlöse" behält alles Geldbezogene (Stromkosten, GEPLANTE Speicher-Ersparnis,
 * den Speicher-&-Preis-Nachweis, Tagesprotokoll). Beide Gesichter teilen
 * Periodenwahl und Blätterer; der bestehende Deep-Link
 * `?m={Komponente}:{Kanal}&z=tag` springt weiterhin direkt in „Messwerte" —
 * jetzt auch mit mehreren Messwerten.
 */

type HistTab = 'energie' | 'erloese';
type EnergieModus = 'uebersicht' | 'messwerte';

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

/** The pure `EnergieFarbe` key -> the resolved chart hex (the KPI dots). */
function dotColor(key: EnergieFarbe): string {
  const t = chartTheme();
  const map: Record<EnergieFarbe, string> = {
    pv: t.pv,
    load: t.load,
    grid: t.flowGrid,
    gridImport: t.discharge,
    gridExport: t.charge,
    charge: t.charge,
    battDischarge: t.battDischarge,
    soc: t.soc,
  };
  return map[key];
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

/** Shared `api.history` load - both faces read one period from one endpoint. */
function useHistory(siteId: string, range: HistoryRange, at: string) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .history(siteId, range, at)
      .then((h) => active && setHistory(h))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [siteId, range, at, reloadKey]);

  return { history, loading, err, retry: () => setReloadKey((k) => k + 1) };
}

/** One period-total tile: value + coloured dot + plain-German hint. */
function SummeTile({ summe }: { summe: EnergieSumme }) {
  return (
    <div className="vp-esum" title={summe.hinweis}>
      <span className="vp-esum-v">{kwh(summe.kwh)}</span>
      <span className="vp-esum-l">
        <span className="vp-esum-dot" style={{ ['--dot' as string]: dotColor(summe.farbe) }} />
        {summe.label}
      </span>
    </div>
  );
}

/**
 * **Die Standardansicht „Energie" → Übersicht** (B1-a + B1-b): die
 * Energiemengen des Zeitraums als Kennzahl-Zeile, darunter EIN Diagramm mit
 * allen Reihen. Die Kennzahl-Zeile trägt ihren Zeitraum im Titel, und bei einem
 * VERGANGENEN Zeitraum sagt ein Hinweis ausdrücklich, dass diese Zahlen nicht
 * die aus dem Cockpit („heute") sind — „nie zwei Zahlen unter einem Wort".
 */
function EnergieUebersicht({
  site,
  range,
  anchor,
}: {
  site: Site;
  range: HistoryRange;
  anchor: Date;
}) {
  const { history, loading, err, retry } = useHistory(site.id, range, isoDate(anchor));
  const isDay = range === 'day';

  if (loading) {
    return (
      <Card padding="lg" radius="lg">
        <ChartCardSkeleton />
      </Card>
    );
  }
  if (err) {
    return (
      <ErrorState message={`Die Historie konnte nicht geladen werden (${err}).`} onRetry={retry} />
    );
  }
  if (!history) return null;

  const bilanz = energieBilanz(history);
  const hinweis = zeitraumHinweis(anchor, range, new Date());

  if (history.buckets.length === 0 || bilanz.empty) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="history"
          category="dynamic"
          title="Keine Messwerte in diesem Zeitraum"
          description="Sobald Ihre Anlage misst, entsteht hier die Energiegeschichte: PV-Erzeugung, Hausverbrauch, Netz und Speicher in einem Bild. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
        />
      </Card>
    );
  }

  return (
    <>
      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
            <IconTile category="dynamic" size={40}>
              <Icon name="zap" size={20} />
            </IconTile>
            <h2>{summenTitel(anchor, range)}</h2>
          </div>

          <div className="vp-energie-summen" aria-label="Energiemengen im Zeitraum">
            {bilanz.summen.map((s) => (
              <SummeTile key={s.key} summe={s} />
            ))}
          </div>

          <div className="vp-energie-chips">
            <span className="vp-energie-chip">
              Autarkie <b>{pct(bilanz.autarkiePct)}</b>
              <InfoTip title="Autarkiegrad">
                Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben (aus PV und Speicher) -
                der Rest kam aus dem Netz. Formel: 1 − Netzbezug/Verbrauch.
              </InfoTip>
            </span>
            <span className="vp-energie-chip">
              Eigenverbrauch <b>{pct(bilanz.eigenverbrauchPct)}</b>
              <InfoTip title="Eigenverbrauchsquote">
                Anteil Ihrer PV-Erzeugung, den Sie selbst genutzt statt eingespeist haben.
                Formel: selbst genutzte PV / PV-Erzeugung.
              </InfoTip>
            </span>
            <span className="vp-energie-chip">
              Stromkosten{' '}
              <b>{bilanz.gridCostEur == null ? '-' : eurAmount(bilanz.gridCostEur)}</b>
              <span className="sub">· {bilanz.gridCostHinweis}</span>
            </span>
          </div>

          {hinweis && <p className="vp-note">{hinweis}</p>}
        </Card>
      </section>

      <section className="vp-section">
        <Card padding="lg" radius="lg">
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
            <IconTile category="dynamic" size={40}>
              <Icon name="activity" size={20} />
            </IconTile>
            <h2>Ihre Energie im Verlauf</h2>
            <Badge variant="tint">
              {isDay ? '15-Minuten-Mittel' : range === 'week' ? 'stündlich' : 'täglich'}
            </Badge>
          </div>
          <ChartSubtitle>
            {isDay
              ? 'Der Tagesverlauf Ihrer Anlage in einem Bild: PV-Erzeugung, Hausverbrauch, Netz und Speicher - dazu der Ladestand.'
              : 'Erzeugung, Verbrauch, Netz und Speicher je Abschnitt im gewählten Zeitraum - als Energiemengen in Kilowattstunden, dazu der Ladestand.'}
          </ChartSubtitle>
          <HistoryEnergieChart history={history} />
        </Card>
      </section>
    </>
  );
}

/**
 * **„Erlöse"**: alles Geldbezogene des Zeitraums. Die Speicher-Ersparnis ist
 * die EX-ANTE GEPLANTE Zahl aus den gespeicherten Fahrplänen (der gemessene
 * Gegenwert steht im Geld-Überblick der Anlagen-Seite), deshalb trägt sie das
 * Wort „geplant" — die beiden unterscheiden sich legitim um einen großen Faktor.
 */
function ErloeseFace({ site, range, anchor }: { site: Site; range: HistoryRange; anchor: Date }) {
  const { history, loading, err, retry } = useHistory(site.id, range, isoDate(anchor));
  const isDay = range === 'day';

  if (loading) {
    return (
      <Card padding="lg" radius="lg">
        <ChartCardSkeleton />
      </Card>
    );
  }
  if (err) {
    return (
      <ErrorState message={`Die Historie konnte nicht geladen werden (${err}).`} onRetry={retry} />
    );
  }
  if (!history) return null;

  const totals = history.totals;
  const hinweis = zeitraumHinweis(anchor, range, new Date());

  if (history.buckets.length === 0) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="history"
          category="dynamic"
          title="Keine Daten in diesem Zeitraum"
          description="Sobald Ihr Gerät Messwerte liefert, entstehen hier die Kosten und die geplante Ersparnis - Tag für Tag nachvollziehbar. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
        />
      </Card>
    );
  }

  return (
    <>
      <section className="vp-kpis" aria-label="Geld im Zeitraum">
        <KpiCard
          icon={<Icon name="euro" size={20} />}
          category="dynamic"
          value={totals.gridCostEur == null ? '-' : eurAmount(totals.gridCostEur)}
          label={`Stromkosten (Netzbezug) · ${periodLabel(anchor, range)}`}
          title={
            totals.tarifPriced
              ? 'Bezogene Energie, je Viertelstunde bewertet zu Ihrem Stromtarif statt zum Börsenpreis - dieselbe Rechnung, mit der die Steuerung plant.'
              : 'Bezogene Energie × zugehöriger Börsenpreis, je Viertelstunde. Ein hinterlegter Stromtarif würde hier eingerechnet.'
          }
        />
        <KpiCard
          icon={<Icon name="battery-charging" size={20} />}
          category="battery"
          value={
            totals.batterySavingsPlannedEur == null
              ? '-'
              : eurAmount(totals.batterySavingsPlannedEur)
          }
          label={`Geplante Speicher-Ersparnis · ${periodLabel(anchor, range)}`}
          title="Aus den gespeicherten Fahrplänen GEPLANT: Kosten gegenüber einem Betrieb ohne Speicher. Nicht die gemessene Ersparnis - die steht im Geld-Überblick Ihrer Anlage."
        />
      </section>
      {(totals.gridCostEur == null || totals.batterySavingsPlannedEur == null || hinweis) && (
        <p className="vp-note" style={{ marginTop: 8 }}>
          {totals.gridCostEur == null && 'Für diesen Zeitraum liegen keine Börsenpreise vor. '}
          {totals.batterySavingsPlannedEur == null &&
            'Für diesen Zeitraum liegt kein Batterie-Fahrplan vor - die geplante Ersparnis erscheint, sobald geplant wird. '}
          {hinweis}
        </p>
      )}

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
              Börsen-Strompreis, damit Sie sehen, dass er günstig lädt und teuer entlädt.
            </ChartSubtitle>
            <HistoryDayChart history={history} />
          </Card>
        </section>
      )}

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
  );
}

/**
 * The "Historie & Erlöse" subpage. „Energie" is the DEFAULT tab (B1); a deep
 * link `#/anlage/{id}/historie?m={entityId}:{channel}&z=…&at=…` opens Energie →
 * Messwerte pre-focused (`parseRoute` strips `?…`, so this parses the params
 * itself), now with several `m` params for a comparison.
 */
export function HistorieSection({ site }: { site: Site }) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [tab, setTab] = useState<HistTab>('energie');
  const [modus, setModus] = useState<EnergieModus>(init.target ? 'messwerte' : 'uebersicht');
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  // A V2 cockpit jump (or back/forward) can change the deep-link while this
  // section stays mounted; re-seed the mode + period from it. The explorer's own
  // replaceState never fires hashchange, so this only reacts to real navigation.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      if (!p.target) return;
      setTab('energie');
      setModus('messwerte');
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
          aria-selected={tab === 'energie'}
          className={tab === 'energie' ? 'active' : ''}
          onClick={() => setTab('energie')}
        >
          Energie
        </button>
        <button
          role="tab"
          aria-selected={tab === 'erloese'}
          className={tab === 'erloese' ? 'active' : ''}
          onClick={() => setTab('erloese')}
        >
          Erlöse
        </button>
      </div>

      <PeriodNav range={range} anchor={anchor} onRange={setRange} onAnchor={setAnchor} />

      {tab === 'energie' ? (
        <>
          <div className="vp-energie-modus">
            <div className="vp-seg" role="tablist" aria-label="Energie-Ansicht">
              <button
                role="tab"
                aria-selected={modus === 'uebersicht'}
                className={modus === 'uebersicht' ? 'active' : ''}
                onClick={() => setModus('uebersicht')}
              >
                Übersicht
              </button>
              <button
                role="tab"
                aria-selected={modus === 'messwerte'}
                className={modus === 'messwerte' ? 'active' : ''}
                onClick={() => setModus('messwerte')}
              >
                Messwerte
              </button>
            </div>
          </div>
          {modus === 'uebersicht' ? (
            <EnergieUebersicht site={site} range={range} anchor={anchor} />
          ) : (
            <VerlaufExplorer
              site={site}
              range={range}
              anchor={anchor}
              initialTargets={init.targets}
            />
          )}
        </>
      ) : (
        <ErloeseFace site={site} range={range} anchor={anchor} />
      )}
    </>
  );
}
