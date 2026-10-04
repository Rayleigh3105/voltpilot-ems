/**
 * Die DATEN der Steuerung: jede Quelle einzeln und fehlertolerant geladen.
 *
 * Eine fehlende Antwort macht nie die ganze Seite leer - sie lässt nur das
 * Stück weg, das sie belegt hätte (`null`). Nur die Verbraucher-Liste trägt
 * die Seite; ohne sie steht ein Fehlersatz mit „Erneut versuchen“.
 *
 * Takt: der Zustand „jetzt“ (Status, Eingriffe, Ladepunkte, Telemetrie)
 * alle 10 s, alles Übrige alle 30 s - dieselben Takte wie im übrigen Portal
 * (`pollCadence.ts`), und verdeckte Tabs fragen nicht.
 */
import { liste } from './liste';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ChargingConfig,
  type Funktionen,
  type History,
  type PriceSeries,
  type RuleEvents,
  type SchedulePlan,
  type Site,
  type SiteAsset,
  type SiteEntities,
  type SiteInterventions,
  type SiteScene,
  type SuggestionStates,
  type TelemetryPoint,
  type WeatherForecast,
} from '../api';
import type { ConsumerSchedule } from '../consumerSchedule';
import { consumersApi } from '../consumers/consumersApi';
import type { Consumer } from '../consumers/types';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { ManualOverride } from '../consumers/fulfillment';
import type { SiteCharging } from '../ladepunkte';
import type { SiteVerbraucher } from '../verbraucherZone';
import type { SiteFahrzeuge } from '../fahrzeugProfile';
import type { SiteProfiles } from '../profiles';
import { customerFlowApi, type FlowSummary } from '../flows/flowsApi';
import type { EditorEntity } from '../flows/model';
import { LIST_POLL_MS, LIVE_POLL_MS } from '../pollCadence';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { raster, slotVon, N } from './zeit';

export interface SteuerungDaten {
  verbraucher: SiteVerbraucher | null;
  consumers: Consumer[] | null;
  status: ConsumerRuntimeStatus[] | null;
  overrides: ManualOverride[] | null;
  charging: SiteCharging | null;
  chargingConfig: ChargingConfig | null;
  interventions: SiteInterventions | null;
  plan: SchedulePlan | null;
  consumerPlan: ConsumerSchedule | null;
  verlauf: History | null;
  preise: PriceSeries | null;
  wetter: WeatherForecast | null;
  live: TelemetryPoint[] | null;
  assets: SiteAsset[] | null;
  profiles: SiteProfiles | null;
  fahrzeuge: SiteFahrzeuge | null;
  flows: FlowSummary[] | null;
  editorEntities: EditorEntity[] | null;
  ruleEvents: RuleEvents | null;
  entities: SiteEntities | null;
  vorschlaege: SuggestionStates | null;
  /** Die laufende Szene (E6); `null` = unbekannt, `scene: null` = keine. */
  szene: SiteScene | null;
  /** „Steuern & Optimieren“ (UEMS `/funktionen`); `null` = unbekannt - die Seite behauptet dann nichts. */
  funktionen: Funktionen | null;
  /** Gemessene Leistung je Gerät heute (kW je Viertelstunde). */
  gemessen: Record<string, (number | null)[]>;
}

const LEER: SteuerungDaten = {
  verbraucher: null, consumers: null, status: null, overrides: null, charging: null,
  chargingConfig: null, interventions: null, plan: null, consumerPlan: null, verlauf: null,
  preise: null, wetter: null, live: null, assets: null, profiles: null, fahrzeuge: null,
  flows: null, editorEntities: null, ruleEvents: null, entities: null, vorschlaege: null,
  szene: null, funktionen: null, gemessen: {},
};

const heuteIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

export interface SteuerungLaden {
  daten: SteuerungDaten;
  geladen: boolean;
  fehler: string | null;
  neuLaden: () => void;
  /** Eine Antwort übernehmen, ohne neu zu laden (z. B. die Rangliste nach `PUT`). */
  setze: <K extends keyof SteuerungDaten>(k: K, v: SteuerungDaten[K]) => void;
}

