/**
 * Shared simulation surfaces: the result view (headline sentence, 3-way
 * scenario cards, monthly chart, Beispieltag dispatch, Größen-Sweep, honest
 * footnote) plus the `useSimulationJob` polling hook. Consumed by the flow
 * editor's dry-run. All wording/derivation is the pure src/simulation.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { ApiError } from '../api';
import { BAR, STROKE } from '../chartStyle';
import { chartTheme } from '../chartTheme';
import { useEChart } from '../useEChart';
import { eurAmount, fmtNum } from '../format';
import {
  assumptionsFootnote,
  beispielDatum,
  headlineSentence,
  monthlyChartData,
  netzladenLine,
  progressLabel,
  scenarioCards,
  sweepChartData,
  sweepInsight,
  type BeispielTag,
  type SimulationRequestInput,
  type SimulationResult,
  type SimulationStatus,
} from '../simulation';
import { ChartInsight, ChartLegend, ChartSubtitle } from './ChartExplain';

const POLL_MS = 2000;

// ---------------------------------------------------------------------------
// Poll loop (shared by customer + admin surfaces)
// ---------------------------------------------------------------------------

export interface SimulationJobApi {
  start: (input: SimulationRequestInput) => Promise<{ simulationId: string }>;
  poll: (simulationId: string) => Promise<SimulationStatus>;
}

/**
 * Drives one job: start -> poll every 2 s -> done/failed. Progressive results
 * (the month bars filling in) render as they arrive.
 */
