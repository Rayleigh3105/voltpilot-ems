import type { Kernaussage } from './chartKopf';
import { CLOUDY_MIN_CLOUD, SUNNY_MAX_CLOUD } from './weather';

/**
 * Die Wetter-Fläche antwortet in der Größe, nach der der Kunde fragt (M16;
 * Scout `vp-charts-verstaendlich-r2` §6 E) — reine Ableitungen, der Render
 * ist dünn.
 *
 * Der Befund war, dass „412 W/m²" für einen Anlagenbetreiber bedeutungslos
 * ist: er will wissen, wie viel Strom seine Anlage machen wird. Leitgröße ist
 * deshalb die **erwartete Leistung in kW**; Sonnenstärke und Temperatur liegen
 * eine Stufe tiefer (K3), womit die alte Farbkollision zweier fast gleicher
 * Orange-Töne (ΔE 4,1) gleich mit verschwindet.
 *
 * ⚠ **Woher die kW kommen, und woher NICHT.** Es gibt keinen Portal-Endpunkt
 * für die rohe PV-Prognose-Reihe. Die EINE Stelle, an der die Prognose des
 * aktiven PV-Modells das Portal erreicht, ist der FAHRPLAN: `schedule.pv_kw`
 * ist die PV-Prognose, mit der der Optimierer geplant hat (siehe
 * `ScheduleSlot.pvKw`). Genau die wird hier auf das Stundenraster der
 * Wettervorhersage gemittelt.
 *
 * Daraus folgen zwei Ehrlichkeitsregeln, die nicht wegoptimiert werden dürfen:
 *
 *  1. **Es wird NICHTS umgerechnet.** Aus W/m² × kWp eine Leistung zu basteln
 *     wäre eine zweite Prognose neben der, mit der wirklich geplant wird —
 *     genau die Art zweiter Wahrheit, die das Haus sonst überall vermeidet.
 *  2. **Der Plan-Horizont ist kürzer als die Wettervorhersage.** Wo der Plan
 *     nicht hinreicht, endet die kW-Linie schlicht — eine Lücke bleibt eine
 *     Lücke, nie eine erfundene 0. Ohne jeden Plan-Wert gibt es keine
 *     Leitgröße, und der Kopf sagt den GRUND statt eines erfundenen Satzes.
 */

/** Ein Wetterpunkt, so weit ihn diese Datei liest. */
export interface WetterPunkt {
  ts: string;
  cloudCoverPct: number | null;
  temperatureC?: number | null;
  ghiWM2?: number | null;
}

/** Ein Plan-Slot, so weit ihn diese Datei liest. */
export interface PlanPvSlot {
  start: string;
  pvKw: number | null;
}

/* ---------------------------------------------------------------------------
 * Die Leitgröße: erwartete Leistung in kW
 * ------------------------------------------------------------------------- */

/**
 * Die PV-Prognose des Fahrplans auf das STUNDEN-Raster der Wettervorhersage
 * gemittelt: je Wetterstunde das Mittel der Viertelstunden, die in sie fallen.
 *
 * Der Mittelwert ist die richtige Verdichtung — eine Stunde „erwarten wir
 * 12 kW" meint die mittlere Leistung, nicht die Spitze einer Viertelstunde.
 * Eine Stunde ohne einen einzigen Plan-Wert bleibt `null`.
 */
export function erwarteteLeistung(
  punkte: readonly WetterPunkt[],
  slots: readonly PlanPvSlot[],
): (number | null)[] {
  if (punkte.length === 0) return [];
  const werte = slots
    .map((s) => ({ t: Date.parse(s.start), kw: s.pvKw }))
    .filter((s) => Number.isFinite(s.t) && s.kw != null) as { t: number; kw: number }[];
  if (werte.length === 0) return punkte.map(() => null);

  return punkte.map((p, i) => {
    const von = Date.parse(p.ts);
    if (!Number.isFinite(von)) return null;
    // Das Ende ist der nächste Wetterpunkt; für den letzten eine Stunde.
    const naechster = i + 1 < punkte.length ? Date.parse(punkte[i + 1].ts) : NaN;
    const bis = Number.isFinite(naechster) ? naechster : von + 3600_000;
    const treffer = werte.filter((s) => s.t >= von && s.t < bis);
    if (treffer.length === 0) return null;
    return treffer.reduce((sum, s) => sum + s.kw, 0) / treffer.length;
  });
}

