import type { HistoryBucket, WeatherPoint } from './api';
import { CLOUDY_MIN_CLOUD, SUNNY_MAX_CLOUD } from './weather';

/**
 * **Der Wetter-Tag** — die reinen Ableitungen der Wetter-Seite (Konzept
 * „Preise und Wetter", Fassung 3; Entscheide E5 = A „Wetter zuerst" vom
 * 20.10.2026, `data/vp-preise-wetter-konzept-f3`).
 *
 * Die Seite antwortet wie jede Wetter-App: oben das Wetter jetzt, darunter
 * drei Tage, ein Bild für den gewählten Tag. Für die Anlage kommen zwei
 * Zahlen dazu: Sonnenstrom jetzt (gemessen) und heute (gemessen plus
 * erwartet). Vier Regeln, die hier hart verdrahtet sind:
 *
 *  1. **EIN Wortsatz für den Himmel**: sonnig, wechselnd, bewölkt; nachts
 *     klar oder bewölkt. Die Schwellen sind die des Hauses
 *     ({@link SUNNY_MAX_CLOUD}/{@link CLOUDY_MIN_CLOUD}, `weather.ts`) — kein
 *     zweiter Schwellensatz.
 *  2. **Keine zweite Erzeugungsprognose.** kW kommen nur aus der gespeicherten
 *     PV-Prognose (heute: die des Fahrplans) und aus der Messung — nie aus
 *     Bewölkung mal kWp. Fehlt die Prognose, zeigt die Seite Sonnenstärke und
 *     Sonnenstunden und sagt warum.
 *  3. **Gemessen und erwartet bleiben getrennt.** Jede Viertelstunde trägt ihre
 *     Herkunft; eine kWh-Summe für heute gibt es nur, wenn die Prognose den
 *     Rest des Tages abdeckt — sonst nennt die Seite, was schon erzeugt ist.
 *  4. **Fehlend ist keine Null.** Eine Stunde ohne Wert bleibt `null`.
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
/** Ab hier zählt eine Stunde als „hell" für das Tagesbild (W/m²). */
const HELL_WM2 = 20;
/** Direkte Sonne über 120 W/m² ist die WMO-Definition einer Sonnenstunde. */
export const SONNENSTUNDE_DNI_WM2 = 120;
/** Wie alt die letzte gemessene Viertelstunde höchstens sein darf, um „jetzt" zu heißen. */
const JETZT_FRISCH_MS = 20 * 60_000;
/** Ab diesem Anteil der hellen Viertelstunden gilt die Prognose als „deckt den Tag". */
const DECKUNG = 0.9;

const STUNDE_MS = 3600_000;
const VIERTEL_MS = 15 * 60_000;

export interface WetterStunde {
  start: number;
  temp: number | null;
  wolken: number | null;
  ghi: number | null;
  dni: number | null;
  art: HimmelArt | null;
}

export interface PvViertel {
  start: number;
  kw: number;
  herkunft: 'gemessen' | 'erwartet';
}

export interface WetterTagModell {
  /** Lokale Mitternacht des Tages. */
  beginn: number;
  /** „Heute" · „Morgen" · „Do 22.10." */
  wort: string;
  /** „Dienstag, 20.10." */
  lang: string;
  tmin: number | null;
  tmax: number | null;
  art: HimmelArt | null;
  /** Stunden mit direkter Sonne über 120 W/m²; `null` ohne Messgröße. */
  sonnenStunden: number | null;
  /** Sonnenstrom des Tages in kWh — nur, wenn er belegt ist. */
  kwh: number | null;
  /** Heute: was schon erzeugt ist (kWh), sonst `null`. */
  kwhBisher: number | null;
  /** Gibt es für diesen Tag Sonnenstrom-Werte (gemessen oder erwartet)? */
  mitStrom: boolean;
  /** Die hellen Stunden des Tages [von, bis) in ms; `null` ohne Sonne. */
  hell: { von: number; bis: number } | null;
  stunden: WetterStunde[];
  /** Sonnenstrom je Viertelstunde, nach Herkunft. */
  pv: PvViertel[];
}

export interface WetterModell {
  jetztMs: number;
  /** Die Stunde, in der jetzt liegt — `null`, wenn die Vorhersage sie nicht trägt. */
  jetzt: WetterStunde | null;
  /** Die letzte gemessene Viertelstunde, wenn sie frisch ist. */
  pvJetzt: PvViertel | null;
  tage: WetterTagModell[];
}

