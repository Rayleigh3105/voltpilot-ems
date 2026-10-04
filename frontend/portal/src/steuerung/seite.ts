/**
 * Das Bild der ganzen Seite aus den geladenen Daten - EIN Aufruf, rein.
 * Die Reiter lesen nur daraus; keiner leitet etwas zweites Mal ab.
 */
import { liste } from './liste';
import type { SiteProfile } from '../profiles';
import {
  SPEICHER,
  geraete,
  ordnen,
  reihen,
  reihenfolgeAus,
  speicherBild,
  type GeraetBild,
  type Reihen,
  type SpeicherBild,
} from './bild';
import { funktionsLage, type FunktionsLage } from './funktion';
import { einordnen, type Einordnung } from './neu';
import { bezugAus, greift, regelKarten } from './regeln';
import type { SteuerungDaten } from './useSteuerungDaten';
import { szenenStand, type SzenenStand } from './szenen';
import { raster, type Raster } from './zeit';

export interface SeitenBild {
  raster: Raster;
  reihen: Reihen;
  geraete: GeraetBild[];
  speicher: SpeicherBild | null;
  /** Die Reihenfolge, wie der Server sie liest (`sp` = Speicher). */
  reihenfolge: string[];
  /** Die Plätze für Sonnenstrom (mit Speicher) und die übrigen gesteuerten Geräte. */
  rang: string[];
  rest: string[];
  einordnung: Einordnung;
  pausiertBisMs: number | null;
  /** Ein laufender Speicher-Eingriff: Laden (an) oder Halten (aus). */
  speicherEingriff: { art: 'aus' | 'an'; bisMs: number | null } | null;
  /** Das laufende Betriebsmodell des Speichers (Name), sonst Eigenverbrauch. */
  betriebsmodell: string;
  ladepunkte: GeraetBild[];
  /** Die laufende Szene (E6), sonst `null`. */
  szene: SzenenStand | null;
  /** „Steuern & Optimieren“ dieser Anlage: Ruhe, Teilnahme, Bänder, Sperre. */
  funktion: FunktionsLage;
}

/** Das Betriebsmodell, das den Speicher gerade fährt (die exklusive Gruppe). */
export function laufendesModell(profiles: SiteProfile[] | null | undefined): SiteProfile | null {
  return liste(profiles).find((p) => p.exklusivGruppe === 'speicher' && p.active) ?? null;
}

export function seitenBild(d: SteuerungDaten, now: Date, siteId = ''): SeitenBild {
  const r = raster(now);
  const funktion = funktionsLage(d.funktionen, siteId);
  const rh = reihen({ raster: r, verlauf: d.verlauf, plan: d.plan, preise: d.preise, wetter: d.wetter, live: d.live });
  // Welche aktive Regel greift gerade? (Die Bedingung gilt jetzt.)
  const regelJetzt: Record<string, string> = {};
  const rhJetzt = rh;
  for (const k of regelKarten(d.flows, bezugAus(d.editorEntities), {})) {
    if (!k.an || !k.entwurf) continue;
    if (greift(k.entwurf, rhJetzt, r.jetzt, r.jetzt + 1)[0]) regelJetzt[k.entwurf.dann.g] = k.name;
  }
  const szene = szenenStand(d.szene);
  const gs = geraete({
    raster: r,
    reihen: rh,
    verbraucher: d.verbraucher,
    consumers: d.consumers,
    status: d.status,
    overrides: d.overrides,
    charging: d.charging,
    interventions: d.interventions,
    consumerPlan: d.consumerPlan,
    gemessen: d.gemessen,
    regelJetzt,
    szene: szene ? { name: szene.def.name, ids: szene.ids } : null,
  });
  const reihenfolge = reihenfolgeAus(d.verbraucher?.rangliste);
  const batterie = liste(d.assets).find((a) => a.type === 'battery') ?? null;
  const hatSpeicher = reihenfolge.includes(SPEICHER) || batterie != null;
  const { rang, rest } = ordnen(reihenfolge, gs, hatSpeicher);
  const speicherName = liste(d.verbraucher?.rangliste).find((e) => e.art === 'speicher')?.name ?? null;
  const speicher = hatSpeicher
    ? speicherBild({
        raster: r,
        reihen: rh,
        name: speicherName,
        kwh: batterie?.capacityKwh ?? null,
        kw: batterie?.maxChargeKw ?? null,
        reservePct: d.plan?.effectiveFloorSocPct ?? null,
      })
    : null;
  const bis = d.interventions?.automationPaused ? Date.parse(d.interventions.pausedUntil ?? '') : NaN;
  const modell = laufendesModell(d.profiles?.profiles);
  const einordnung = einordnen(gs, d.vorschlaege, r.nowMs);
  if (funktion.ohneTeilnahme) {
    // Steuern-Regel #779: wer nicht teilnimmt, bekommt keinen Vorschlag.
    einordnung.still = einordnung.neu;
    einordnung.neu = [];
  }
  const iv = liste(d.interventions?.interventions).find(
    (x) => /^speicher_/.test(x.kind) && Date.parse(x.endsAt) > r.nowMs,
  );
  return {
    raster: r,
    reihen: rh,
    geraete: gs,
    speicher,
    reihenfolge: [...rang, ...rest],
    rang,
    rest,
    einordnung,
    pausiertBisMs: d.interventions?.automationPaused ? (Number.isFinite(bis) ? bis : r.nowMs) : null,
    speicherEingriff: iv ? { art: iv.kind === 'speicher_laden' ? 'an' : 'aus', bisMs: Date.parse(iv.endsAt) } : null,
    betriebsmodell: modell?.label ?? 'Eigenverbrauch',
    ladepunkte: gs.filter((g) => g.eintrag.ladepunkt),
    szene,
    funktion,
  };
}

/** Welches Blatt gerade offen ist. */
export type BlattZustand =
  | { art: 'geraet'; id: string; modus?: 'aus' | 'an' }
  | { art: 'speicher' }
  | { art: 'pause' }
  | { art: 'vorrang' }
  | { art: 'p14a' }
  | { art: 'negativ' }
  | { art: 'anbinden' }
  | { art: 'neu'; id: string }
  | { art: 'rahmen' }
  | { art: 'ziel'; id: string }
  | { art: 'fahrzeug'; tagRef: string }
  | { art: 'regel'; flowId?: string; geraet?: string; vorlage?: string }
  | { art: 'szene'; id: string };
