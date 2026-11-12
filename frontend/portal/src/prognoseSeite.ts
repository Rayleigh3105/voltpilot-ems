import type { ForecastResponse, ForecastValue, HistoryBucket, RueckblickKind, RueckblickResponse, WeatherPoint } from './api';
import {
  art,
  HIMMEL_WORT,
  naechsterTag,
  stundenRaster,
  tagesBeginn,
  wochentagDatum,
  type HimmelArt,
  type WetterStunde,
} from './wetterTag';

/**
 * **Der Sonnen-Teppich** - die reinen Ableitungen der Kundenseite der
 * Prognose (Konzept `vp-prognosen-konzept`, E1 = C vom 11.11.2026). Ersetzt
 * die alte Wetter-Seite: Himmel und Temperatur stehen jetzt über dem
 * Tagesbild, der Himmel des Tages in jeder Zeile des Teppichs.
 *
 * Regeln, hart verdrahtet (Bericht Abschnitt 6.1/8):
 *  1. **Stundenmittel überall im Teppich.** Eine Lastprognose "wie gestern"
 *     trägt Gerätespitzen von gestern, die heute nicht zur selben
 *     Viertelstunde kommen - das Stundenmittel glättet das.
 *  2. **Gemessen und erwartet bleiben getrennt.** Jede Stunde trägt ihre
 *     Herkunft.
 *  3. **Fehlend ist keine Null.** Ein Tag ohne Daten erscheint nicht - nie
 *     als Null-Zeile.
 *  4. **Nur "≈".** Keine Spanne (E4 = B); wie gut es lag, zeigt der Rückblick
 *     (eigene Scheibe S3).
 *  5. **Ab übermorgen ein Ausblick** (E3 = A): heller/schwächer markiert.
 *  6. **Ein Maßstab, der ehrlich bleibt.** Die Säulen messen sich an der
 *     Anlage (mindestens 40 % der Anlagenleistung), nicht an der eigenen
 *     Spitze der Woche - eine trübe Winterwoche sieht auch niedrig aus,
 *     statt sich auf einen falschen "voll" hochzuskalieren.
 */

const STUNDE_MS = 3600_000;
const VIERTEL_MS = 15 * 60_000;
/** Ab diesem Anteil der benötigten Viertelstunden gilt die Prognose als "deckt den Tag". */
const DECKUNG = 0.9;

export type Herkunft = 'gemessen' | 'erwartet';

export interface TeppichStunde {
  start: number;
  /** Stundenmittel Sonne (kW); `null` ohne Wert. */
  sonneKw: number | null;
  /** Stundenmittel Verbrauch (kW); `null` ohne Wert. */
  verbrauchKw: number | null;
  herkunft: Herkunft;
  /** Deckt die Sonne in dieser Stunde den Verbrauch (Stundenmittel gegen Stundenmittel)? */
  deckt: boolean;
}

export interface TeppichTag {
  beginn: number;
  /** "Heute" · "Morgen" · "Do 22.10." */
  wort: string;
  lang: string;
  art: HimmelArt | null;
  /** Ab übermorgen: ein Ausblick (E3 = A) - heller/schwächer gezeichnet. */
  ausblick: boolean;
  stunden: TeppichStunde[];
  sonneKwh: number | null;
  verbrauchKwh: number | null;
  /** Heute: was schon erzeugt/verbraucht ist. */
  sonneBisherKwh: number | null;
  verbrauchBisherKwh: number | null;
  /** "Sonne reicht von … bis" (Viertelstunden-Fenster an Tag 0, sonst Stunden-Fenster); `null` ohne Deckung. */
  reicht: { von: number; bis: number } | null;
  /**
   * Der Tipp "Am meisten Sonne übrig …" (nur Tag 0): das Zweistunden-Fenster
   * ab jetzt mit dem größten Überschuss (Sonne minus Verbrauch); `null` an
   * knappen Tagen oder ganz ohne Überschuss - dann zeigt `uebrigGesamtKwh`
   * die Menge, oder beides ist `null`/0 ("Heute bleibt keine Sonne übrig").
   */
  uebrigFenster: { von: number; bis: number } | null;
  /** Der verbleibende Überschuss heute in kWh ab jetzt (nur Tag 0, nur mit PV). */
  uebrigGesamtKwh: number | null;
}