/** „12,2" — eine Nachkommastelle, das Vokabular der kW-Flächen. */
function kw1(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/* ---------------------------------------------------------------------------
 * K10 · Benannte Himmelsblöcke statt Wolken-Wisch
 *
 * Die Revision 1 malte die Bewölkung als Grau-Wisch und musste ihn in der
 * Legende erklären („dunkler = dichter") — wenn die Legende die Kodierung
 * erklären muss, ist es keine Kodierung, sondern ein Rätsel. Jetzt trägt jeder
 * Block sein WORT.
 *
 * Die Schwellen sind DIESELBEN, mit denen `weather.weatherWhy` seit jeher den
 * PV-Satz baut (< 40 % = sonnig, >= 65 % = bedeckt) — zwei Schwellensätze für
 * dieselbe Frage wären zwei Wahrheiten.
 * ------------------------------------------------------------------------- */

export type Himmel = 'sonnig' | 'wechselnd' | 'bedeckt';

/** Unter dieser Bewölkung ist es „sonnig" — DIE Schwelle aus `weather.ts`. */
export const SONNIG_MAX_PCT = SUNNY_MAX_CLOUD;
/** Ab dieser Bewölkung ist es „bedeckt" — DIE Schwelle aus `weather.ts`. */
export const BEDECKT_MIN_PCT = CLOUDY_MIN_CLOUD;
/**
 * Kürzere Blöcke werden mit dem Nachbarn verschmolzen: eine einzelne Stunde
 * ergäbe wieder das Konfetti, das der Wisch war.
 */
export const MIN_BLOCK_STUNDEN = 2;

export interface HimmelBlock {
  art: Himmel;
  /** Erster/letzter Index in der Punktreihe (EINSCHLIESSLICH). */
  von: number;
  bis: number;
  /** Das Wort im Bild — „sonnig" · „wechselnd" · „bedeckt". */
  wort: Himmel;
  /** Anteil an der Gesamtbreite (0..1), damit der Render nur noch verteilt. */
  anteil: number;
}

function himmelVon(pct: number): Himmel {
  if (pct < SONNIG_MAX_PCT) return 'sonnig';
  if (pct >= BEDECKT_MIN_PCT) return 'bedeckt';
  return 'wechselnd';
}

/**
 * Die zusammenhängenden Himmelsblöcke der Vorhersage. Ein Punkt ohne
 * Bewölkungswert erbt den laufenden Block, statt eine Lücke zu behaupten —
 * die Aussage ist grob, und eine Ein-Stunden-Lücke ist keine Wetteränderung.
 * Ohne jeden Wert gibt es GAR KEINEN Streifen.
 */
export function himmelBloecke(punkte: readonly WetterPunkt[]): HimmelBlock[] {
  const arten = punkte.map((p) => (p.cloudCoverPct == null ? null : himmelVon(p.cloudCoverPct)));
  if (!arten.some((a) => a != null)) return [];

  const roh: { art: Himmel; von: number; bis: number }[] = [];
  arten.forEach((a, i) => {
    const letzte = roh[roh.length - 1];
    if (a == null && letzte) {
      letzte.bis = i;
      return;
    }
    if (a == null) return;
    if (letzte && letzte.art === a) letzte.bis = i;
    else roh.push({ art: a, von: i, bis: i });
  });

  // Zu kurze Blöcke an den Nachbarn geben (kein Konfetti).
  const zusammen: typeof roh = [];
  for (const b of roh) {
    const len = b.bis - b.von + 1;
    const letzte = zusammen[zusammen.length - 1];
    if (len < MIN_BLOCK_STUNDEN && letzte) letzte.bis = b.bis;
    else if (letzte && letzte.art === b.art) letzte.bis = b.bis;
    else zusammen.push({ ...b });
  }

  const n = punkte.length || 1;
  return zusammen.map((b) => ({
    art: b.art,
    von: b.von,
    bis: b.bis,
    wort: b.art,
    anteil: (b.bis - b.von + 1) / n,
  }));
}

/* ---------------------------------------------------------------------------
 * K6 · Die eine benannte Marke + K1 · der Kernaussage-Satz
 * ------------------------------------------------------------------------- */

export interface BesteStunde {
  index: number;
  kw: number;
  /** „beste Stunde morgen · 12,2 kW" — Wort UND Zahl. */
  text: string;
}

function tagWort(iso: string, jetzt: Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tage = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()).getTime()) /
      86400_000,
  );
  if (tage === 0) return 'heute';
  if (tage === 1) return 'morgen';
  if (tage < 0) return null;
  return d.toLocaleDateString('de-DE', { weekday: 'long' });
}

/**
 * Die stärkste noch KOMMENDE Stunde als benannte Marke (K6). Vergangene
 * Stunden werden nie markiert — „beste Stunde" ist eine Ansage, kein Rückblick.
 */
export function besteStunde(
  punkte: readonly WetterPunkt[],
  kw: readonly (number | null)[],
  jetzt: Date,
): BesteStunde | null {
  const nowMs = jetzt.getTime();
  let best = -1;
  kw.forEach((v, i) => {
    if (v == null || v <= 0) return;
    const t = Date.parse(punkte[i]?.ts ?? '');
    if (!Number.isFinite(t) || t < nowMs) return;
    if (best < 0 || v > (kw[best] as number)) best = i;
  });
  if (best < 0) return null;
  const tag = tagWort(punkte[best].ts, jetzt);
  return {
    index: best,
    kw: kw[best] as number,
    text: `beste Stunde${tag ? ` ${tag}` : ''} · ${kw1(kw[best] as number)} kW`,
  };
}

