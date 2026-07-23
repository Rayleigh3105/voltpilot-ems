import type { SiteTopology, SiteUsageProfile } from '../api';
import { composeAdaptiveSentence, liveState, profileChip } from '../adaptiveLive';
import type { LivePulsRow, Spark } from '../livePuls';
import { isUsageProfile, type UsageProfile } from '../usageProfile';
import { AdaptiveEnergyFlow } from './AdaptiveEnergyFlow';
import { LivePuls } from './LivePuls';

/**
 * V3 adaptive live view: the status sentence (three-state freshness truth), the
 * N-node role-grouped energy-flow diagram (unchanged), and the NEW
 * Komponenten-Board — flow left, board right on a wide screen. Driven by the
 * AE1 topology read-model. Renders only for migrated sites; un-migrated sites
 * keep the byte-identical v1 view (the host decides via `hasTopology`). All
 * derivation is the pure adaptiveLive.ts / livePuls.ts; this only renders it.
 */
export function AdaptiveLiveView({
  topology,
  profile,
  siteFresh = null,
  rows,
  sparks,
  onOpenVerlauf,
}: {
  topology: SiteTopology;
  profile: SiteUsageProfile | null;
  /**
   * The ANLAGE's own telemetry freshness (the "Stand vor X" chip / the Verlauf
   * chart). Passed in so this view can never claim an outage while the chart
   * right below shows current curves (G3). null = unknown (older caller).
   */
  siteFresh?: boolean | null;
  /** The Komponenten-Board rows (livePuls.componentRows) + their sparklines. */
  rows: LivePulsRow[];
  sparks: Map<string, Spark | null>;
  onOpenVerlauf: (target: { entityId: string; channel: string }) => void;
}) {
  // ONE freshness truth: per-entity health first, the Anlage's telemetry as the
  // honest middle ground, "stale" only when neither source is current.
  const entityFresh = topology.entities.some((e) => e.health === 'ok');
  const state = liveState({ entityFresh, siteFresh });
  const fresh = state !== 'stale';
  const sentence = composeAdaptiveSentence(topology, state);

  const usageProfile: UsageProfile = isUsageProfile(profile?.usageProfile)
    ? (profile!.usageProfile as UsageProfile)
    : 'private';
  const chip = profileChip(usageProfile);

  return (
    <div className="vp-live-hero vp-adaptive-live">
      <div className="vp-adaptive-head">
        <p className={`vp-status-line${sentence.live ? '' : ' stale'}`} aria-live="polite">
          <span className="vp-status-dot" aria-hidden="true" />
          <span>{sentence.text}</span>
        </p>
        {profile && (
          <span className={`vp-profile-chip ${chip.tone}`} title="Nutzungsprofil dieser Anlage">
            {chip.label}
          </span>
        )}
      </div>

      <div className="vp-live-split">
        <div className={`vp-live-flow${fresh ? '' : ' vp-stale'}`}>
          <AdaptiveEnergyFlow topology={topology} stale={!fresh} />
        </div>
        <div className={fresh ? '' : 'vp-stale'}>
          <LivePuls rows={rows} sparks={sparks} onOpenVerlauf={onOpenVerlauf} />
        </div>
      </div>
    </div>
  );
}