export interface PrognoseModell {
  jetztMs: number;
  tage: TeppichTag[];
  /** Hat diese Anlage überhaupt PV (irgendein Sonnenwert > 0 in der Woche)? */
  mitPv: boolean;
  /**
   * Der Maßstab des Teppichs (kW je Stunde): mit PV mindestens 40 % der
   * Anlagenleistung, sonst (nur wenn sie wirklich unbekannt ist) die
   * stärkste Stunde der Woche - ohne PV immer die stärkste Verbrauchsstunde
   * der Woche (Bericht 6.1).
   */
  massstab: number;
}

function zahl(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface Viertel {
  start: number;
  sonneKw: number | null;
  verbrauchKw: number | null;
  herkunft: Herkunft;
}

/** Die Eingaben der Prognose-Seite. */
export interface PrognoseEingaben {
  forecast: ForecastResponse;
  weather: readonly WeatherPoint[];
  /** Die gemessenen Viertelstunden von heute (`/history?range=day`). */
  messung: { buckets: readonly HistoryBucket[]; bucketMinutes: number } | null;
  jetzt: Date;
  /** Wie viele Tage der Teppich höchstens zeigt (Vorgabe 7). */
  tage?: number;
  /**
   * Die Anlagenleistung (kWp) für den Maßstab des Teppichs - die maßgebliche
   * PV-Zeile aus `/sites/{id}/assets` (`pvLage()`: Hauptanlage plus Summe der
   * zusätzlichen Erzeuger). `null` nur, wenn sie wirklich unbekannt ist (noch
   * keine Anlage eingerichtet) - dann fällt der Maßstab auf die stärkste
   * Stunde der Woche zurück, begründet dokumentiert in `PrognoseModell.massstab`.
   */
  anlagenleistungKwp?: number | null;
}

function alsViertel(werte: readonly ForecastValue[], feld: 'sonneKw' | 'verbrauchKw'): Viertel[] {
  return werte
    .map((w) => ({ start: Date.parse(w.ts), wert: zahl(w.valueKw) }))
    .filter((w): w is { start: number; wert: number } => Number.isFinite(w.start) && w.wert != null)
    .map((w) => ({
      start: w.start,
      sonneKw: feld === 'sonneKw' ? w.wert : null,
      verbrauchKw: feld === 'verbrauchKw' ? w.wert : null,
      herkunft: 'erwartet' as const,
    }));
}

/** Stundenmittel aus Viertelstunden - `null`, wenn keine Viertelstunde einen Wert trägt. */
function stundenMittelKw(viertel: readonly Viertel[], feld: 'sonneKw' | 'verbrauchKw'): number | null {
  const werte = viertel.map((v) => v[feld]).filter((v): v is number => v != null);
  return werte.length > 0 ? werte.reduce((s, v) => s + v, 0) / werte.length : null;
}

/** Baut das Stunden-Raster aus Viertelstunden (heute/morgen, 15-Min-Prognose + Messung). */
function viertelZuStunden(je: Map<number, Viertel>): Map<number, TeppichStunde> {
  const proStunde = new Map<number, Viertel[]>();
  for (const v of je.values()) {
    const h = Math.floor(v.start / STUNDE_MS) * STUNDE_MS;
    const liste = proStunde.get(h);
    if (liste) liste.push(v);
    else proStunde.set(h, [v]);
  }
  const out = new Map<number, TeppichStunde>();
  for (const [start, viertel] of proStunde) {
    const sonneKw = stundenMittelKw(viertel, 'sonneKw');
    const verbrauchKw = stundenMittelKw(viertel, 'verbrauchKw');
    const herkunft: Herkunft = viertel.every((v) => v.herkunft === 'gemessen') ? 'gemessen' : 'erwartet';
    out.set(start, {
      start,
      sonneKw,
      verbrauchKw,
      herkunft,
      deckt: sonneKw != null && verbrauchKw != null && sonneKw >= verbrauchKw,
    });
  }
  return out;
}

/** Die gemessenen Viertelstunden von heute (Sonne + Verbrauch), nur ABGESCHLOSSENE. */
function gemesseneViertel(
  messung: PrognoseEingaben['messung'],
  jetztMs: number,
): Viertel[] {
  if (!messung || messung.bucketMinutes <= 0) return [];
  const faktor = 60 / messung.bucketMinutes;
  const out: Viertel[] = [];
  for (const b of messung.buckets) {
    const start = Date.parse(b.start);
    if (!Number.isFinite(start) || start + messung.bucketMinutes * 60_000 > jetztMs) continue;
    const sonne = zahl(b.pvKwh);
    const verbrauch = zahl(b.loadKwh);
    if (sonne == null && verbrauch == null) continue;
    out.push({
      start,
      sonneKw: sonne == null ? null : Math.max(0, sonne * faktor),
      verbrauchKw: verbrauch == null ? null : Math.max(0, verbrauch * faktor),
      herkunft: 'gemessen',
    });
  }
  return out;
}

/** "Sonne reicht von … bis": längster Abschnitt, in dem Sonne (Viertelstunde) das
 * Stundenmittel des Verbrauchs deckt; Lücken bis 30 Minuten trennen nicht. */
/** Höchstens zwei Viertelstunden (30 Minuten) Lücke trennen einen Abschnitt nicht. */
const MAX_LUECKE_VIERTEL = 2;

function reichtFenster(
  viertel: Map<number, Viertel>,
  stunden: Map<number, TeppichStunde>,
  tagBeginn: number,
  tagEnde: number,
): { von: number; bis: number } | null {
  const slots = [...viertel.values()]
    .filter((v) => v.start >= tagBeginn && v.start < tagEnde)
    .sort((a, b) => a.start - b.start);
  const deckt = slots.map((v) => {
    const h = Math.floor(v.start / STUNDE_MS) * STUNDE_MS;
    const verbrauchStd = stunden.get(h)?.verbrauchKw ?? null;
    return v.sonneKw != null && verbrauchStd != null && v.sonneKw >= verbrauchStd;
  });

  // Jeden Abschnitt einsammeln, der mit einer deckenden Viertelstunde beginnt
  // und endet, Lücken bis MAX_LUECKE_VIERTEL eingeschlossen; der längste
  // (nach Dauer in ms, nicht nach Index) gewinnt.
  const abschnitte: { von: number; bis: number }[] = [];
  let von = -1;
  let letzteDeckung = -1;
  for (let i = 0; i < slots.length; i++) {
    if (!deckt[i]) continue;
    if (von === -1) {
      von = i;
    } else if (i - letzteDeckung - 1 > MAX_LUECKE_VIERTEL) {
      abschnitte.push({ von, bis: letzteDeckung });
      von = i;
    }
    letzteDeckung = i;
  }
  if (von !== -1) abschnitte.push({ von, bis: letzteDeckung });

  let best: { von: number; bis: number } | null = null;
  let bestDauer = -1;
  for (const a of abschnitte) {
    const dauer = slots[a.bis].start - slots[a.von].start;
    if (dauer > bestDauer) {
      bestDauer = dauer;
      best = a;
    }
  }
  if (!best) return null;
  return { von: slots[best.von].start, bis: slots[best.bis].start + VIERTEL_MS };
}

/**
 * "Sonne reicht von … bis" für einen Tag jenseits heute: dieselbe Regel, aber
 * auf dem Stunden-Raster (ab Tag 1 gibt es keine Viertelstunden mehr) - eine
 * fehlende Stunde ist bereits länger als die 30-Minuten-Lücke der
 * Viertelstunden-Fassung, darum ohne Lückentoleranz.
 */
function reichtFensterStunden(stunden: readonly TeppichStunde[]): { von: number; bis: number } | null {
  let best: { von: number; bis: number } | null = null;
  let bestDauer = -1;
  let von = -1;
  for (let i = 0; i < stunden.length; i++) {
    if (stunden[i].deckt) {
      if (von === -1) von = i;
      continue;
    }
    if (von !== -1) {
      const dauer = stunden[i - 1].start - stunden[von].start;
      if (dauer > bestDauer) {
        bestDauer = dauer;
        best = { von: stunden[von].start, bis: stunden[i - 1].start + STUNDE_MS };
      }
      von = -1;
    }
  }
  if (von !== -1) {
    const dauer = stunden[stunden.length - 1].start - stunden[von].start;
    if (dauer > bestDauer) best = { von: stunden[von].start, bis: stunden[stunden.length - 1].start + STUNDE_MS };
  }
  return best;
}

/**
 * Der Tipp "Am meisten Sonne übrig …": das Zweistunden-Fenster (8
 * Viertelstunden, zusammenhängend) ab jetzt mit dem größten Überschuss
 * (Sonne je Viertelstunde minus Stundenmittel des Verbrauchs). Ein Fenster
 * unter `UEBRIG_SCHWELLE_KWH` gilt als "knapp" - dann zeigt nur die
 * Gesamtmenge, keine Zeit (Bericht 6.3 nennt für diese Schwelle keine Zahl;
 * eigene, dokumentierte Wahl).
 */
const UEBRIG_FENSTER_VIERTEL = 8;
const UEBRIG_SCHWELLE_KWH = 1;

function ueberschussFenster(
  viertel: Map<number, Viertel>,
  stunden: Map<number, TeppichStunde>,
  vonMs: number,
  bisMs: number,
): { fenster: { von: number; bis: number } | null; gesamtKwh: number } {
  const slots = [...viertel.values()]
    .filter((v) => v.start >= vonMs && v.start < bisMs && v.sonneKw != null)
    .sort((a, b) => a.start - b.start);
  const ueberschuss = slots.map((v) => {
    const h = Math.floor(v.start / STUNDE_MS) * STUNDE_MS;
    const verbrauchStd = stunden.get(h)?.verbrauchKw ?? null;
    return verbrauchStd != null ? Math.max(0, (v.sonneKw as number) - verbrauchStd) : 0;
  });
  const gesamtKwh = ueberschuss.reduce((a, b) => a + b, 0) * 0.25;

  let bestStart = -1;
  let bestSumme = -Infinity;
  for (let i = 0; i + UEBRIG_FENSTER_VIERTEL <= slots.length; i++) {
    let zusammenhaengend = true;
    for (let j = 1; j < UEBRIG_FENSTER_VIERTEL; j++) {
      if (slots[i + j].start - slots[i + j - 1].start !== VIERTEL_MS) {
        zusammenhaengend = false;
        break;
      }
    }
    if (!zusammenhaengend) continue;
    let summe = 0;
    for (let j = 0; j < UEBRIG_FENSTER_VIERTEL; j++) summe += ueberschuss[i + j];
    if (summe > bestSumme) {
      bestSumme = summe;
      bestStart = i;
    }
  }
  const besteKwh = bestStart === -1 ? 0 : bestSumme * 0.25;
  const fenster =
    bestStart !== -1 && besteKwh >= UEBRIG_SCHWELLE_KWH
      ? { von: slots[bestStart].start, bis: slots[bestStart + UEBRIG_FENSTER_VIERTEL - 1].start + VIERTEL_MS }
      : null;
  return { fenster, gesamtKwh };
}

/** Das Modell der Prognose-Seite. */
export function prognoseModell(e: PrognoseEingaben): PrognoseModell {
  const jetztMs = e.jetzt.getTime();
  const himmelStunden = stundenRaster(e.weather);
  const himmelJe = new Map(himmelStunden.map((s) => [s.start, s]));

  const sonneViertel = alsViertel(e.forecast.pvKw, 'sonneKw');
  const verbrauchViertel = alsViertel(e.forecast.loadKw, 'verbrauchKw');
  const gemessen = gemesseneViertel(e.messung, jetztMs);
  const alleViertel = mischeViertel([sonneViertel, verbrauchViertel, gemessen]);
  const stundenJe15 = viertelZuStunden(alleViertel);

  // Wöchentlicher Ausblick (S4, stündlich): eigene Map, da er schon Stunden sind.
  const ausblickStunden = new Map<number, TeppichStunde>();
  const sonneWoche = new Map(e.forecast.weekly.pvKw.map((w) => [Date.parse(w.ts), zahl(w.valueKw)]));
  const verbrauchWoche = new Map(e.forecast.weekly.loadKw.map((w) => [Date.parse(w.ts), zahl(w.valueKw)]));
  const alleStarts = new Set([...sonneWoche.keys(), ...verbrauchWoche.keys()]);
  for (const start of alleStarts) {
    if (!Number.isFinite(start)) continue;
    const sonneKw = sonneWoche.get(start) ?? null;
    const verbrauchKw = verbrauchWoche.get(start) ?? null;
    ausblickStunden.set(start, {
      start,
      sonneKw,
      verbrauchKw,
      herkunft: 'erwartet',
      deckt: sonneKw != null && verbrauchKw != null && sonneKw >= verbrauchKw,
    });
  }

  const heute = tagesBeginn(jetztMs);
  const anzahl = e.tage ?? 7;
  const tage: TeppichTag[] = [];
  // Sonne und Verbrauch GETRENNT verfolgen: der Teppich zeichnet nur EINE der
  // beiden Reihen (mit PV die Sonne, sonst den Verbrauch, `Teppich.wert` in
  // `PrognoseTeppich.tsx`) - ein gemeinsames Maximum ließ die Sonnen-Säulen
  // einer Anlage mit viel Verbrauch und wenig PV (Gewerbe ohne/mit kleiner
  // Anlage) unsichtbar werden, weil der Maßstab vom VERBRAUCH dominiert
  // wurde, den dieselbe Zeile gar nicht zeigt.
  let massstabSonne = 0;
  let massstabVerbrauch = 0;
  let mitPv = false;

  for (let k = 0, beginn = heute; k < anzahl; k++, beginn = naechsterTag(beginn)) {
    const ende = naechsterTag(beginn);
    const ausblick = k >= 2;
    const quelle = ausblick ? ausblickStunden : stundenJe15;
    const tagStunden = [...quelle.values()]
      .filter((s) => s.start >= beginn && s.start < ende)
      .sort((a, b) => a.start - b.start);
    if (tagStunden.length === 0) continue;

    for (const s of tagStunden) {
      if (s.sonneKw != null) massstabSonne = Math.max(massstabSonne, s.sonneKw);
      if (s.verbrauchKw != null) massstabVerbrauch = Math.max(massstabVerbrauch, s.verbrauchKw);
      if (s.sonneKw != null && s.sonneKw > 0.01) mitPv = true;
    }

    const himmelTagStunden = [...himmelJe.values()].filter((s) => s.start >= beginn && s.start < ende);
    const art0 = mehrheitsHimmel(himmelTagStunden);

    // Eine Tagessumme nur, wenn genug Stunden belegt sind (DECKUNG) - sonst
    // wäre eine Teilsumme eine stille Untertreibung ("Fehlend ist keine Null").
    // JE GRÖSSE EIGENE Deckung: eine Stunde entsteht schon, wenn nur EINE der
    // beiden Reihen einen Wert trägt (`viertelZuStunden`/`mischeViertel`) -
    // `tagStunden.length` allein verdeckt darum eine Lücke nur bei der Sonne
    // (oder nur beim Verbrauch), während die andere Reihe voll da ist.
    const benoetigt = k === 0 ? Math.ceil((ende - jetztMs) / STUNDE_MS) : 24;
    const sonneWerte = tagStunden.map((s) => s.sonneKw).filter((v): v is number => v != null);
    const verbrauchWerte = tagStunden.map((s) => s.verbrauchKw).filter((v): v is number => v != null);
    const genugSonne = benoetigt <= 0 || sonneWerte.length >= DECKUNG * benoetigt;
    const genugVerbrauch = benoetigt <= 0 || verbrauchWerte.length >= DECKUNG * benoetigt;
    const sonneKwh = genugSonne && sonneWerte.length > 0 ? sonneWerte.reduce((a, b) => a + b, 0) : null;
    const verbrauchKwh = genugVerbrauch && verbrauchWerte.length > 0 ? verbrauchWerte.reduce((a, b) => a + b, 0) : null;

    let sonneBisherKwh: number | null = null;
    let verbrauchBisherKwh: number | null = null;
    let uebrigFenster: { von: number; bis: number } | null = null;
    let uebrigGesamtKwh: number | null = null;
    const reicht = k === 0 ? reichtFenster(alleViertel, stundenJe15, beginn, ende) : reichtFensterStunden(tagStunden);
    if (k === 0) {
      const bisher = gemessen.filter((g) => g.start >= beginn && g.start < ende);
      sonneBisherKwh = bisher.reduce((s, g) => s + (g.sonneKw ?? 0) * 0.25, 0);
      verbrauchBisherKwh = bisher.reduce((s, g) => s + (g.verbrauchKw ?? 0) * 0.25, 0);
      const ueberschuss = ueberschussFenster(alleViertel, stundenJe15, Math.max(beginn, jetztMs), ende);
      uebrigFenster = ueberschuss.fenster;
      uebrigGesamtKwh = ueberschuss.gesamtKwh;
    }

    tage.push({
      beginn,
      wort: k === 0 ? 'Heute' : k === 1 ? 'Morgen' : wochentagDatum(beginn),
      lang: new Date(beginn).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' }),
      art: art0,
      ausblick,
      stunden: tagStunden,
      sonneKwh,
      verbrauchKwh,
      sonneBisherKwh,
      verbrauchBisherKwh,
      reicht,
      uebrigFenster,
      uebrigGesamtKwh,
    });
  }

  // Ein Maßstab, der ehrlich bleibt (Captain-Entscheid auf dem Board, Bericht
  // 6.1): mit PV mindestens 40 % der Anlagenleistung, nicht die eigene Spitze
  // der Woche - sonst sähe eine trübe Winterwoche genauso "voll" aus wie ein
  // Sommertag. Nur wenn die Anlagenleistung wirklich unbekannt ist, bleibt
  // die stärkste Stunde der Woche (Sonne ODER Verbrauch) der Maßstab
  // (begründeter Rückfall - mit bekannter kWp bleibt die Sonne bei sich).
  const kwp = e.anlagenleistungKwp;
  const massstab =
    !mitPv
      ? massstabVerbrauch
      : kwp != null && kwp > 0
        ? Math.max(massstabSonne, 0.4 * kwp)
        : Math.max(massstabSonne, massstabVerbrauch);
  return { jetztMs, tage, mitPv, massstab: Math.max(massstab, 0.1) };
}

function mehrheitsHimmel(stunden: readonly WetterStunde[]): HimmelArt | null {
  const mitGhi = stunden.filter((s) => s.ghi != null && s.ghi > 20);
  const basis = mitGhi.length > 0 ? mitGhi : stunden;
  const wolken = basis.map((s) => s.wolken).filter((w): w is number => w != null);
  if (wolken.length === 0) return null;
  const mittel = wolken.reduce((a, b) => a + b, 0) / wolken.length;
  return art(mittel, mitGhi.length > 0 ? 100 : 0);
}

function mischeViertel(quellen: Viertel[][]): Map<number, Viertel> {
  const je = new Map<number, Viertel>();
  for (const quelle of quellen) {
    for (const v of quelle) {
      const vorhanden = je.get(v.start);
      je.set(v.start, {
        start: v.start,
        sonneKw: v.sonneKw ?? vorhanden?.sonneKw ?? null,
        verbrauchKw: v.verbrauchKw ?? vorhanden?.verbrauchKw ?? null,
        herkunft: vorhanden?.herkunft === 'gemessen' || v.herkunft === 'gemessen' ? 'gemessen' : 'erwartet',
      });
    }
  }
  return je;
}

/** Der Mengensatz: "viel mehr" … "viel weniger" (Bericht 6.1, 7 Stufen). */
export function mengenSatz(sonneKwh: number | null, verbrauchKwh: number | null): string | null {
  if (sonneKwh == null || verbrauchKwh == null) return null;
  if (verbrauchKwh <= 0) return sonneKwh > 0 ? 'viel mehr Sonne als Verbrauch' : null;
  const r = sonneKwh / verbrauchKwh;
  if (r >= 4) return 'viel mehr Sonne als Verbrauch';
  if (r >= 2) return 'deutlich mehr Sonne als Verbrauch';
  if (r >= 1.2) return 'etwas mehr Sonne als Verbrauch';
  if (r >= 0.8) return 'ungefähr gleich viel Sonne wie Verbrauch';
  if (r >= 0.5) return 'etwas weniger Sonne als Verbrauch';
  if (r >= 0.3) return 'deutlich weniger Sonne als Verbrauch';
  return 'viel weniger Sonne als Verbrauch';
}

const uhr = (ms: number) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const kwh0 = (v: number) => Math.round(v).toLocaleString('de-DE');

/** "Sonne reicht 07:00–19:45" / "Sonne reicht heute nicht". */
export function reichtSatz(tag: TeppichTag): string {
  if (!tag.reicht) return tag.wort === 'Heute' ? 'Sonne reicht heute nicht' : `Sonne reicht ${tag.wort === 'Morgen' ? 'morgen' : tag.lang} nicht`;
  return `Sonne reicht ${uhr(tag.reicht.von)}–${uhr(tag.reicht.bis)}`;
}

/**
 * Der Tipp "Am meisten Sonne übrig 13:15–15:15" (nur heute, mit PV): an
 * knappen Tagen nur die Menge, ganz ohne Überschuss "Heute bleibt keine
 * Sonne übrig" (Bericht 6.1).
 */
export function uebrigSatz(heute: TeppichTag): string {
  if (heute.uebrigFenster) return `Am meisten Sonne übrig ${uhr(heute.uebrigFenster.von)}–${uhr(heute.uebrigFenster.bis)}`;
  if (heute.uebrigGesamtKwh != null && heute.uebrigGesamtKwh >= 0.05) {
    return `Übrig bleiben heute rund ${kwh0(heute.uebrigGesamtKwh)} kWh`;
  }
  return 'Heute bleibt keine Sonne übrig';
}

/**
 * "Morgen rund 149 kWh" (ohne PV, Bericht R.2) bzw. dieselbe Form für die
 * Sonne mit PV - die Zeile der Kachel und der schlanken Antwort ohne PV.
 * `null` ohne Tag 1 oder ohne dessen Tagessumme (keine erfundene Zahl).
 */
export function morgenSatz(morgen: TeppichTag | undefined, mitPv: boolean): string | null {
  if (!morgen) return null;
  const kwh = mitPv ? morgen.sonneKwh : morgen.verbrauchKwh;
  if (kwh == null) return null;
  return mitPv ? `Morgen rund ${kwh0(kwh)} kWh Sonne` : `Morgen rund ${kwh0(kwh)} kWh`;
}

/**
 * Ohne PV: "Am meisten Verbrauch 7–10 Uhr" - die drei AUFEINANDERFOLGENDEN
 * Stunden (Stundenmittel) mit dem meisten Verbrauch (Bericht 6.1).
 */
export function verbrauchsSpitzeSatz(tag: TeppichTag): string | null {
  const stunden = tag.stunden.filter((s) => s.verbrauchKw != null);
  if (stunden.length < 3) return null;
  let bestStart = -1;
  let bestSumme = -Infinity;
  for (let i = 0; i + 2 < stunden.length; i++) {
    const [a, b, c] = [stunden[i], stunden[i + 1], stunden[i + 2]];
    // Nur wirklich aufeinanderfolgende Stunden (keine Lücke durch fehlende Werte).
    if (b.start - a.start !== STUNDE_MS || c.start - b.start !== STUNDE_MS) continue;
    const summe = (a.verbrauchKw ?? 0) + (b.verbrauchKw ?? 0) + (c.verbrauchKw ?? 0);
    if (summe > bestSumme) {
      bestSumme = summe;
      bestStart = a.start;
    }
  }
  if (bestStart === -1) return null;
  const von = new Date(bestStart).getHours();
  const bis = new Date(bestStart + 3 * STUNDE_MS).getHours();
  return `Am meisten Verbrauch ${von}–${bis} Uhr`;
}

/* ---------------------------------------------------------------------------
 * Das Blatt "Rückblick" (S3, Bericht Abschnitt 9, E5 = A): "am Vortag
 * erwartet" neben "gemessen" - wie gut die Prognose lag. Die Zahlen kommen
 * FERTIG vom Server (`forecast_rueckblick`); diese Ableitungen formatieren
 * nur, sie rechnen nichts neu.
 * ------------------------------------------------------------------------- */

/** Unter dieser Zahl bewerteter Tage zeigt das Blatt keinen Rückblick-Satz (Server-Zwilling `RueckblickDto.KindRueckblickDto.MIN_TAGE`). */
export const RUECKBLICK_MIN_TAGE = 10;

export interface RueckblickZeile {
  /** "Mo 10.11." */
  tagWort: string;
  erwartetKwh: number;
  gemessenKwh: number;
}

/** Die Tage einer Art als Zeilen fürs Blatt, älteste zuerst (wie geliefert). */
export function rueckblickZeilen(kind: RueckblickKind): RueckblickZeile[] {
  return kind.tage.map((t) => ({
    tagWort: wochentagDatum(new Date(`${t.day}T00:00:00`).getTime()),
    erwartetKwh: t.erwartetKwh,
    gemessenKwh: t.gemessenKwh,
  }));
}

/**
 * "Gestern: 311 erwartet, 321 gekommen" - die Unterzeile der Zeile
 * "Rückblick" (Bericht 6.1/7, wörtlich wie im Konzeptbild). Der jüngste Tag
 * der zur Seite passenden Art (Sonne mit PV, sonst Verbrauch); `null` ohne
 * Tage - noch kein Rückblick, keine erfundene Zahl (die Zeile fällt dann auf
 * den allgemeinen Text zurück).
 */
export function gesternSatz(rueckblick: RueckblickResponse | null, mitPv: boolean): string | null {
  if (!rueckblick) return null;
  const art = mitPv ? 'pv' : 'load';
  const kind = rueckblick.kinds.find((k) => k.kind === art);
  const gestern = kind?.tage[kind.tage.length - 1];
  if (!gestern) return null;
  return `Gestern: ${kwh0(gestern.erwartetKwh)} erwartet, ${kwh0(gestern.gemessenKwh)} gekommen`;
}

/**
 * "An 8 von 10 Tagen höchstens 2 kWh daneben." - das 0,8-Quantil der
 * Tagesabweichung kommt fertig vom Server (`abweichungKwh`); "8 von 10" ist
 * die feste Redewendung für ein 80-%-Quantil, keine Zählung der tatsächlich
 * bewerteten Tage. Unter {@link RUECKBLICK_MIN_TAGE} bewerteten Tagen bleibt
 * es ehrlich bei "noch keine Bewertung" statt einer erfundenen Zahl.
 */
export function rueckblickSatz(kind: RueckblickKind): string {
  if (kind.abweichungKwh == null) {
    return kind.bewerteteTage === 0
      ? 'Noch keine Bewertung.'
      : `Noch keine Bewertung - erst ab ${RUECKBLICK_MIN_TAGE} Tagen (bisher ${kind.bewerteteTage}).`;
  }
  return `An 8 von 10 Tagen höchstens ${kwh0(kind.abweichungKwh)} kWh daneben.`;
}

export { HIMMEL_WORT };
export type { HimmelArt };
