/**
 * Der Baustein „Heute" einer Geräteseite (Konzept „Geräteseiten: Ein Blick,
 * eine Antwort", Baustein 4; Entscheid E2 a).
 *
 * Er zeigt den TAGESVERLAUF der einen Hauptgröße dieses Geräts - Ladestand,
 * Erzeugung, Netz, Leistung - aus dem BESTEHENDEN Abruf
 * `GET …/entities/{id}/history?range=day` (Viertelstunden des Berliner Tages).
 *
 * Drei Ehrlichkeitsregeln, alle Haus-Regeln:
 *
 * 1. **Keine erfundene Tagessumme.** Die Viertelstunden tragen MITTLERE
 *    Leistungen, keine Energie - eine kWh-Zahl daraus wäre eine Rechnung, die
 *    niemand gemessen hat. Gesagt wird, was belegt ist: Höchst- bzw.
 *    Tiefstwert mit Uhrzeit.
 * 2. **Lücken bleiben Lücken.** Eine Viertelstunde ohne Messung ist `null`,
 *    nie eine 0 - und die Zukunft des Tages auch.
 * 3. **Die Richtung ist ein Wort.** Netz: über der Linie Bezug, darunter
 *    Einspeisung; Batterie: über der Linie laden, darunter abgeben (die
 *    `live.ts`-Konvention).
 *
 * Rein; `components/GeraetHeute.tsx` lädt und rendert.
 */
import type { EntityHistory } from './api';
import { fmtNum } from './format';
import type { Gattung } from './geraetGesicht';
import type { PlantComponent } from './komponenten';
import type { MiniPoint } from './miniChart';

/** Welche Reihe die Karte zeigt. */
export interface HeuteKanal {
  entityId: string;
  channel: string;
  /** „Ladestand", „Erzeugung", „Netz", „Leistung", „Ladeleistung". */
  titel: string;
  einheit: 'kW' | '%';
  /** Wie ein Vorzeichen heißt - `null` = die Reihe hat keine Richtung. */
  richtung: 'netz' | 'batterie' | null;
  /** Die Farbe aus der Energiefluss-Familie (`--vp-flow-*`). */
  farbe: 'pv' | 'batt' | 'grid' | 'load';
}

function hatKanal(c: PlantComponent | undefined, channel: string): boolean {
  return Boolean(c?.channels.some((m) => m.raw === channel));
}

/**
 * Die Hauptgröße eines Blatts - oder null, wenn es keine hat (I/O-Modul, Box)
 * oder die Komponente den Kanal nicht misst.
 *
 * ⚠ Gefragt wird nur ein Kanal, den die Komponente WIRKLICH führt
 * (`PlantComponent.channels`): eine Reihe über einen geratenen Kanal wäre eine
 * leere Karte mit erfundenem Titel.
 */
export function heuteKanal(
  g: { gattung: Gattung; ioModul: boolean },
  komponenten: readonly PlantComponent[],
  massgeblich = false,
): HeuteKanal | null {
  if (g.ioModul) return null;
  const main = (role: PlantComponent['role']) =>
    komponenten.find((c) => c.role === role && c.aspect === 'main');
  switch (g.gattung) {
    case 'wechselrichter-speicher': {
      const s = main('storage');
      if (!s) return null;
      if (hatKanal(s, 'soc_pct')) {
        return {
          entityId: s.entityId, channel: 'soc_pct', titel: 'Ladestand', einheit: '%',
          richtung: null, farbe: 'batt',
        };
      }
      if (hatKanal(s, 'battery_power_kw')) {
        return {
          entityId: s.entityId, channel: 'battery_power_kw', titel: 'Batterieleistung',
          einheit: 'kW', richtung: 'batterie', farbe: 'batt',
        };
      }
      return null;
    }
    case 'wechselrichter':
    case 'pv-melder': {
      const pv = komponenten.find((c) => c.role === 'pv' && hatKanal(c, 'pv_power_kw'));
      return pv
        ? {
          entityId: pv.entityId, channel: 'pv_power_kw', titel: 'Erzeugung', einheit: 'kW',
          richtung: null, farbe: 'pv',
        }
        : null;
    }
    case 'zaehler': {
      const z = main('grid');
      const channel = hatKanal(z, 'power_kw') ? 'power_kw'
        : hatKanal(z, 'grid_power_kw') ? 'grid_power_kw' : null;
      return z && channel
        ? {
          entityId: z.entityId, channel, titel: massgeblich ? 'Netz' : 'Leistung', einheit: 'kW',
          richtung: 'netz', farbe: 'grid',
        }
        : null;
    }
    case 'verbraucher': {
      const v = main('consumer');
      return v && hatKanal(v, 'power_kw')
        ? {
          entityId: v.entityId, channel: 'power_kw', titel: 'Leistung', einheit: 'kW',
          richtung: null, farbe: 'load',
        }
        : null;
    }
    case 'ladepunkt': {
      const lp = komponenten.find((c) => hatKanal(c, 'power_kw'));
      return lp
        ? {
          entityId: lp.entityId, channel: 'power_kw', titel: 'Ladeleistung', einheit: 'kW',
          richtung: null, farbe: 'load',
        }
        : null;
    }
    default:
      return null;
  }
}

