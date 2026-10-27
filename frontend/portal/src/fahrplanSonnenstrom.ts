/**
 * „Ihr Sonnenstrom heute" und die Autarkie-Kachel (Konzept
 * `vp-fahrplan-eigenverbrauch-konzept` §4.3/§4.5, Scheibe S3).
 *
 * Zwei Zahlen aus zwei verschiedenen, je für sich ehrlichen Quellen:
 *  - die KACHEL „Aus eigenem Strom X %" ({@link autarkieHeute}) mischt die
 *    GEMESSENE Autarkie des Tages bis jetzt (`HistoryTotals.consumptionKwh`/
 *    `gridImportKwh` - dieselbe Quelle wie Cockpit und Erlöse, NIE aus dem
 *    Fahrplan-Snapshot rekonstruiert) mit dem GEPLANTEN Rest des Tages (den
 *    noch kommenden Viertelstunden des Plans);
 *  - der Balken „Ihr Sonnenstrom heute" ({@link sonnenstromModell}) zeigt,
 *    WOHIN die Energie floss/fließt, je Viertelstunde aus
 *    `fahrplanTagesband.energieFluss` summiert - bis jetzt mit den
 *    gemessenen Leistungen, danach geplant.
 *
 * ⚠ Der Speicher-Fluss hat keine eigene Messung (`WhySlot.batteryKw` ist der
 * EINE Wert, den der Plan kennt): eine „gemessene" Viertelstunde im Balken
 * heißt Sonne und Haus gemessen, der Speicher-Anteil bleibt der geplante -
 * dieselbe Vereinfachung, die die Lupe einer einzelnen Viertelstunde schon
 * immer macht (`fahrplanTagesbild.lupe`).
 *
 * Rein: kein React, kein Netz.
 */
import type { TagModell } from './fahrplanTag';
import { energieFluss, type FlussKnoten } from './fahrplanTagesband';