function art(wolken: number | null, ghi: number | null): HimmelArt | null {
  if (wolken == null) return null;
  if (ghi != null && ghi <= DUNKEL_WM2) return wolken < CLOUDY_MIN_CLOUD ? 'klar' : 'nachtWolken';
  if (wolken <= SUNNY_MAX_CLOUD) return 'sonnig';
  if (wolken >= CLOUDY_MIN_CLOUD) return 'bewoelkt';
  return 'wechselnd';
}

function tagesBeginn(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function naechsterTag(ms: number): number {
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
function stundenRaster(punkte: readonly WeatherPoint[]): WetterStunde[] {
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
        dni: mittel(liste, (p) => p.dniWM2),
        art: art(wolken, ghi),
      };
    });
}

/** Die Eingaben der Wetter-Seite. */
export interface WetterEingaben {
  punkte: readonly WeatherPoint[];
  /** Die gespeicherte PV-Prognose je Viertelstunde (heute: `schedule.pvKw`). */
  prognose: readonly { start: string; pvKw: number | null }[];
  /** Die gemessenen Viertelstunden von heute (`/history?range=day`). */
  messung: { buckets: readonly HistoryBucket[]; bucketMinutes: number } | null;
  jetzt: Date;
  /** Wie viele Tage die Karten zeigen (Vorgabe 3). */
  tage?: number;
}

/** Das Modell der Wetter-Seite. */
export function wetterModell(e: WetterEingaben): WetterModell {
  const jetztMs = e.jetzt.getTime();
  const stunden = stundenRaster(e.punkte);

  // Gemessen: kW je Viertelstunde aus der Energie des Buckets.
  const gemessen: PvViertel[] = [];
  if (e.messung && e.messung.bucketMinutes > 0) {
    const faktor = 60 / e.messung.bucketMinutes;
    for (const b of e.messung.buckets) {
      const start = Date.parse(b.start);
      const kwh = zahl(b.pvKwh);
      // Nur ABGESCHLOSSENE Viertelstunden: die laufende trägt erst einen Teil ihrer Energie.
      if (!Number.isFinite(start) || kwh == null || start + e.messung.bucketMinutes * 60_000 > jetztMs) continue;
      gemessen.push({ start, kw: Math.max(0, kwh * faktor), herkunft: 'gemessen' });
    }
  }
  const messungBis = gemessen.length > 0 ? Math.max(...gemessen.map((g) => g.start)) + VIERTEL_MS : -Infinity;
  // Erwartet: erst nach der letzten Messung (und nie vor jetzt minus einer Viertelstunde).
  const ab = Math.max(messungBis, jetztMs - VIERTEL_MS);
  const erwartet: PvViertel[] = e.prognose
    .map((p) => ({ start: Date.parse(p.start), kw: zahl(p.pvKw) }))
    .filter((p): p is { start: number; kw: number } => Number.isFinite(p.start) && p.kw != null && p.start >= ab)
    .map((p) => ({ start: p.start, kw: Math.max(0, p.kw), herkunft: 'erwartet' as const }));

  const letzte = gemessen.length > 0 ? gemessen.reduce((a, b) => (b.start > a.start ? b : a)) : null;
  const pvJetzt = letzte && jetztMs - (letzte.start + VIERTEL_MS) <= JETZT_FRISCH_MS ? letzte : null;

  const heute = tagesBeginn(jetztMs);
  const anzahl = e.tage ?? 3;
  const tage: WetterTagModell[] = [];
  for (let k = 0, beginn = heute; k < anzahl; k++, beginn = naechsterTag(beginn)) {
    const ende = naechsterTag(beginn);
    const tagStunden = stunden.filter((s) => s.start >= beginn && s.start < ende);
    if (tagStunden.length === 0) break;
    const temps = tagStunden.map((s) => s.temp).filter((t): t is number => t != null);
    const hellStunden = tagStunden.filter((s) => s.ghi != null && s.ghi > HELL_WM2);
    const hell =
      hellStunden.length > 0
        ? { von: hellStunden[0].start, bis: hellStunden[hellStunden.length - 1].start + STUNDE_MS }
        : null;
    const tagWolken = (hellStunden.length > 0 ? hellStunden : tagStunden)
      .map((s) => s.wolken)
      .filter((w): w is number => w != null);
    const mittel = tagWolken.length > 0 ? tagWolken.reduce((a, b) => a + b, 0) / tagWolken.length : null;
    const mitDni = tagStunden.some((s) => s.dni != null);
    const pv = [...gemessen, ...erwartet]
      .filter((p) => p.start >= beginn && p.start < ende)
      .sort((a, b) => a.start - b.start);

    // Deckt die Prognose die hellen Viertelstunden ab jetzt (heute) bzw. des Tages?
    let kwh: number | null = null;
    let kwhBisher: number | null = null;
    if (k === 0) {
      kwhBisher = gemessen.filter((g) => g.start >= beginn).reduce((s, g) => s + g.kw * 0.25, 0);
    }
    if (hell) {
      const von = k === 0 ? Math.max(hell.von, Math.min(jetztMs, hell.bis)) : hell.von;
      const noetig = Math.max(0, Math.round((hell.bis - von) / VIERTEL_MS));
      const da = erwartet.filter((p) => p.start >= von && p.start < hell.bis).length;
      if (noetig === 0 || da >= DECKUNG * noetig) {
        const summe = pv.reduce((s, p) => s + p.kw * 0.25, 0);
        kwh = k === 0 ? summe : erwartet.some((p) => p.start >= beginn && p.start < ende) ? summe : null;
      }
    }

    tage.push({
      beginn,
      wort: k === 0 ? 'Heute' : k === 1 ? 'Morgen' : wochentagDatum(beginn),
      lang: new Date(beginn).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' }),
      tmin: temps.length > 0 ? Math.min(...temps) : null,
      tmax: temps.length > 0 ? Math.max(...temps) : null,
      art: mittel == null ? null : art(mittel, hell ? 100 : 0),
      sonnenStunden: mitDni ? tagStunden.filter((s) => (s.dni ?? 0) > SONNENSTUNDE_DNI_WM2).length : null,
      kwh,
      kwhBisher,
      mitStrom: pv.length > 0,
      hell,
      stunden: tagStunden,
      pv,
    });
  }

  const jetztStunde = stunden.find((s) => jetztMs >= s.start && jetztMs < s.start + STUNDE_MS) ?? null;
  return { jetztMs, jetzt: jetztStunde, pvJetzt, tage };
}