/** Ein Extremwert mit seiner Viertelstunde. */
export interface HeuteMarke {
  wert: number;
  key: string;
  uhr: string;
}

/** Eine Beschriftung der Zeitachse - an ihrer WAHREN Stelle im Tag. */
export interface HeuteTick {
  label: string;
  /** Linke Kante der Viertelstunde als Anteil der Breite (0 … 1). */
  anteil: number;
}

export interface HeuteView {
  /** Eine Säule je Viertelstunde des Tages; `null` = keine Messung oder Zukunft. */
  punkte: MiniPoint[];
  /**
   * Die Zeitachse: 0, 6, 12, 18 Uhr und das Tagesende - aus den Uhrzeiten der
   * Viertelstunden, nicht als gleichmäßige Fünftel. Ein Tag der Zeitumstellung
   * hat 23 oder 25 Stunden, und dort stünde „12" sonst an der falschen Stelle.
   */
  achse: HeuteTick[];
  /** Die Viertelstunde, in der „jetzt" liegt - null außerhalb des Tages. */
  jetztKey: string | null;
  hoechst: HeuteMarke | null;
  tiefst: HeuteMarke | null;
  /** Der Satz unter der Reihe - null, wenn es nichts Belegtes zu sagen gibt. */
  satz: string | null;
  /** Kein einziger Messwert heute. */
  leer: boolean;
}

/** „14:15" in der Zone des Browsers - dieselbe Uhr wie die Achse darüber. */
function uhr(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * „2,4 kW" / „64 %" - die Einheit der Reihe, eine Nachkommastelle bei kW.
 *
 * ⚠ Den Betrag nimmt nur eine Reihe MIT Richtung - dort sagt das Wort daneben,
 * wohin es floss. Ohne Richtung behält ein negativer Wert sein Vorzeichen;
 * „0,3 kW" für −0,3 kW wäre eine erfundene Aussage.
 */
export function heuteWert(wert: number, kanal: HeuteKanal): string {
  if (kanal.einheit === '%') return fmtNum(wert, '%', 0);
  return fmtNum(kanal.richtung == null ? wert : Math.abs(wert), 'kW');
}

/** Das Richtungswort eines Werts, oder null. */
export function heuteRichtung(wert: number, kanal: HeuteKanal): string | null {
  if (kanal.richtung == null || Math.abs(wert) < 0.05) return null;
  if (kanal.richtung === 'netz') return wert > 0 ? 'Bezug' : 'Einspeisung';
  return wert > 0 ? 'lädt' : 'gibt ab';
}

const STUNDE_MS = 3_600_000;
/** Der kürzeste Berliner Tag: der der Umstellung auf Sommerzeit. */
const KUERZESTER_TAG_MS = 23 * STUNDE_MS;

/**
 * Die Reihe des Tages: EIN Punkt je Viertelstunde von `from` bis `to` (der
 * Berliner Tag, den der Server nennt). Belegt ist nur, wofür ein Bucket kam.
 *
 * ⚠ Die Karte heißt „Heute" und zeigt deshalb IMMER den ganzen Tag. Nennt eine
 * Antwort ein kürzeres Fenster, bleibt der Rest des Tages eine Lücke - die
 * vorhandenen Viertelstunden werden nie auf die volle Breite gestreckt, denn
 * dann stünde der Mittag unter „24".
 */
export function heuteView(history: EntityHistory, kanal: HeuteKanal, now: number): HeuteView {
  const from = Date.parse(history.from);
  const bis = Date.parse(history.to);
  const to = Number.isFinite(bis) && bis - from >= KUERZESTER_TAG_MS ? bis : from + 24 * STUNDE_MS;
  const schritt = Math.max(1, history.bucketMinutes || 15) * 60_000;
  const werte = new Map<number, number>();
  for (const b of history.channels[kanal.channel] ?? []) {
    const t = Date.parse(b.start);
    const v = num(b.avg);
    if (Number.isFinite(t) && v != null) werte.set(t, v);
  }
  const punkte: MiniPoint[] = [];
  let jetztKey: string | null = null;
  let hoechst: HeuteMarke | null = null;
  let tiefst: HeuteMarke | null = null;
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    for (let t = from; t < to; t += schritt) {
      const key = new Date(t).toISOString();
      // ⚠ Die Zukunft ist eine LÜCKE: ein Bucket, der nach „jetzt" beginnt,
      // kann nichts gemessen haben.
      const v = t <= now ? werte.get(t) ?? null : null;
      punkte.push({ key, value: v, label: uhr(t) });
      if (now >= t && now < t + schritt) jetztKey = key;
      if (v == null) continue;
      if (hoechst == null || v > hoechst.wert) hoechst = { wert: v, key, uhr: uhr(t) };
      if (tiefst == null || v < tiefst.wert) tiefst = { wert: v, key, uhr: uhr(t) };
    }
  }
  const leer = hoechst == null;
  return {
    punkte,
    achse: Number.isFinite(from) && punkte.length > 0 ? achseVon(from, to, schritt, punkte.length) : [],
    jetztKey,
    hoechst,
    tiefst,
    satz: leer ? null : heuteSatz(kanal, hoechst, tiefst),
    leer,
  };
}