export function useSimulationJob(jobApi: SimulationJobApi) {
  const [status, setStatus] = useState<SimulationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const jobRef = useRef<string | null>(null);

  const start = useCallback(
    async (input: SimulationRequestInput) => {
      setBusy(true);
      setError(null);
      setStatus(null);
      try {
        const { simulationId } = await jobApi.start(input);
        jobRef.current = simulationId;
        setStatus({ status: 'queued', progress: 0 });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Die Simulation konnte nicht gestartet werden.');
        setBusy(false);
      }
    },
    [jobApi],
  );

  useEffect(() => {
    // `status` is deliberately a dependency: on the FIRST run this effect
    // fires when `busy` flips - BEFORE the start POST resolved and set
    // jobRef - and would otherwise never re-arm (jobRef is a ref, not
    // state). start() sets the first status right after jobRef, so the
    // status dep re-runs the effect once the job id exists.
    if (!busy || jobRef.current == null) return;
    let active = true;
    const timer = setInterval(async () => {
      const id = jobRef.current;
      if (id == null) return;
      try {
        const s = await jobApi.poll(id);
        if (!active) return;
        setStatus(s);
        if (s.status === 'done' || s.status === 'failed') {
          setBusy(false);
          if (s.status === 'failed') setError(s.error ?? 'Die Simulation ist fehlgeschlagen.');
        }
      } catch (e) {
        if (!active) return;
        setBusy(false);
        setError(e instanceof ApiError ? e.message : 'Verbindung zur Simulation verloren.');
      }
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [busy, jobApi, status]);

  return { status, error, busy, start };
}

// ---------------------------------------------------------------------------
// Result view
// ---------------------------------------------------------------------------

export function SimulationRunView({ status, error }: { status: SimulationStatus | null; error: string | null }) {
  if (error) {
    return <div className="vp-alert vp-alert-err">{error}</div>;
  }
  if (status == null) return null;
  const result = status.result;
  return (
    <>
      {(status.status === 'queued' || status.status === 'running') && (
        <div className="vp-sim-progress" role="status">
          <div className="vp-sim-progress-bar">
            <div
              className="vp-sim-progress-fill"
              style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }}
            />
          </div>
          <span>{progressLabel(status)}</span>
        </div>
      )}
      {result && <SimulationResultView result={result} running={status.status !== 'done'} />}
    </>
  );
}

export function SimulationResultView({ result, running }: { result: SimulationResult; running: boolean }) {
  const cards = scenarioCards(result);
  const nlLine = netzladenLine(result.netzladenVariante);
  const monthly = monthlyChartData(result);
  const sweep = sweepChartData(result.sizeSweep);
  const sweepText = sweepInsight(result.sizeSweep);
  return (
    <div className="vp-sim-result">
      {result.headline && (
        <p className="vp-sim-headline">{headlineSentence(result.headline, result.annahmen.preisjahr)}</p>
      )}

      <div className="vp-sim-cards">
        {cards.map((card) => (
          <Card
            key={card.key}
            padding="lg"
            radius="lg"
            className={card.highlight ? 'vp-sim-card vp-sim-card-vp' : 'vp-sim-card'}
          >
            <span className="vp-sim-card-title">{card.title}</span>
            <span className="vp-sim-card-value">
              {card.amountLabel === 'Stromkosten' ? '−' : '+'}
              {card.amount}
            </span>
            <span className="vp-sim-card-kind">
              {card.amountLabel === 'Stromkosten' ? 'Stromkosten im Jahr' : 'Überschuss im Jahr'}
            </span>
            {card.subLines.map((line) => (
              <span key={line} className="vp-sim-card-sub">
                {line}
              </span>
            ))}
          </Card>
        ))}
      </div>

      {nlLine && <p className="vp-sim-netzladen">{nlLine}</p>}

      {monthly && (
        <div className="vp-sim-block">
          <h3>Monat für Monat</h3>
          <ChartSubtitle>
            Ihre Strom-Jahresrechnung je Monat und Szenario - negativ heißt: die Anlage hat verdient.
          </ChartSubtitle>
          <MonthlyChart data={monthly} />
        </div>
      )}

      {result.beispielTage && (
        <div className="vp-sim-block">
          <h3>Ein Tag im Detail</h3>
          <ChartSubtitle>
            So hätten Standard-Speicher und VoltPilot am selben Tag geschaltet - der Preisverlauf erklärt warum.
          </ChartSubtitle>
          <ExampleDayChart tag={result.beispielTage.bester} label="bester Tag" />
        </div>
      )}

      {sweep && (
        <div className="vp-sim-block">
          <h3>Was brächte ein anderer Speicher?</h3>
          <ChartSubtitle>
            Jahresvorteil gegenüber „ohne Speicher" je Speichergröße - der Marker zeigt Ihre Größe.
          </ChartSubtitle>
          <SweepChart data={sweep} />
          {sweepText && <ChartInsight>{sweepText}</ChartInsight>}
        </div>
      )}

      {!running && <p className="vp-sim-footnote">{assumptionsFootnote(result.annahmen)}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function MonthlyChart({ data }: { data: NonNullable<ReturnType<typeof monthlyChartData>> }) {
  const t = chartTheme();
  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 480;
      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 24, right: 8, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            valueFormatter: (v: unknown) => (v == null ? '–' : eurAmount(Number(v))),
          },
          xAxis: {
            type: 'category',
            data: data.labels,
            axisLabel: { hideOverlap: true, color: t.axis },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: {
            type: 'value',
            name: narrow ? '€' : 'Euro',
            splitLine: { lineStyle: { color: t.grid } },
          },
          series: [
            // F9: EIN Breiten-Deckel + Fuge - diese drei Reihen hatten bisher
            // gar keinen, also wuchsen die Balken mit der Containerbreite.
            {
              name: 'Ohne Speicher',
              type: 'bar',
              data: data.ohne,
              barMaxWidth: BAR.maxWidth,
              barCategoryGap: BAR.categoryGap,
              barGap: BAR.seriesGap,
              itemStyle: { color: t.load, borderRadius: BAR.radius },
            },
            {
              name: 'Standard-Speicher',
              type: 'bar',
              data: data.standard,
              barMaxWidth: BAR.maxWidth,
              itemStyle: { color: t.cloud, borderRadius: BAR.radius },
            },
            {
              name: 'Mit VoltPilot',
              type: 'bar',
              data: data.voltpilot,
              barMaxWidth: BAR.maxWidth,
              itemStyle: { color: t.pv, borderRadius: BAR.radius },
            },
          ],
        },
        true,
      );
    },
    [data, t],
  );
  return (
    <div>
      <ChartLegend
        items={[
          { color: t.load, label: 'Ohne Speicher', unit: '€/Monat' },
          { color: t.cloud, label: 'Standard-Speicher', unit: '€/Monat' },
          { color: t.pv, label: 'Mit VoltPilot', unit: '€/Monat' },
        ]}
      />
      <div ref={ref} className="vp-chart" />
    </div>
  );
}