/** Die Stunde eines Zeitpunkts im Tag (für die Antwort beim Antippen). */
export function stundeBei(tag: WetterTagModell, ms: number): WetterStunde | null {
  return tag.stunden.find((s) => ms >= s.start && ms < s.start + STUNDE_MS) ?? null;
}

/** Der Sonnenstrom-Wert einer Viertelstunde, falls bekannt. */
export function pvBei(tag: WetterTagModell, ms: number): PvViertel | null {
  return tag.pv.find((p) => ms >= p.start && ms < p.start + VIERTEL_MS) ?? null;
}

/**
 * Der eine Halbsatz unter dem Wetter jetzt: „Sonne bis ca. 18 Uhr" während des
 * hellen Tages, „Sonne ab ca. 8 Uhr" davor — aus der Sonnenstärke der
 * Vorhersage, deshalb „ca.". Nach Sonnenuntergang: nichts.
 */
export function sonnenSatz(m: WetterModell): string | null {
  const heute = m.tage[0];
  if (!heute?.hell) return null;
  const stunde = (ms: number) => new Date(ms).getHours();
  if (m.jetztMs < heute.hell.von) return `Sonne ab ca. ${stunde(heute.hell.von)} Uhr`;
  if (m.jetztMs < heute.hell.bis) return `Sonne bis ca. ${stunde(heute.hell.bis)} Uhr`;
  return null;
}

/** „8–17°" — gerundet, echtes Minus. */
export function gradSpanne(tmin: number | null, tmax: number | null): string | null {
  if (tmin == null || tmax == null) return null;
  return `${grad(tmin)}–${grad(tmax)}°`;
}

/** „16" · „−3" — ganze Grad, echtes Minus. */
export function grad(t: number): string {
  const r = Math.round(t);
  return r < 0 ? `−${Math.abs(r)}` : String(r === 0 ? 0 : r);
}
