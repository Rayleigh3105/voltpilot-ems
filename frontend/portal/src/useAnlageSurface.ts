import { useEffect, useState } from 'react';
import { api, type Site } from './api';
import { customerFlowApi } from './flows/flowsApi';
import { anlageSurface, type AnlageSurface, type SurfaceFlow } from './surface';

/**
 * M1: the shell's consumer of the M0 read-model. Composes `anlageSurface`
 * from the shipped endpoints (AE7 signals, the flows list, the `SiteDto` money
 * echo, the v2 entities) — there is deliberately NO `GET /sites/{id}/surface`
 * (report §1.2: the derivation is a pure client module first).
 *
 * Fail-soft by construction (the `useAdaptiveLive` precedent): every call is
 * `.catch(() => …)`-ed, so an older backend or a transient blip simply yields
 * a surface with no modes — the trio still renders, Steuerung just carries no
 * badge and the mode-scoped nav group stays hidden. It never blocks the shell.
 */
export interface AnlageSurfaceState {
  surface: AnlageSurface | null;
  loading: boolean;
}

export function useAnlageSurface(site: Site | null): AnlageSurfaceState {
  const [surface, setSurface] = useState<AnlageSurface | null>(null);
  const [loading, setLoading] = useState(site != null);

  const siteId = site?.id ?? null;
  // The money/contract master data comes from the SiteDto we already hold, so
  // the effect only depends on the fields the derivation actually reads.
  const plantKind = site?.plantKind ?? null;
  const tarifArt = site?.tarifArt ?? null;
  const netzladen = site?.netzladenErlaubt ?? null;
  const leistungspreis = site?.leistungspreisEurKw ?? null;

  useEffect(() => {
    if (!siteId) {
      setSurface(null);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    Promise.all([
      api.usageProfile(siteId).catch(() => null),
      api.siteEntities(siteId).catch(() => null),
      customerFlowApi(siteId)
        .list()
        .catch(() => null),
    ]).then(([profile, entities, flows]) => {
      if (!active) return;
      setSurface(
        anlageSurface({
          signals: profile?.signals ?? null,
          config: {
            plantKind,
            tarifArt,
            netzladenErlaubt: netzladen,
            leistungspreisEurKw: leistungspreis,
          },
          // FlowSummary is structurally a SurfaceFlow (report §1.2).
          flows: (flows as SurfaceFlow[] | null) ?? null,
          entities: entities?.entities ?? null,
        }),
      );
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [siteId, plantKind, tarifArt, netzladen, leistungspreis]);

  return { surface, loading };
}
