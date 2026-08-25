import { useEffect, useState } from 'react';
import { api, type Site, type SiteEntity } from './api';
import { customerFlowApi } from './flows/flowsApi';
import { profileStatesFrom, type SiteProfiles } from './profiles';
import {
  aufmerksamkeit,
  type Aufmerksamkeit,
} from './steuerungAufmerksamkeit';
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
 *
 * `failed` is the ONE extra signal a caller needs to tell "successfully loaded,
 * genuinely no entities" apart from "the decision-critical `/entities` call
 * itself broke" — true only for the latter. The Anlagen-Seite's
 * `anlageDecision` gate consumes it to show an honest error state instead of
 * silently guessing a layout while the backend is unreachable (Captain-Nachtrag
 * 06.08.2026).
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
  /** true = the decision-critical `/entities` fetch failed. */
  failed: boolean;
  /**
   * Steuerung Stufe 8: was an dieser Anlage AUFMERKSAMKEIT braucht — die Zahl
   * hinter dem Nav-Abzeichen. Eine Anlage ohne Handeingriff und ohne bremsende
   * Regel liefert 0, und 0 rendert kein Abzeichen.
   *
   * ⚠ Die zwei Zusatz-Abrufe sind bewusst die BILLIGEN: `/interventions` ist
   * der EINE Lesepfad der Jetzt-Zone, `/entity-strategies` ein schmales
   * Aggregat über die aktiven Flows. Die Vorschläge bleiben ungezählt (die
   * Begründung steht in `steuerungAufmerksamkeit.ts`) — die Schale lädt nicht
   * die halbe Steuerungs-Seite, nur um eine Zahl zu malen.
   */
  aufmerksam: Aufmerksamkeit;
}

/**
 * `retryKey` (default 0): bump it (e.g. on an "Erneut versuchen" click) to
 * force a fresh fetch of the SAME site without an identity change - included
 * in the effect's dependencies exactly like `siteId`.
 */
export function useAnlageSurface(
  site: Site | null,
  retryKey: number | string = 0,
): AnlageSurfaceState {
  const [surface, setSurface] = useState<AnlageSurface | null>(null);
  const [profiles, setProfiles] = useState<SiteProfiles | null>(null);
  const [entityList, setEntityList] = useState<SiteEntity[] | null>(null);
  const [loading, setLoading] = useState(site != null);
  const [failed, setFailed] = useState(false);
  const [aufmerksam, setAufmerksam] = useState<Aufmerksamkeit>(() => aufmerksamkeit(null));

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
      setFailed(false);
      setAufmerksam(aufmerksamkeit(null));
      return undefined;
    }
    let active = true;
    setLoading(true);
    setFailed(false);
    // Only `/entities` is decision-critical (it is what `hasEntities` reads);
    // profile/flows/profileStates stay best-effort as before.
    let entitiesFailed = false;
    Promise.all([
      api.usageProfile(siteId).catch(() => null),
      api.siteEntities(siteId).catch(() => {
        entitiesFailed = true;
        return null;
      }),
      customerFlowApi(siteId)
        .list()
        .catch(() => null),
      // M3: the stored profile intent is an OVERLAY over the derivation.
      // Fail-soft like everything else here - an older backend simply yields
      // no states, and the surface is byte-identical to before M3.
      api.siteProfiles(siteId).catch(() => null),
      // Steuerung Stufe 8 · die zwei Quellen des Aufmerksamkeits-Abzeichens.
      // Fail-soft wie alles hier: ohne Antwort zählt die Ableitung schlicht
      // nichts - nie eine erfundene Zahl an der Seitenleiste.
      api.siteInterventions(siteId).catch(() => null),
      api.entityStrategies(siteId).catch(() => null),
    ]).then(([profile, entities, flows, shelf, eingriffe, strategien]) => {
      if (!active) return;
      setProfiles(shelf);
      setAufmerksam(
        aufmerksamkeit({
          automationPaused: eingriffe?.automationPaused ?? null,
          eingriffe: eingriffe?.interventions ?? null,
          ansprueche: strategien ?? null,
          // NICHT bewertet - siehe den Kopf von `steuerungAufmerksamkeit.ts`.
          vorschlaege: null,
          now: new Date(),
        }),
      );
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
      setFailed(entitiesFailed);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [siteId, plantKind, tarifArt, netzladen, leistungspreis, retryKey]);

  return { surface, profiles, entities: entityList, loading, failed, aufmerksam };
}