function ExampleDayChart({ tag, label }: { tag: BeispielTag; label: string }) {
  const t = chartTheme();
  const ref = useEChart(
    (chart, width) => {
      const narrow = width < 480;
      const times = tag.slots.map((s) =>
        new Date(s.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
      );
      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 30, right: narrow ? 16 : 52, bottom: 8, left: 8, containLabel: true },
          tooltip: { trigger: 'axis', confine: true },
          xAxis: {
            type: 'category',
            data: times,
            axisLabel: { hideOverlap: true, color: t.axis },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: [
            {
              type: 'value',
              name: narrow ? 'kW' : 'Leistung (kW)',
              splitLine: { lineStyle: { color: t.grid } },
            },
            {
              type: 'value',
              name: 'ct/kWh',
              position: 'right',
              splitLine: { show: false },
              axisLabel: { show: !narrow },
            },
          ],
          series: [
            {
              name: 'VoltPilot Speicher',
              type: 'bar',
              data: tag.slots.map((s) => s.batterieVoltpilotKw),
              barMaxWidth: BAR.maxWidth,
              barCategoryGap: BAR.categoryGap,
              itemStyle: {
                // Dieselbe Speicher-Sprache wie ueberall: EINE Farbe, Umriss =
                // abgeben. Das Kosten-ROT ist hier raus (F5/F10).
                borderRadius: BAR.radius,
                color: (p: { value: number }) => (Number(p.value) >= 0 ? t.charge : t.surface),
                borderColor: t.charge,
                borderWidth: (p: { value: number }) => (Number(p.value) >= 0 ? 0 : 1.2),
              },
            },
            {
              name: 'Standard-Speicher',
              type: 'line',
              step: 'middle',
              symbol: 'none',
              data: tag.slots.map((s) => s.batterieStandardKw),
              lineStyle: { color: t.cloud, width: STROKE.contextSoft, type: 'dashed' },
            },
            {
              name: 'Börsenpreis',
              type: 'line',
              step: 'end',
              symbol: 'none',
              yAxisIndex: 1,
              data: tag.slots.map((s) => Math.round(s.preisEurMwh) / 10),
              lineStyle: { color: t.price, width: STROKE.context },
            },
          ],
        },
        true,
      );
    },
    [tag, t],
  );
  return (
    <div>
      <ChartLegend
        items={[
          { color: t.charge, label: 'VoltPilot lädt', unit: 'kW' },
          { color: t.charge, label: 'VoltPilot entlädt', unit: 'kW', shape: 'outline' },
          { color: t.cloud, label: 'Standard-Speicher', unit: 'kW', shape: 'line' },
          { color: t.price, label: 'Börsenpreis', unit: 'ct/kWh', shape: 'line' },
        ]}
      />
      <div ref={ref} className="vp-chart" />
      <ChartInsight>
        {`${beispielDatum(tag.datum)} (${label}): VoltPilot war hier ${eurAmount(Math.abs(tag.vorteilEur))} ${tag.vorteilEur >= 0 ? 'besser' : 'schlechter'} als der Standard-Speicher.`}
      </ChartInsight>
    </div>
  );
}

function SweepChart({ data }: { data: NonNullable<ReturnType<typeof sweepChartData>> }) {
  const t = chartTheme();
  const ref = useEChart(
    (chart) => {
      chart.setOption(
        {
          textStyle: { fontFamily: t.font, color: t.axis },
          grid: { top: 24, right: 16, bottom: 8, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis',
            confine: true,
            valueFormatter: (v: unknown) => (v == null ? '–' : `+${eurAmount(Number(v))}/Jahr`),
          },
          xAxis: {
            type: 'category',
            data: data.sizes.map((s) => fmtNum(s, 'kWh', 0)),
            axisLabel: { hideOverlap: true, color: t.axis },
            axisTick: { show: false },
            axisLine: { show: false },
          },
          yAxis: {
            type: 'value',
            name: '€/Jahr',
            splitLine: { lineStyle: { color: t.grid } },
          },
          series: [
            {
              name: 'Jahresvorteil',
              type: 'line',
              data: data.gesamt.map((v, i) => ({
                value: v,
                symbolSize: i === data.baseIndex ? 14 : 7,
                itemStyle: i === data.baseIndex ? { color: t.pv, borderColor: t.ink, borderWidth: 2 } : undefined,
              })),
              // F1-Hierarchie: die Sweep-Kurve IST die Aussage der Flaeche.
              lineStyle: { color: t.soc, width: STROKE.lead },
              itemStyle: { color: t.soc },
            },
          ],
        },
        true,
      );
    },
    [data, t],
  );
  return (
    <div>
      <ChartLegend
        items={[{ color: t.soc, label: 'Vorteil gegenüber ohne Speicher', unit: '€/Jahr', shape: 'line' }]}
      />
      <div ref={ref} className="vp-chart compact" />
    </div>
  );
}
