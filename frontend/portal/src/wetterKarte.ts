/**
 * **Paket P5 · der Reiter „Wetter" in den C-Bausteinen** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §3.2 V4–V8 und §4.6).
 *
 * Die reine Hälfte der Karte: Label, Statement und die vier Kennzahlen-Zeilen.
 * Sie rechnet nichts NEU — jede Zahl kommt aus derselben kW-Reihe, die das
 * Diagramm zeichnet (`wetterLeistung.erwarteteLeistung`), bzw. aus derselben
 * Vorhersage, aus der `weather.ts` seit jeher liest. Zwei Rechenwege über
 * dieselbe Zahl auf EINER Karte wären zwei Wahrheiten.
 *
 * ⚠ **Nichts wird erfunden.** Fehlt ein Messwert, trägt die Zeile `null` und
 *   die Fläche zeigt „—" — nie eine 0. Fehlt die PV-Prognose ganz (kein
 *   Speicher, toter Optimierer), führt das Statement die SONNENSTÄRKE und sagt
 *   das (§4.6, Sonderzustände).
 */
import { hoursAhead, nextHourIndex } from './weather';
import {
  besteStunde,
  kw1,
  tagesSpitze,
  type WetterPunkt,
} from './wetterLeistung';

/** Die Leitgrösse des Statements — kW aus dem Fahrplan, sonst W/m². */
export type Leitgroesse = 'leistung' | 'sonnenstaerke';

export interface WetterStatement {
  /** Die EINE Zahl der Fläche samt Einheit — `null`, wenn es keine gibt. */
  zahl: string | null;
  /** Der Satz darunter, 16 px: „erwartete Spitze morgen gegen 12:00 Uhr". */
  satz: string;
  /** Woraus die Zahl stammt — die Fläche sagt es, wenn es nicht kW sind. */
  leit: Leitgroesse;
}

/** Der Tag relativ zu heute als WORT — sonst der Wochentag. */
function tagWort(iso: string, jetzt: Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tage = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()).getTime()) /
      86_400_000,
  );
  if (tage === 0) return 'heute';
  if (tage === 1) return 'morgen';
  if (tage < 0) return null;
  return d.toLocaleDateString('de-DE', { weekday: 'long' });
}

function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Das Label der Karte: „Vorhersage · Do., 03.09., 18:30".
 *
 * ⚠ Es ERSETZT die Zeit-Leiste, die dieser Reiter bewusst NICHT hat (§4.6:
 * eine Vorhersage beginnt bei JETZT, ein Zeitraum-Segment wäre ein Schalter
 * ohne Wirkung). Ohne das Datum stünde nirgends, WORAUF sich die Zahl bezieht.
 * Die Fläche versalisiert, die Daten nicht.
 */
export function vorhersageLabel(jetzt: Date): string {
  const tag = jetzt.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  return `Vorhersage · ${tag}, ${uhr(jetzt.toISOString())}`;
}

/** Der Grund, den das Statement trägt, wenn die Leitgrösse fehlt. */
export const OHNE_FAHRPLAN_SATZ =
  'Ohne Fahrplan zeigen wir die Sonnenstärke - eine PV-Prognose Ihrer Anlage liegt für die kommenden Stunden nicht vor.';

/**
 * **E8 (a) · das Statement des Reiters** (Captain 03.09.2026, wörtlich:
 * „Statement auf Marktpreise, Lastspitzen, Wetter").
 *
 * Die stärkste KOMMENDE Stunde trägt die Zahl — `besteStunde` ist dieselbe
 * Ableitung, die das Bild markiert; der frühere Kernsatz WIRD damit die Zahl.
 * Ohne kW-Reihe führt die Sonnenstärke, und der Satz sagt WARUM.
 */
export function wetterStatement(
  punkte: readonly WetterPunkt[],
  kw: readonly (number | null)[],
  jetzt: Date,
): WetterStatement {
  const best = besteStunde(punkte, kw, jetzt);
  if (best) {
    const wann = tagWort(punkte[best.index].ts, jetzt);
    return {
      zahl: `${kw1(best.kw)} kW`,
      satz: `erwartete Spitze ${wann ?? 'im Vorhersagezeitraum'} gegen ${uhr(punkte[best.index].ts)} Uhr`,
      leit: 'leistung',
    };
  }

  // Ohne Fahrplan führt die Sonnenstärke — die Fläche sagt es im Satz, statt
  // eine Leistung zu behaupten, die niemand prognostiziert hat.
  const nowMs = jetzt.getTime();
  let best2 = -1;
  punkte.forEach((p, i) => {
    const v = p.ghiWM2;
    if (v == null || v <= 0) return;
    const t = Date.parse(p.ts);
    if (!Number.isFinite(t) || t < nowMs) return;
    if (best2 < 0 || v > (punkte[best2].ghiWM2 as number)) best2 = i;
  });
  if (best2 < 0) return { zahl: null, satz: OHNE_FAHRPLAN_SATZ, leit: 'sonnenstaerke' };
  const wann = tagWort(punkte[best2].ts, jetzt);
  const wm2 = Math.round(punkte[best2].ghiWM2 as number).toLocaleString('de-DE');
  return {
    zahl: `${wm2} W/m²`,
    satz: `stärkste Sonne ${wann ?? 'im Vorhersagezeitraum'} gegen ${uhr(punkte[best2].ts)} Uhr - ${OHNE_FAHRPLAN_SATZ.charAt(0).toLowerCase()}${OHNE_FAHRPLAN_SATZ.slice(1)}`,
    leit: 'sonnenstaerke',
  };
}

export interface WetterZeile {
  id: string;
  name: string;
  wert: string | null;
  hinweis?: string;
}

function num(v: number | null | undefined, einheit: string, stellen = 1): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  // Schmales Leerzeichen vor der Einheit (V5) — sie bricht nie allein um.
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen })} ${einheit}`;
}

/**
 * **V5 · die vier Kennzahlen als Ledger-Zeilen** (§4.6): Temperatur,
 * Bewölkung, Horizont, Spitze heute. Sie ersetzen das 2×2-Raster mit seinen
 * 21,6-px-Werten — die EINE Zahl des Reiters ist das Statement, alles andere
 * ist eine Zeile.
 */
export function wetterZeilen(
  punkte: readonly WetterPunkt[],
  kw: readonly (number | null)[],
  jetzt: Date,
): WetterZeile[] {
  const nowMs = jetzt.getTime();
  const idx = nextHourIndex(punkte as never, nowMs);
  const naechste = idx >= 0 ? punkte[idx] : null;
  return [
    {
      id: 'temp',
      name: 'Temperatur',
      wert: num(naechste?.temperatureC ?? null, '°C'),
      hinweis: 'Die kommende Stunde am Standort Ihrer Anlage.',
    },
    {
      id: 'wolken',
      name: 'Bewölkung',
      wert: num(naechste?.cloudCoverPct ?? null, '%', 0),
      hinweis: 'Die kommende Stunde am Standort Ihrer Anlage.',
    },
    {
      id: 'horizont',
      name: 'Vorhersagehorizont',
      wert: num(hoursAhead(punkte as never, nowMs), 'h', 0),
      hinweis: 'So weit reicht die Vorhersage ab jetzt.',
    },
    {
      id: 'spitze-heute',
      name: 'Spitze heute',
      wert: num(tagesSpitze(punkte, kw, jetzt, 0), 'kW'),
      hinweis:
        'Die stärkste Stunde des heutigen Tages aus der PV-Prognose Ihres Fahrplans - „—", solange keine vorliegt.',
    },
  ];
}