/** Der ehrliche Grund, wenn die Leitgröße fehlt. */
export const KEINE_LEISTUNG_GRUND =
  'Für die kommenden Stunden liegt noch keine PV-Prognose Ihrer Anlage vor - hier steht solange die Sonnenstärke.';

/**
 * K1 · „Morgen scheint die Sonne stärker als heute — mittags erwarten wir rund
 * 12 kW aus Ihrer Anlage."
 *
 * ABGELEITET aus derselben kW-Reihe, die das Diagramm zeichnet: die stärkste
 * kommende Stunde trägt die Zahl, der Vergleich kommt aus den Tagesspitzen von
 * heute und morgen. Ohne Leitgröße steht dort der GRUND, nie ein erfundener
 * Satz.
 */
export function wetterKern(
  punkte: readonly WetterPunkt[],
  kw: readonly (number | null)[],
  jetzt: Date,
): Kernaussage {
  const best = besteStunde(punkte, kw, jetzt);
  if (!best) return { wert: null, satz: null, grund: KEINE_LEISTUNG_GRUND, ton: 'calm' };

  const spitzeAm = (tage: number): number | null => {
    const ziel = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate() + tage);
    let m: number | null = null;
    kw.forEach((v, i) => {
      if (v == null) return;
      const d = new Date(punkte[i]?.ts ?? '');
      if (Number.isNaN(d.getTime())) return;
      if (d.toDateString() !== ziel.toDateString()) return;
      if (m == null || v > m) m = v;
    });
    return m;
  };
  const heute = spitzeAm(0);
  const morgen = spitzeAm(1);

  const wann = tagWort(punkte[best.index].ts, jetzt);
  const stunde = new Date(punkte[best.index].ts).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const satz =
    `Am stärksten wird es ${wann ? `${wann} ` : ''}gegen ${stunde} Uhr` +
    ` - dann erwarten wir rund ${kw1(best.kw)} kW aus Ihrer Anlage.`;

  // K8: der Vergleichsanker - nur behauptet, wo beide Tage wirklich Werte
  // tragen (der Plan-Horizont reicht oft nicht über morgen hinaus).
  let anker: string | null = null;
  if (heute != null && morgen != null && Math.max(heute, morgen) > 0) {
    const diff = morgen - heute;
    anker =
      Math.abs(diff) < 0.5
        ? `Morgen etwa so viel wie heute (${kw1(heute)} kW Spitze).`
        : diff > 0
          ? `Morgen mehr als heute (${kw1(heute)} → ${kw1(morgen)} kW Spitze).`
          : `Morgen weniger als heute (${kw1(heute)} → ${kw1(morgen)} kW Spitze).`;
  }

  return { wert: null, satz, grund: null, ton: 'ok', anker };
}

/* ---------------------------------------------------------------------------
 * F8 · Höchstens ZWEI Achsen — die Temperatur wird zur Zeile
 *
 * Das Bild hatte drei Y-Achsen (°C, %, W/m²) mit drei Strichstärken. Zwei
 * davon fallen weg: die Bewölkung ist jetzt der benannte Himmelsstreifen, und
 * die Temperatur beantwortet einem PV-Betreiber als Kurve über drei Tage
 * nichts, was ein Satz nicht besser sagt. Sie bleibt damit sichtbar (K3: eine
 * Stufe tiefer), ohne eine dritte Achse zu erzwingen.
 * ------------------------------------------------------------------------- */

/**
 * „Temperatur: jetzt 18 °C, heute bis 24 °C." — `null`, wenn die Vorhersage
 * keine Temperatur trägt (dann wird nichts behauptet).
 */
export function temperaturZeile(punkte: readonly WetterPunkt[], jetzt: Date): string | null {
  const nowMs = jetzt.getTime();
  const kommend = punkte.filter(
    (p) => p.temperatureC != null && Date.parse(p.ts) >= nowMs,
  );
  if (kommend.length === 0) return null;
  const jetztWert = Number(kommend[0].temperatureC);
  const heute = kommend.filter(
    (p) => new Date(p.ts).toDateString() === jetzt.toDateString(),
  );
  const grad = (v: number) =>
    `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} °C`;
  if (heute.length === 0) return `Temperatur: ${grad(jetztWert)} in der nächsten Stunde.`;
  const max = Math.max(...heute.map((p) => Number(p.temperatureC)));
  return `Temperatur: ${grad(jetztWert)} jetzt, heute bis ${grad(max)}.`;
}