function zahl(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** Die Sonne des Tages: wohin sie floss/fließt; `auto` hat keinen Messwert (Wallbox-Konzept separat). */
export interface SonneBalken {
  gesamtKwh: number;
  haus: number;
  speicher: number;
  auto: null;
  netz: number;
}

/** Das Haus des Tages: woher sein Verbrauch kam/kommt. */
export interface HausBalken {
  gesamtKwh: number;
  sonne: number;
  speicher: number;
  netz: number;
}

/** Ab dieser Netz-Einspeisung (kWh/Tag) lohnt der Hinweis auf die Wallbox. */
export const WALLBOX_HINWEIS_AB_KWH = 10;

export interface SonnenstromModell {
  sonne: SonneBalken;
  haus: HausBalken;
  /** „Rund X kWh gehen heute ins Netz …"; null ohne den Anlass. */
  wallboxHinweis: string | null;
}

/** Die Leistungen einer Viertelstunde, wie der Fluss sie lesen soll: gemessen, wo sie vorbei ist/läuft, sonst geplant. */
function slotLeistungen(tag: TagModell, i: number): { pvKw: number | null; loadKw: number | null; stunden: number } {
  const s = tag.slots[i];
  const v = tag.viertel[i];
  const stunden = Math.max(0, v.bis - v.von) / 60;
  const gemessen = v.vorbei || v.laeuft;
  const pvKw = gemessen ? (zahl(s.measuredPvKw) ?? zahl(s.pvKw)) : zahl(s.pvKw);
  const loadKw = gemessen ? (zahl(s.measuredLoadKw) ?? zahl(s.loadKw)) : zahl(s.loadKw);
  return { pvKw, loadKw, stunden };
}

function flussKwh(tag: TagModell, i: number, von: FlussKnoten, nach: FlussKnoten, stunden: number): number {
  const s = tag.slots[i];
  const { pvKw, loadKw } = slotLeistungen(tag, i);
  const fluss = energieFluss({ pvKw, loadKw, batteryKw: zahl(s.batteryKw), curtailKw: zahl(s.curtailKw) });
  if (!fluss) return 0;
  return (fluss.find((f) => f.von === von && f.nach === nach)?.kw ?? 0) * stunden;
}

/**
 * „Ihr Sonnenstrom heute": die Sonne und das Haus des GANZEN Tages, je
 * Viertelstunde aus `energieFluss` summiert (bis jetzt gemessen, danach
 * geplant - siehe Modul-Kopf). `hatWallbox` entscheidet nur über den
 * Hinweistext, nie über die Zahlen selbst.
 */
export function sonnenstromModell(tag: TagModell, hatWallbox: boolean): SonnenstromModell {
  let sonneHaus = 0;
  let sonneSpeicher = 0;
  let sonneNetz = 0;
  let hausSpeicher = 0;
  let hausNetz = 0;
  for (let i = 0; i < tag.slots.length; i++) {
    const { stunden } = slotLeistungen(tag, i);
    if (stunden <= 0) continue;
    sonneHaus += flussKwh(tag, i, 'sonne', 'haus', stunden);
    sonneSpeicher += flussKwh(tag, i, 'sonne', 'speicher', stunden);
    sonneNetz += flussKwh(tag, i, 'sonne', 'netz', stunden);
    hausSpeicher += flussKwh(tag, i, 'speicher', 'haus', stunden);
    hausNetz += flussKwh(tag, i, 'netz', 'haus', stunden);
  }
  const r = Math.round;
  const sonne: SonneBalken = {
    gesamtKwh: r(sonneHaus + sonneSpeicher + sonneNetz),
    haus: r(sonneHaus),
    speicher: r(sonneSpeicher),
    auto: null,
    netz: r(sonneNetz),
  };
  const haus: HausBalken = {
    gesamtKwh: r(sonneHaus + hausSpeicher + hausNetz),
    sonne: r(sonneHaus),
    speicher: r(hausSpeicher),
    netz: r(hausNetz),
  };
  const wallboxHinweis =
    hatWallbox && sonneNetz >= WALLBOX_HINWEIS_AB_KWH
      ? `Rund ${r(sonneNetz)} kWh gehen heute ins Netz – ein Auto an der Wallbox könnte sie nutzen.`
      : null;
  return { sonne, haus, wallboxHinweis };
}

/** Die zwei Tageszahlen, aus denen `HistoryTotals` die gemessene Autarkie bis jetzt belegt. */
export interface HistoryAutarkieEingabe {
  consumptionKwh: number | null;
  gridImportKwh: number | null;
}

export interface AutarkieHeute {
  /** Gerundet (AP-08 E11). */
  pct: number;
  /** `gemischt` = gemessen + geplant; `geplant` = nur der Plan bekannt (Messung fehlt/fehlgeschlagen). */
  quelle: 'gemischt' | 'geplant';
}

/**
 * Die Autarkie-Kachel „Aus eigenem Strom X %": GEMESSEN bis jetzt
 * (`HistoryTotals`, dieselbe Quelle wie Cockpit/Erlöse) + GEPLANT den Rest
 * des Tages (die noch kommenden Viertelstunden des Plans). Fehlt die
 * Messung, bleibt nur der geplante Teil übrig (`quelle: 'geplant'`) - nie
 * eine erfundene Zahl. `null`, trägt weder Messung noch Plan etwas bei.
 */
export function autarkieHeute(tag: TagModell, totals: HistoryAutarkieEingabe | null): AutarkieHeute | null {
  const gemessenVerbrauch = zahl(totals?.consumptionKwh);
  const gemessenNetz = zahl(totals?.gridImportKwh);
  const hatMessung = gemessenVerbrauch != null && gemessenNetz != null;

  let geplantVerbrauch = 0;
  let geplantNetzZuHaus = 0;
  const abJetzt = tag.jetztIndex >= 0 ? tag.jetztIndex + 1 : 0;
  for (let i = abJetzt; i < tag.slots.length; i++) {
    const { loadKw, stunden } = slotLeistungen(tag, i);
    if (loadKw == null || stunden <= 0) continue;
    geplantVerbrauch += loadKw * stunden;
    geplantNetzZuHaus += flussKwh(tag, i, 'netz', 'haus', stunden);
  }

  const gesamtVerbrauch = (hatMessung ? gemessenVerbrauch! : 0) + geplantVerbrauch;
  if (gesamtVerbrauch <= 0) return null;
  const gesamtNichtNetz =
    (hatMessung ? gemessenVerbrauch! - gemessenNetz! : 0) + (geplantVerbrauch - geplantNetzZuHaus);
  const pct = Math.round(Math.max(0, Math.min(100, (gesamtNichtNetz / gesamtVerbrauch) * 100)));
  return { pct, quelle: hatMessung ? 'gemischt' : 'geplant' };
}
