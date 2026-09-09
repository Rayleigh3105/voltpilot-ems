import { useEffect, useRef, useState } from 'react';
import { api, type SiteTopology, type SiteUsageProfile } from './api';
import { hasTopology } from './adaptiveLive';
import { useFreshnessPoll } from './useFreshnessPoll';
// LIVE: die Topologie trägt die gemessenen Ist-Werte des Energieflusses.
import { LIVE_POLL_MS } from './pollCadence';

/**
 * Fetches the AE1 topology read-model + the AE7 usage profile of a site for the
 * adaptive live view, with a silent background poll (the topology carries live
 * values). Fail-soft: `topology`/`profile` degrade to `null` on error and
 * `adaptive` degrades to `false` — the SAME shape whether the site simply has
 * no v2 entities yet or the fetch genuinely broke.
 *
 * `failed` is the ONE extra signal callers need to tell those two apart: it is
 * true only when the decision-critical `/topology` call itself threw (not a
 * "no data" 200). The Anlagen-Seite's `anlageDecision` gate consumes it to
 * show an honest error state instead of silently guessing a layout while the
 * backend is unreachable (Captain-Nachtrag 06.08.2026).
 */
export interface AdaptiveLive {
  topology: SiteTopology | null;
  profile: SiteUsageProfile | null;
  /** true once loaded AND the site has a renderable topology. */
  adaptive: boolean;
  loading: boolean;
  /** true = the decision-critical `/topology` fetch failed. */
  failed: boolean;
}

/**
 * `retryKey` (default 0): bump it (e.g. on an "Erneut versuchen" click) to
 * force a fresh fetch of the SAME site without an identity change - the effect
 * depends on it exactly like `siteId`.
 */
export function useAdaptiveLive(siteId: string, retryKey: number | string = 0): AdaptiveLive {
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [profile, setProfile] = useState<SiteUsageProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Latest siteId for the stable poll interval.
  const idRef = useRef(siteId);
  idRef.current = siteId;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    setTopology(null);
    setProfile(null);
    // Topology drives the stack decision; the profile is best-effort emphasis,
    // so only a topology failure counts as decision-critical.
    api.topology(siteId).then(
      (topo) => {
        if (!active) return;
        setTopology(topo);
        setLoading(false);
      },
      () => {
        if (!active) return;
        setFailed(true);
        setLoading(false);
      },
    );
    api.usageProfile(siteId).then(
      (prof) => { if (active) setProfile(prof); },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [siteId, retryKey]);

  // Silent live poll of the topology values (keeps the last good values on a
  // failure); the profile changes rarely, so it is not re-polled.
  // `useFreshnessPoll` statt eines nackten Intervalls: ein verdeckter Tab wird
  // gedrosselt/eingefroren, der zurückkehrende Kunde sähe sonst erst den
  // Stand von vorhin und den echten 30 s später.
  useFreshnessPoll(() => {
    api.topology(idRef.current).then(
      (t) => setTopology((prev) => (t && t.entities.length ? t : prev)),
      () => {},
    );
  }, LIVE_POLL_MS);

  return { topology, profile, adaptive: !loading && hasTopology(topology), loading, failed };
}