/**
 * Die Beschriftungen der Achse: jede volle sechste Stunde (in der Uhr des
 * Browsers - derselben wie die Ablese-Uhrzeiten) an der linken Kante IHRER
 * Viertelstunde, dazu das Tagesende am rechten Rand.
 */
function achseVon(from: number, to: number, schritt: number, anzahl: number): HeuteTick[] {
  const out: HeuteTick[] = [];
  for (let i = 0; i < anzahl; i += 1) {
    const d = new Date(from + i * schritt);
    if (d.getMinutes() !== 0 || d.getHours() % 6 !== 0) continue;
    out.push({ label: out.length === 0 ? `${d.getHours()} Uhr` : String(d.getHours()), anteil: i / anzahl });
  }
  const ende = new Date(to);
  if (ende.getMinutes() === 0) {
    out.push({ label: ende.getHours() === 0 ? '24' : String(ende.getHours()), anteil: 1 });
  }
  return out;
}

/** Der Satz unter der Reihe - aus den zwei belegten Extremen, nie eine Summe. */
function heuteSatz(kanal: HeuteKanal, hoch: HeuteMarke | null, tief: HeuteMarke | null): string | null {
  if (!hoch || !tief) return null;
  if (kanal.richtung === 'netz') {
    const teile: string[] = [];
    if (hoch.wert > 0.05) teile.push(`Höchster Bezug ${heuteWert(hoch.wert, kanal)} um ${hoch.uhr}`);
    if (tief.wert < -0.05) teile.push(`höchste Einspeisung ${heuteWert(tief.wert, kanal)} um ${tief.uhr}`);
    return teile.length > 0 ? `${teile.join(' · ')}.` : 'Heute fast ausgeglichen.';
  }
  if (kanal.richtung === 'batterie') {
    const teile: string[] = [];
    if (hoch.wert > 0.05) teile.push(`Laden bis ${heuteWert(hoch.wert, kanal)} um ${hoch.uhr}`);
    if (tief.wert < -0.05) teile.push(`Abgeben bis ${heuteWert(tief.wert, kanal)} um ${tief.uhr}`);
    return teile.length > 0 ? `${teile.join(' · ')}.` : null;
  }
  if (kanal.einheit === '%') {
    return `Zwischen ${heuteWert(tief.wert, kanal)} (${tief.uhr}) und ${heuteWert(hoch.wert, kanal)} `
      + `(${hoch.uhr}).`;
  }
  return hoch.wert > 0.05 ? `Höchstwert ${heuteWert(hoch.wert, kanal)} um ${hoch.uhr}.` : null;
}

/** Der Ablese-Satz einer angetippten Viertelstunde („12:15 · 3,4 kW Bezug"). */
export function heuteAblesung(p: MiniPoint, kanal: HeuteKanal): string {
  if (p.value == null) return `${p.label ?? ''} · keine Messung`.trim();
  const wort = heuteRichtung(p.value, kanal);
  return `${p.label ?? ''} · ${heuteWert(p.value, kanal)}${wort ? ` ${wort}` : ''}`;
}
