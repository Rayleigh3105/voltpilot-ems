import { useEffect, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { KpiCard } from '../../designsystem/components/shell/KpiCard';
import { api, ApiError, type Earnings, type PeakShaving, type SchedulePlan, type Site } from '../api';
import { abrechnungLabel, lastspitzenProof, peakCounterfactualTip } from '../moduleSurface';
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
export function LastspitzenSection({ site }: { site: Site }) {
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

  return (
    <>
      {/* 1 · PS-4 proof of the running billing period. */}
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">
          Ihre Lastspitze · Abrechnung {abrechnungLabel(peak.abrechnung)}
        </span>
        {proof == null || proof.note ? (
          <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
            {proof?.note ??
              'In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.'}
          </p>
        ) : (
          <div className="vp-kpis" style={{ marginTop: 'var(--vp-space-3)' }}>
            <KpiCard
              icon={<Icon name="activity" size={20} />}
              category="primary"
              value={fmtNum(peak.peakKw, 'kW')}
              label="Gehaltene Spitze diese Periode"
              title="Die höchste Viertelstunden-Bezugsspitze der laufenden Abrechnungsperiode"
            />
            <KpiCard
              icon={<Icon name="trending-up" size={20} />}
              category="dynamic"
              value={`+${fmtNum(peak.avoidedKw, 'kW')}`}
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
              value={`${peak.avoidedEur != null && peak.avoidedEur >= 0 ? '+' : ''}${eur(peak.avoidedEur ?? 0)} €`}
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

      {/* 3 · Fahrplan with the peak-target overlay. */}
      <Card padding="lg" radius="lg" style={{ minWidth: 0, marginTop: 'var(--vp-gap)' }}>
        <span className="vp-card-label">Fahrplan & Ziel-Netzbezug</span>
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
    </>
  );
}
