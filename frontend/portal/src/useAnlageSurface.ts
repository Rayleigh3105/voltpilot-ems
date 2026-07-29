import { useEffect, useState } from 'react';
import { api, type Site, type SiteEntity } from './api';
import { customerFlowApi } from './flows/flowsApi';
import { profileStatesFrom, type SiteProfiles } from './profiles';
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
  /** The M3 profile shelf (null = older backend / not loaded — fail-soft). */
  profiles: SiteProfiles | null;
  /**
   * The raw v2 entities this hook already fetched. Exposed so the live surfaces
   * can match a source to its component by PIN (`edgeSourceId` / `orphanedPin`,
   * `vp-pin-werte-f8`) WITHOUT a second request. null = older backend / failed.
   */
  entities: SiteEntity[] | null;
  loading: boolean;
}

export function useAnlageSurface(site: Site | null): AnlageSurfaceState {
  const [surface, setSurface] = useState<AnlageSurface | null>(null);
  const [profiles, setProfiles] = useState<SiteProfiles | null>(null);
  const [entityList, setEntityList] = useState<SiteEntity[] | null>(null);
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
      setProfiles(null);
      setEntityList(null);
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
      // M3: the stored profile intent is an OVERLAY over the derivation.
      // Fail-soft like everything else here - an older backend simply yields
      // no states, and the surface is byte-identical to before M3.
      api.siteProfiles(siteId).catch(() => null),
    ]).then(([profile, entities, flows, shelf]) => {
      if (!active) return;
      setProfiles(shelf);
      setEntityList(entities?.entities ?? null);
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
          profileStates: profileStatesFrom(shelf),
        }),
      );
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [siteId, plantKind, tarifArt, netzladen, leistungspreis]);

  return { surface, profiles, entities: entityList, loading };
}
