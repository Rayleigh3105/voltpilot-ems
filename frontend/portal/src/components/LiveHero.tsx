import { buildSnapshot, composeStatusSentence } from '../live';
import type { SiteSource, TelemetryPoint } from '../api';
import type { LivePulsRow, Spark } from '../livePuls';
import { EnergyFlow } from './EnergyFlow';
import { LivePuls } from './LivePuls';
import { PvBreakdownLine } from './PvBreakdown';

/**
 * The v1 Live-Daten view (un-migrated / entity-less site): the German status
 * sentence, the animated energy-flow diagram (unchanged) and the NEW
 * Komponenten-Board — flow left, board right on a wide screen. The board's
 * four site-level rows (PV / Batterie / Haus / Netz) replace the old flat
 * verdict tiles, each with a 60-minute sparkline and a „Verlauf →" jump into
 * the v1 explorer tree. Signs never reach the customer: the board rows speak
 * direction words (the pure live.ts / livePuls.ts derivations). When the newest
 * sample is past the liveness window everything keeps its last-good value but
 * dims, and the sentence goes honest-grey.
 */
export function LiveHero({
  points,
  fresh,
  sources = null,
  rows,
  sparks,
  onOpenVerlauf,
}: {
  points: TelemetryPoint[];
  fresh: boolean;
  /**
   * The site's measurement points, when known: a multi-inverter site then shows
   * WHICH devices the one Solar figure is made of. null/single = no breakdown.
   */
  sources?: SiteSource[] | null;
  /** The Komponenten-Board rows (livePuls.v1FallbackRows) + their sparklines. */
  rows: LivePulsRow[];
  sparks: Map<string, Spark | null>;
  onOpenVerlauf: (target: { entityId: string; channel: string }) => void;
}) {
  const snap = buildSnapshot(points);
  const sentence = composeStatusSentence(snap, fresh);
  const dim = !fresh;

  return (
    <div className="vp-live-hero">
      <p className={`vp-status-line${sentence.live ? '' : ' stale'}`} aria-live="polite">
        <span className="vp-status-dot" aria-hidden="true" />
        <span>{sentence.text}</span>
      </p>

      <div className="vp-live-split">
        <div className={`vp-live-flow${dim ? ' vp-stale' : ''}`}>
          <EnergyFlow snapshot={snap} stale={dim} />
        </div>
        <div className={dim ? 'vp-stale' : ''}>
          <LivePuls rows={rows} sparks={sparks} onOpenVerlauf={onOpenVerlauf} />
        </div>
      </div>

      {/* Why the Solar number is what it is: the parts of a multi-inverter
          site's composite PV (renders itself away on a single-inverter site). */}
      <PvBreakdownLine sources={sources} />
    </div>
  );
}
