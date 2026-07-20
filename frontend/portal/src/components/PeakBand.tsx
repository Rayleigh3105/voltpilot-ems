import { Card } from '../../designsystem/components/core/Card';
import type { PeakShaving } from '../api';
import type { PeakBandView } from '../peakBand';
import { peakCounterfactualTip } from '../moduleSurface';
import { InfoTip } from './InfoTip';

/**
 * U4 - the Peak-Band lead artifact (design vp-ems-ui-overhaul §6 Face 2, AE0
 * mockup `.peak`). A Lastspitzen (peak-shaving) Anlage leads its cockpit with
 * this spitzen-defense band instead of the money hero: the current ¼-hour mean
 * grid import vs. the Ziel (progress bar + red limit marker), then the month's
 * vermiedene Spitze and ersparte Leistungskosten. Money stays below as
 * Nachweis (AE4 `secondary`). Pure derivation in peakBand.ts - this renders.
 */
export function PeakBand({
  view,
  peak,
}: {
  view: PeakBandView;
  peak: PeakShaving | null | undefined;
}) {
  const tip = peak != null ? peakCounterfactualTip(peak) : null;
  return (
    <Card padding="lg" radius="lg" className="vp-peakband" style={{ minWidth: 0 }}>
      <div className="vp-peakband-top">
        <div className="vp-peakband-now">
          <span className="vp-card-label">Aktuelle ¼-Stunde</span>
          <span className={`vp-peakband-value${view.fresh ? '' : ' vp-stale'}`}>
            {view.currentLabel}
          </span>
        </div>

        <div className="vp-peakband-bar-wrap">
          <div
            className={`vp-peakband-bar${view.breach ? ' breach' : ''}`}
            role="img"
            aria-label={
              view.targetLabel
                ? `Aktueller Netzbezug ${view.currentLabel}, ${view.targetLabel}`
                : `Aktueller Netzbezug ${view.currentLabel}`
            }
          >
            {view.fillPct != null && (
              <div className="vp-peakband-fill" style={{ width: `${view.fillPct}%` }} />
            )}
            {view.limitPct != null && (
              <>
                <div className="vp-peakband-limit" style={{ left: `${view.limitPct}%` }} />
                <div className="vp-peakband-limit-lbl" style={{ left: `${view.limitPct}%` }}>
                  {view.targetLabel}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {view.metrics.length > 0 && (
        <div className="vp-peakband-metrics">
          {view.metrics.map((m, i) => (
            <div className="vp-peakband-metric" key={m.label}>
              <span className="vp-peakband-metric-lbl">
                {m.label}
                {i === 0 && tip && (
                  <InfoTip label="Vermiedene Spitze erklären">{tip}</InfoTip>
                )}
              </span>
              <span className={`vp-peakband-metric-val${m.tone === 'good' ? ' good' : ''}`}>
                {m.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {view.note && <p className="vp-peakband-note vp-note">{view.note}</p>}
    </Card>
  );
}
