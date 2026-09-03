import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import { api, ApiError, type Earnings, type PeakShaving, type SchedulePlan, type Site } from '../api';
import {
  abrechnungLabel,
  lastspitzenPerioden,
  lastspitzenProof,
  peakCounterfactualTip,
} from '../moduleSurface';
import {
  VerlaufFuss,
  VerlaufKopf,
  ZeitBlaetterer,
  ZeitLeisteRahmen,
} from '../components/HistorieWelt';
import { useIsPhone } from '../useIsPhone';
import { eur, fmtNum } from '../format';
import { PeakHistoryChart } from '../components/PeakHistoryChart';
import { ScheduleChart } from '../ScheduleChart';
import { InfoTip } from '../components/InfoTip';
import { ChartCardSkeleton, EmptyState, ErrorState, Skeleton } from '../components/States';

/**
 * U4 - the `Lastspitzen` subpage (`#/anlage/{id}/lastspitzen`, design §6 Face 2).
 * The peak-shaving customer's dedicated proof-and-plan view:
 *
 *   1. the PS-4 proof (gehaltene Spitze / vermiedene Spitze / ersparte
 *      Leistungskosten of the running billing period),
 *   2. the per-period history chart (earnings.peakShaving.history),
 *   3. the Fahrplan with the peak-target (Ziel Netzbezug) overlay.
 *
 * All data is customer-reachable (peakShaving from GET /earnings, the target
 * from GET /schedule) - no new endpoint. A site without an active peak-shaving
 * module gets the honest "nicht aktiv" state (deep-link safe, never a crash).
 */
/** Der Lead-Satz des früheren Seitenkopfs (`SUB_PAGES.lastspitzen`, bis P1). */
const LASTSPITZEN_LEAD =
  'Lastspitzenkappung: gehaltene Spitze, vermiedene Leistungskosten und der Fahrplan zum Halten Ihrer Zielspitze.';

