import type { WeatherPoint } from './api';
import { CLOUDY_MIN_CLOUD, SUNNY_MAX_CLOUD } from './weather';

/**
 * **Der Wetter-Tag** - die reinen Ableitungen für den Himmel (Konzept „Preise
 * und Wetter", Fassung 3). Die frühere Wetter-Seite ist entfernt (Konzept
 * `vp-prognosen-konzept`, E2 = A); was von hier noch gebraucht wird, speist
 * den Sonnen-Teppich (`prognoseSeite.ts`): den Himmel über dem Tagesbild und
 * in jeder Zeile des Teppichs.
 *
 *  1. **EIN Wortsatz für den Himmel**: sonnig, wechselnd, bewölkt; nachts
 *     klar oder bewölkt. Die Schwellen sind die des Hauses
 *     ({@link SUNNY_MAX_CLOUD}/{@link CLOUDY_MIN_CLOUD}, `weather.ts`) - kein
 *     zweiter Schwellensatz.
 *  2. **Fehlend ist keine Null.** Eine Stunde ohne Wert bleibt `null`.
 */

/** Was der Himmel in einer Stunde tut. */
export type HimmelArt = 'sonnig' | 'wechselnd' | 'bewoelkt' | 'klar' | 'nachtWolken';

export const HIMMEL_WORT: Readonly<Record<HimmelArt, string>> = {
  sonnig: 'sonnig',
  wechselnd: 'wechselnd',
  bewoelkt: 'bewölkt',
  klar: 'klar',
  nachtWolken: 'bewölkt',
};

/** Unter dieser Sonnenstärke ist es dunkel (W/m²). */
const DUNKEL_WM2 = 5;

const STUNDE_MS = 3600_000;

export interface WetterStunde {
  start: number;
  temp: number | null;
  wolken: number | null;
  ghi: number | null;
  /** Direktstrahlung senkrecht zur Sonne (`dniNormalWM2`, richtig gelesen - N1/S0). */
  dni: number | null;
  art: HimmelArt | null;
}

export function art(wolken: number | null, ghi: number | null): HimmelArt | null {
  if (wolken == null) return null;
  if (ghi != null && ghi <= DUNKEL_WM2) return wolken < CLOUDY_MIN_CLOUD ? 'klar' : 'nachtWolken';
  if (wolken <= SUNNY_MAX_CLOUD) return 'sonnig';
  if (wolken >= CLOUDY_MIN_CLOUD) return 'bewoelkt';
  return 'wechselnd';
}

export function tagesBeginn(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function naechsterTag(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** „Do 22.10." */
export function wochentagDatum(ms: number): string {
  const d = new Date(ms);
  const tag = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
  return `${tag} ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`;
}

function zahl(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Die Vorhersage auf das STUNDEN-Raster: die API liefert stündlich, aber eine
 * feinere Reihe (etwa viertelstündlich) darf weder Sonnenstunden vervielfachen
 * noch „jetzt" auf eine alte Viertelstunde legen. Je volle Stunde das Mittel
 * der Werte, die in sie fallen; eine Größe ohne Wert bleibt `null`.
 */
export function stundenRaster(punkte: readonly WeatherPoint[]): WetterStunde[] {
  const je = new Map<number, WeatherPoint[]>();
  for (const p of punkte) {
    const t = Date.parse(p.ts);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor(t / STUNDE_MS) * STUNDE_MS;
    const liste = je.get(h);
    if (liste) liste.push(p);
    else je.set(h, [p]);
  }
  const mittel = (liste: WeatherPoint[], feld: (p: WeatherPoint) => number | null | undefined) => {
    const werte = liste.map((p) => zahl(feld(p))).filter((v): v is number => v != null);
    return werte.length > 0 ? werte.reduce((a, b) => a + b, 0) / werte.length : null;
  };
  return [...je.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, liste]) => {
      const wolken = mittel(liste, (p) => p.cloudCoverPct);
      const ghi = mittel(liste, (p) => p.ghiWM2);
      return {
        start,
        temp: mittel(liste, (p) => p.temperatureC),
        wolken,
        ghi,
        // N1/S0 (Captain 11.11.2026): die Sonnenstunden rechnen jetzt mit der
        // richtig gelesenen Direktstrahlung senkrecht zur Sonne, nicht mehr
        // mit der waagerechten (historischen) Lesart `dniWM2`.
        dni: mittel(liste, (p) => p.dniNormalWM2),
        art: art(wolken, ghi),
      };
    });
}
