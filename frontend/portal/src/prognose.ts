import type { ForecastAccuracyPoint, ForecastModelId, ForecastModelState } from './api';
import { NBSP } from './format';

/**
 * Die Mobil-Fassung der Prognosequalität (Konzept `data/vp-mobile-views-x1` §8,
 * Captain-Go 09.08.2026) — reine Ableitungen, der Render ist dünn.
 *
 * Der gemessene Befund war REIHENFOLGE: 5.036 px (6,2 Bildschirme), die mit dem
 * Erklär-Essay beginnen; das erste Diagramm bei 3.437 px; und die eigentliche
 * Antwort — „wie genau sind meine Prognosen?" — musste man sich aus
 * Modell-Karten zusammensuchen. Die Kennzahl dafür EXISTIERT längst, sie stand
 * nur zu weit unten.
 *
 * **Die Rahmung ist load-bearing und bleibt:** 2 Prognosearten × (1 aktives
 * Modell + höchstens 1 Schatten-Kandidat). Sie adressiert die dokumentierte
 * Verwirrung „zwei aktive Prognosen" und darf beim Kürzen nicht verloren
 * gehen — sie wird nur von drei Absätzen auf eine Zeile Struktur eingedampft.
 */

/**
 * Die zwei Prognosearten, überall gleich benannt (die Rahmung hängt daran).
 * Diese Konstante ist die EINE Quelle — `PrognosePage` liest sie, statt eine
 * zweite Liste zu führen.
 */
export const KIND_LABELS: Record<'load' | 'pv', string> = {
  load: 'Verbrauchsprognose (Last)',
  pv: 'PV-Prognose (Erzeugung)',
};

/** Der eine Satz, der die Struktur trägt — Verdikt-Karte UND Aufklapper. */
export const RAHMUNG =
  '2 Prognosearten × je 1 aktives Modell + höchstens 1 lernender Kandidat.';

/** Der eine Ehrlichkeits-Satz unter dem Kandidaten-Status. */
export const KANDIDAT_EHRLICHKEIT =
  'Kandidaten beeinflussen Ihre Steuerung nicht. Ein Wechsel passiert nie automatisch.';

/** „±0,75 kW" — die Abweichung ist ein Betrag, deshalb das ±. */
export function abweichung(kw: number | null): string {
  if (kw == null) return '—';
  return `±${Number(kw).toLocaleString('de-DE', { maximumFractionDigits: 2 })}${NBSP}kW`;
}

export interface VerdiktZeile {
  kind: 'load' | 'pv';
  /** „Verbrauchsprognose (Last)". */
  art: string;
  /** „±0,75 kW" oder „—". */
  wert: string;
  /** „letzte 7 Tage" — oder der ehrliche Grund, warum es keinen Wert gibt. */
  note: string;
}

/**
 * Das Verdikt: 2 Arten × Ø-Abweichung. Es RECHNET nichts Neues — `mittlereMae`
 * ist dieselbe Kennzahl, die die Modell-Karten schon zeigten; sie rückt nur
 * nach oben.
 *
 * Eine Art ohne Bewertung bekommt „—" MIT Grund, nie eine erfundene 0.
 */
export function verdikt(
  accuracy: readonly ForecastAccuracyPoint[],
  aktiv: Record<'load' | 'pv', ForecastModelId>,
  tage = 7,
): VerdiktZeile[] {
  return (['load', 'pv'] as const).map((kind) => {
    const m = mittlereMae(accuracy, aktiv[kind], tage);
    return {
      kind,
      art: KIND_LABELS[kind],
      wert: abweichung(m ? m.mae : null),
      note: m
        ? `letzte ${m.tage} ${m.tage === 1 ? 'Tag' : 'Tage'}`
        : 'noch keine Bewertung',
    };
  });
}

/** Mittlere Ø-Abweichung EINES Modells über seine jüngsten `tage` Bewertungen. */
export function mittlereMae(
  accuracy: readonly ForecastAccuracyPoint[],
  model: ForecastModelId,
  tage = 7,
): { mae: number; tage: number } | null {
  const meine = accuracy
    .filter((a) => a.model === model)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, tage);
  if (meine.length === 0) return null;
  return {
    mae: meine.reduce((s, a) => s + a.maeKw, 0) / meine.length,
    tage: meine.length,
  };
}

/** „In X von Y Bewertungen genauer" — die Tage mit positivem Skill. */
export function skillBilanz(
  accuracy: readonly ForecastAccuracyPoint[],
  model: ForecastModelId,
  tage = 10,
): { besser: number; gesamt: number } | null {
  const bewertet = accuracy
    .filter((a) => a.model === model && a.skillVsBaseline != null)
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, tage);
  if (bewertet.length === 0) return null;
  return {
    besser: bewertet.filter((a) => (a.skillVsBaseline ?? 0) > 0).length,
    gesamt: bewertet.length,
  };
}

export type KandidatTon = 'sammelt' | 'besser' | 'neutral';

export interface KandidatZeile {
  model: ForecastModelId;
  /** Die Prognoseart, gegen die er antritt — „Verbrauch" / „PV-Korrektur". */
  art: string;
  /** Die eine Aussage: „in 10 von 12 Tagen genauer" · „sammelt Daten · Tag 14/21". */
  stand: string;
  ton: KandidatTon;
}

/** Kurzform der Art für die Zwei-Zeilen-Wahrheit (die Karte nennt sie daneben). */
const ART_KURZ: Record<'load' | 'pv', string> = {
  load: 'Verbrauch',
  pv: 'PV-Korrektur',
};

/**
 * Der Kandidaten-Status als ZWEI-ZEILEN-WAHRHEIT (Konzept §8): je Kandidat eine
 * Zeile „Art → Stand", darunter EINMAL der Ehrlichkeits-Satz. Der ganze
 * Schattenbetrieb-Kern in ~90 px statt in drei Karten mit Fortschrittsbalken,
 * Trainings-Datum und Merkmalsliste — die wandern in den Aufklapper.
 *
 * Ehrlich in beide Richtungen: ein sammelnder Kandidat nennt seinen Tag-Stand,
 * ein rechnender ohne Bewertung sagt das, statt eine Quote zu erfinden.
 */
export function kandidatenZeilen(
  kandidaten: readonly ForecastModelState[],
  accuracy: readonly ForecastAccuracyPoint[],
): KandidatZeile[] {
  return kandidaten.map((k) => {
    const art = ART_KURZ[k.kind] ?? k.kind;
    if (k.status === 'collecting') {
      const tag = k.daysCollected ?? 0;
      const soll = k.daysRequired ?? 21;
      return { model: k.model, art, stand: `sammelt Daten · Tag ${tag}/${soll}`, ton: 'sammelt' };
    }
    const bilanz = skillBilanz(accuracy, k.model);
    if (!bilanz) {
      return { model: k.model, art, stand: 'rechnet mit · erste Bewertung folgt', ton: 'neutral' };
    }
    return {
      model: k.model,
      art,
      stand: `in ${bilanz.besser} von ${bilanz.gesamt} ${
        bilanz.gesamt === 1 ? 'Bewertung' : 'Bewertungen'
      } genauer`,
      // Nur eine MEHRHEIT der Bewertungen ist ein „besser" — sonst läse sich
      // „in 1 von 12 genauer" wie ein Erfolg.
      ton: bilanz.besser * 2 > bilanz.gesamt ? 'besser' : 'neutral',
    };
  });
}