export function LastspitzenSection({ site }: { site: Site }) {
  const isPhone = useIsPhone();
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnErr, setEarnErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // peakShaving is range-independent (always the running billing period); month
  // is an arbitrary valid range. Fail-soft: an older backend omits the block.
  useEffect(() => {
    let active = true;
    setEarnings(null);
    setEarnErr(null);
    api.earnings('month').then(
      (e) => active && setEarnings(e),
      (e) => active && setEarnErr(e instanceof ApiError ? e.message : 'Fehler'),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  useEffect(() => {
    let active = true;
    setPlan(null);
    api.schedule(site.id).then(
      (p) => active && setPlan(p),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  const peak: PeakShaving | null =
    earnings?.sites.find((s) => s.id === site.id)?.peakShaving ?? null;

  /**
   * Die blätterbaren Perioden + die gewählte. `idx` steht auf der LAUFENDEN
   * (der letzten), sobald der Abruf da ist — ein Blätterer, der auf einer alten
   * Periode startet, beantwortete die Frage nicht, mit der man herkommt.
   */
  const perioden = useMemo(() => lastspitzenPerioden(peak), [peak]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(Math.max(0, perioden.length - 1));
  }, [perioden.length, site.id]);

  if (earnErr && earnings == null) {
    return (
      <Card padding="lg" radius="lg">
        <ErrorState message={earnErr} onRetry={() => setReloadKey((k) => k + 1)} />
      </Card>
    );
  }

  if (earnings == null) {
    return (
      <Card padding="lg" radius="lg">
        <Skeleton height={140} radius="var(--vp-radius-md)" />
      </Card>
    );
  }

  if (peak == null) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="trending-up"
          title="Lastspitzenkappung ist für diese Anlage nicht aktiv"
          description="Lastspitzenkappung lohnt sich für Gewerbe mit Leistungsmessung: Ihre Batterie kappt die Bezugsspitze Ihres Netzanschlusses und senkt so den Leistungspreis. Einrichtung durch VoltPilot – sprechen Sie uns an."
        />
      </Card>
    );
  }

  const proof = lastspitzenProof(peak);
  const hasHistory = peak.history.length > 0;
  const target = plan?.peakTargetKw ?? null;
  const gezeigt = perioden[idx] ?? null;
  const nichtsGemessen =
    gezeigt == null ||
    gezeigt.peakKw == null ||
    gezeigt.avoidedKw == null ||
    gezeigt.avoidedEur == null;

  return (
    <>
      {/* V1 · Unsichtbarer Seitenkopf (Paket P1): sein Titel + Lead standen im
          `SUB_PAGES`-Kopf ÜBER den Reitern und schoben sie von 140 auf 287 px. */}
      <VerlaufKopf titel="Lastspitzen" />
      {/* V3 · Der Zeitraum dieses Reiters ist die ABRECHNUNGSPERIODE (§4.4) —
          ein Blätterer, kein Segment. Er liest ausschließlich `peak.history`
          (die letzten zwölf gemessenen Perioden inkl. der laufenden); einen
          Endpunkt für den Beweis einer vergangenen Periode gibt es nicht, es
          entsteht also kein neuer Abruf. */}
      <ZeitLeisteRahmen
        mobil={isPhone}
        zeile1={
          <ZeitBlaetterer
            label={gezeigt?.label ?? 'Laufende Periode'}
            onZurueck={() => setIdx((i) => Math.max(0, i - 1))}
            onVor={() => setIdx((i) => Math.min(perioden.length - 1, i + 1))}
            zurueckDisabled={idx <= 0}
            vorDisabled={idx >= perioden.length - 1}
            jetztLabel="Aktuelle Periode"
            onJetzt={
              idx < perioden.length - 1 ? () => setIdx(perioden.length - 1) : undefined
            }
          />
        }
      />

      {/* 1 · PS-4 proof of the SELECTED billing period. */}
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">
          Ihre Lastspitze · Abrechnung {abrechnungLabel(peak.abrechnung)}
        </span>
        {proof == null || nichtsGemessen ? (
          <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
            {gezeigt?.laufend !== false
              ? (proof?.note ??
                'In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.')
              : `Für ${gezeigt.label} liegen keine Messwerte vor.`}
          </p>
        ) : (
          <div className="vp-kpis" style={{ marginTop: 'var(--vp-space-3)' }}>
            <KpiCard
              icon={<Icon name="activity" size={20} />}
              category="primary"
              value={fmtNum(gezeigt.peakKw, 'kW')}
              label={gezeigt.laufend ? 'Gehaltene Spitze diese Periode' : 'Gehaltene Spitze'}
              title="Die höchste Viertelstunden-Bezugsspitze dieser Abrechnungsperiode"
            />
            <KpiCard
              icon={<Icon name="trending-up" size={20} />}
              category="dynamic"
              value={`+${fmtNum(gezeigt.avoidedKw, 'kW')}`}
              label={
                <>
                  Vermiedene Spitze
                  <InfoTip label="Vermiedene Spitze erklären">
                    {peakCounterfactualTip(peak)}
                  </InfoTip>
                </>
              }
              title="Um so viel liegt Ihre Spitze unter der einer Anlage ohne Speichereinsatz"
            />
            <KpiCard
              icon={<Icon name="euro" size={20} />}
              category="dynamic"
              value={`${gezeigt.avoidedEur != null && gezeigt.avoidedEur >= 0 ? '+' : ''}${eur(gezeigt.avoidedEur ?? 0)} €`}
              label="Ersparte Leistungskosten"
              title="Vermiedene Spitze × Leistungspreis"
            />
          </div>
        )}
      </Card>

      {/* 2 · Per-period history. */}
      <Card padding="lg" radius="lg" style={{ minWidth: 0, marginTop: 'var(--vp-gap)' }}>
        <span className="vp-card-label">Bezugsspitzen im Verlauf</span>
        {hasHistory ? (
          <PeakHistoryChart peak={peak} />
        ) : (
          <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
            Sobald mehrere Abrechnungsperioden gemessen wurden, erscheint hier Ihr Verlauf –
            mit und ohne Speichereinsatz.
          </p>
        )}
      </Card>

      {/* 3 · Fahrplan with the peak-target overlay.
          ⚠ Der Fahrplan ist IMMER der kommende — es gibt keinen für eine
          vergangene Periode. Wer zurückgeblättert hat, bekommt das gesagt,
          statt den Plan stillschweigend der falschen Periode zuzuschreiben. */}
      <Card padding="lg" radius="lg" style={{ minWidth: 0, marginTop: 'var(--vp-gap)' }}>
        <span className="vp-card-label">Fahrplan & Ziel-Netzbezug</span>
        {gezeigt != null && !gezeigt.laufend && (
          <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
            Der Fahrplan zeigt immer die kommenden Stunden, nicht {gezeigt.label}.
          </p>
        )}
        {plan == null ? (
          <ChartCardSkeleton stats={0} />
        ) : plan.slots.length === 0 ? (
          <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
            Für heute liegt noch kein Fahrplan vor. Sobald Börsenpreise und Prognosen vorliegen,
            plant VoltPilot den Speichereinsatz zum Halten Ihrer Zielspitze.
          </p>
        ) : (
          <>
            {target != null && (
              <p className="vp-note" style={{ margin: 'var(--vp-space-1) 0 var(--vp-space-2)' }}>
                Der Speicher plant so, dass Ihr Netzbezug unter dem Ziel von{' '}
                <b>{fmtNum(target, 'kW', 0)}</b> bleibt (rote Linie).
              </p>
            )}
            <ScheduleChart plan={plan} peakTargetKw={target} />
          </>
        )}
      </Card>
      {/* V1 · Der Lead-Satz des früheren Seitenkopfs — wörtlich, am Fuß. */}
      <VerlaufFuss text={LASTSPITZEN_LEAD} />
    </>
  );
}
