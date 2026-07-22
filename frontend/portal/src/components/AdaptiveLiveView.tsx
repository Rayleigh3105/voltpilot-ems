import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteTopology, SiteUsageProfile } from '../api';
import {
  composeAdaptiveSentence,
  deriveTiles,
  liveState,
  profileChip,
  type AdaptiveTile,
} from '../adaptiveLive';
import { flowModuleCards } from '../flowModules';
import { isUsageProfile, type UsageProfile } from '../usageProfile';
import { AdaptiveEnergyFlow } from './AdaptiveEnergyFlow';

/**
 * AE2 + AE3 adaptive live view: the status sentence, the N-node role-grouped
 * energy-flow diagram, the entity/role-driven verdict tiles, and the module
 * strip that reflects the site's active strategy nodes ("Was läuft"). Driven by
 * the AE1 topology read-model + the AE7 usage profile (the whole view consults
 * the emphasis map for prominence). Renders only for migrated sites; un-migrated
 * sites keep the byte-identical v1 LiveHero (the host decides via
 * `hasTopology`). All derivation is the pure adaptiveLive.ts / flowModules.ts.
 */
export function AdaptiveLiveView({
  topology,
  profile,
  siteFresh = null,
}: {
  topology: SiteTopology;
  profile: SiteUsageProfile | null;
  /**
   * The ANLAGE's own telemetry freshness (the "Stand vor X" chip / the Verlauf
   * chart). Passed in so this view can never claim an outage while the chart
   * right below shows current curves (G3). null = unknown (older caller).
   */
  siteFresh?: boolean | null;
}) {
  // ONE freshness truth: per-entity health first, the Anlage's telemetry as the
  // honest middle ground, "stale" only when neither source is current.
  const entityFresh = topology.entities.some((e) => e.health === 'ok');
  const state = liveState({ entityFresh, siteFresh });
  const fresh = state !== 'stale';
  const sentence = composeAdaptiveSentence(topology, state);
  const tiles = deriveTiles(topology);

  const usageProfile: UsageProfile = isUsageProfile(profile?.usageProfile)
    ? (profile!.usageProfile as UsageProfile)
    : 'private';
  const chip = profileChip(usageProfile);
  const modules = flowModuleCards(usageProfile, profile?.signals.activeStrategyNodeTypes ?? []);
  // Emphasis (AE7): the live view leads with the flow when it is prominent.
  const flowProminent = profile?.emphasis.flow === 'prominent';

  return (
    <div className={`vp-live-hero vp-adaptive-live${flowProminent ? ' flow-prominent' : ''}`}>
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

      <AdaptiveEnergyFlow topology={topology} stale={!fresh} />

      <div className={`vp-verdict-grid${fresh ? '' : ' vp-stale'}`}>
        {tiles.map((t) => (
          <TileCard key={t.key} tile={t} />
        ))}
      </div>

      {modules.length > 0 && (
        <section className="vp-flowmods">
          <h3 className="vp-flowmods-head">
            Was läuft <span className="vp-tag">spiegelt Ihren Flow</span>
          </h3>
          <div className="vp-flowmod-grid">
            {modules.map((m) => (
              <div key={m.id} className={`vp-flowmod${m.state === 'gated' ? ' locked' : ''}`}>
                <div className="vp-flowmod-top">
                  <span className="vp-flowmod-title">{m.title}</span>
                  {m.state === 'active' ? (
                    <span className="vp-flowmod-state active">läuft</span>
                  ) : (
                    <span className="vp-flowmod-state gated">
                      <Icon name="lock" size={12} /> VoltPilot
                    </span>
                  )}
                </div>
                <p className="vp-flowmod-line">{m.line}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One verdict tile: icon + title, value, state, optional SoC bar / device switches. */
function TileCard({ tile }: { tile: AdaptiveTile }) {
  return (
    <div className={`vp-verdict ${tile.tileClass}`}>
      <span className="vp-verdict-head">
        <span className="vp-verdict-ico">
          <Icon name={tile.icon} size={16} />
        </span>
        {tile.title}
      </span>
      <span className="vp-verdict-val">{tile.value}</span>
      <span className={`vp-verdict-state${tile.stateTone === 'muted' ? ' muted' : ''}`}>
        {tile.arrow && <Icon name={tile.arrow === 'up' ? 'arrow-up' : 'arrow-down'} size={14} />}
        {tile.stateLabel}
      </span>
      {tile.subLine && <span className="vp-verdict-sub">{tile.subLine}</span>}
      {tile.socPct != null && (
        <span className="vp-verdict-soc" aria-hidden="true">
          <span style={{ width: `${tile.socPct}%` }} />
        </span>
      )}
      {tile.control && (
        <span
          className="vp-verdict-sw"
          role="group"
          aria-label="Steuerung – bald verfügbar"
          title="Steuerung folgt (in Vorbereitung)"
        >
          {tile.control.options.map((opt, i) => (
            <button
              key={opt}
              type="button"
              className={i === tile.control!.defaultIndex ? 'act' : ''}
              disabled
              aria-disabled="true"
            >
              {opt}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