export function useSteuerungDaten(site: Site): SteuerungLaden {
  const [daten, setDaten] = useState<SteuerungDaten>(LEER);
  const [geladen, setGeladen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const siteRef = useRef(site.id);
  siteRef.current = site.id;

  const setze = useCallback(<K extends keyof SteuerungDaten>(k: K, v: SteuerungDaten[K]) => {
    setDaten((d) => ({ ...d, [k]: v }));
  }, []);

  const hole = useCallback(<K extends keyof SteuerungDaten>(k: K, p: Promise<SteuerungDaten[K] | undefined | null>) => {
    const id = site.id;
    return p.then(
      (v) => {
        if (siteRef.current === id) setDaten((d) => ({ ...d, [k]: v ?? null }));
      },
      () => {},
    );
  }, [site.id]);

  const jetzt = useCallback(() => {
    const id = site.id;
    const von = new Date(Date.now() - 20 * 60_000).toISOString();
    return Promise.all([
      hole('status', consumersApi.status(id)),
      hole('overrides', consumersApi.overrides(id)),
      hole('charging', api.siteChargers(id)),
      hole('interventions', api.siteInterventions(id)),
      hole('live', api.telemetry(id, von)),
    ]);
  }, [site.id, hole]);

  const ruhig = useCallback(() => {
    const id = site.id;
    const flowApi = customerFlowApi(id);
    return Promise.all([
      hole('consumers', consumersApi.list(id)),
      hole('chargingConfig', api.chargingConfig(id)),
      hole('plan', api.schedule(id)),
      hole('consumerPlan', api.consumerSchedule(id)),
      hole('verlauf', api.history(id, 'day', heuteIso())),
      hole('preise', api.prices(id)),
      hole('wetter', api.weather(id)),
      hole('assets', api.siteAssets(id)),
      hole('profiles', api.siteProfiles(id)),
      hole('fahrzeuge', api.siteFahrzeuge(id)),
      hole('flows', flowApi.list()),
      hole('editorEntities', flowApi.entities()),
      hole('ruleEvents', api.siteRuleEvents(id)),
      hole('entities', api.siteEntities(id)),
      hole('vorschlaege', api.suggestionStates(id)),
      hole('szene', api.scene(id)),
      hole('funktionen', api.funktionen()),
    ]);
  }, [site.id, hole]);

  const tragend = useCallback(() => {
    const id = site.id;
    return api.siteVerbraucher(id).then(
      (v) => {
        if (siteRef.current !== id) return;
        setDaten((d) => ({ ...d, verbraucher: v }));
        setFehler(null);
      },
      (e: unknown) => {
        if (siteRef.current !== id) return;
        setFehler(e instanceof Error && e.message ? e.message : 'Die Geräte konnten nicht geladen werden.');
      },
    );
  }, [site.id]);

  const neuLaden = useCallback(() => {
    void Promise.all([tragend(), jetzt(), ruhig()]).finally(() => setGeladen(true));
  }, [tragend, jetzt, ruhig]);

  useEffect(() => {
    setDaten(LEER);
    setGeladen(false);
    setFehler(null);
    neuLaden();
  }, [site.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Die gemessene Leistung je Gerät (einmal je Anlage und Liste; dann im Listentakt).
  const ids = liste(daten.verbraucher?.verbraucher).map((v) => v.entityId).join(',');
  const verlaeufe = useCallback(() => {
    const id = site.id;
    const r = raster(new Date());
    for (const e of liste(daten.verbraucher?.verbraucher)) {
      api.entityHistory(id, e.entityId, 'day').then(
        (h) => {
          if (siteRef.current !== id) return;
          const kanal = h.channels.power_kw ?? h.channels.charge_power_kw ?? null;
          if (!kanal) return;
          const reihe: (number | null)[] = Array.from({ length: N }, () => null);
          for (const b of liste(kanal)) {
            const t = slotVon(r, b.start);
            if (t == null) continue;
            reihe[t] = typeof b.avg === 'number' ? b.avg : null;
          }
          setDaten((d) => ({ ...d, gemessen: { ...d.gemessen, [e.entityId]: reihe } }));
        },
        () => {},
      );
    }
  }, [site.id, ids]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ids) verlaeufe();
  }, [ids, verlaeufe]);

  useFreshnessPoll(() => void jetzt(), LIVE_POLL_MS);
  useFreshnessPoll(() => {
    void tragend();
    void ruhig();
    verlaeufe();
  }, LIST_POLL_MS);

  return { daten, geladen, fehler, neuLaden, setze };
}
