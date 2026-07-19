import { useEffect, useRef, useState } from 'react';
import { api, type SiteTopology, type SiteUsageProfile } from './api';
import { hasTopology } from './adaptiveLive';

/**
 * Fetches the AE1 topology read-model + the AE7 usage profile of a site for the
 * adaptive live view, with a silent background poll (the topology carries live
 * values). Fail-soft: any error, or a site that has no v2 entities yet
 * (`adaptive === false`), leaves the host to render the byte-identical v1 view -
 * so un-migrated sites are unaffected.
 */
export interface AdaptiveLive {
  topology: SiteTopology | null;
  profile: SiteUsageProfile | null;
  /** true once loaded AND the site has a renderable topology. */
  adaptive: boolean;
  loading: boolean;
}

const POLL_MS = 30_000;

export function useAdaptiveLive(siteId: string): AdaptiveLive {
  const [topology, setTopology] = useState<SiteTopology | null>(null);
  const [profile, setProfile] = useState<SiteUsageProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Latest siteId for the stable poll interval.
  const idRef = useRef(siteId);
  idRef.current = siteId;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTopology(null);
    setProfile(null);
    // Topology drives the fallback decision; the profile is best-effort emphasis.
    Promise.all([
      api.topology(siteId).catch(() => null),
      api.usageProfile(siteId).catch(() => null),
    ]).then(([topo, prof]) => {
      if (!active) return;
      setTopology(topo);
      setProfile(prof);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [siteId]);

  // Silent live poll of the topology values (keeps the last good values on a
  // failure); the profile changes rarely, so it is not re-polled.
  useEffect(() => {
    const timer = setInterval(() => {
      api.topology(idRef.current).then(
        (t) => setTopology((prev) => (t && t.entities.length ? t : prev)),
        () => {},
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return { topology, profile, adaptive: !loading && hasTopology(topology), loading };
}
