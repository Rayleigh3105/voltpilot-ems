/**
 * Die WÖRTER UND WERTE des Fahrplan-Tagesbilds (Konzept „Tagesuhr und
 * Bildfahrplan"): was unter der Uhr bzw. dem Bildfahrplan zur Viertelstunde
 * am Zeiger steht — die Moment-Zeile, die Werte am Zeiger, die Lupe und die
 * Einführung in fünf Schritten (E11).
 *
 * Jede Zahl ist ein Feld des Plans oder eine Messung, die die Viertelstunde
 * trägt; es wird nichts neu gerechnet. Drei Ehrlichkeitsregeln:
 *  - Vergangene Viertelstunden zeigen den Plan, der für sie GALT („war
 *    geplant"), nie eine Messung des Speichers — die liest diese Seite nicht.
 *  - Sonne und Verbrauch sind gemessen, wo die Viertelstunde eine Messung
 *    trägt, sonst erwartet — und sagen das.
 *  - Fehlt ein Wert, steht „–", nie eine 0.
 *
 * Rein: kein React, kein Netz.
 */

import type { IconName } from '../designsystem/components/core/Icon';
import { energieFluss, type FlussStrom } from './fahrplanBildfahrplan';
import { phaseVon, uhrzeit, type TagModell } from './fahrplanTag';
import type { SlotRole } from './fahrplanWhy';
import { fmtNum } from './format';

/** Die Ebenen des Bildes, die man einzeln hervorheben kann. */
export type TagesbildEbene = 'sonne' | 'preis' | 'taetigkeit' | 'ladestand';

/** E10: ab dieser Inhaltsbreite zeigt die Seite den Bildfahrplan statt der Uhr. */
export const BILD_AB_PX = 900;
/** Ab dieser Breite stehen Uhr und Antworten nebeneinander (bis E10). */
export const ZWEISPALTIG_AB_PX = 640;

/**
 * Das Symbol jeder Tätigkeit — die Identität einer Phase hängt nie an der
 * Farbe allein (Grün und Türkis sind für viele nicht zu trennen).
 */
export const ROLLEN_SYMBOL: Readonly<Record<SlotRole, IconName>> = {
  pv_speichern: 'sun',
  guenstig_laden: 'zap',
  eigenverbrauch: 'home',
  verkaufen: 'euro',
  spitze_kappen: 'trending-down',
  abregeln: 'sliders',
  warten: 'battery',
  reserve_halten: 'shield',
};

/** Schwelle, unter der eine Leistung Rauschen ist (kW). */
const RUHE_KW = 0.05;

function zahl(v: unknown): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

function pct(v: number): string {
  return `${Math.round(v).toLocaleString('de-DE')} %`;
}

function ct(v: number): string {
  return fmtNum(v, 'ct/kWh', 1);
}

/** „Ladestand 52 % geplant" — für Screenreader und Titel. */
export function ladestandText(socPct: number, vorbei: boolean): string {
  return `Ladestand ${pct(socPct)} ${vorbei ? 'war geplant' : 'geplant'}`;
}

/** Was die Viertelstunde am Zeiger ist: jetzt, noch geplant oder vorbei. */
export type MomentArt = 'jetzt' | 'geplant' | 'vorbei';

export interface MomentZeile {
  art: MomentArt;
  /** „Jetzt · 14:10" bzw. „14:15–14:30 Uhr". */
  zeit: string;
  /** Das Listenwort der Phase (E8); null ohne Phase. */
  was: string | null;
  role: SlotRole | null;
  /** „Geplant: laden mit 2,2 kW · Ladestand danach 52 %". */
  plan: string | null;
}

/** Die Leistung des Plans in Worten („laden mit 2,2 kW"). */
function planLeistung(batteryKw: number | null): string | null {
  if (batteryKw == null) return null;
  if (batteryKw > RUHE_KW) return `laden mit ${fmtNum(batteryKw, 'kW')}`;
  if (batteryKw < -RUHE_KW) return `abgeben mit ${fmtNum(-batteryKw, 'kW')}`;
  return 'kein Laden, kein Abgeben';
}

/** Die Zeile unter dem Bild für die Viertelstunde am Zeiger. */
export function momentZeile(tag: TagModell, i: number, istJetzt: boolean): MomentZeile | null {
  const v = tag.viertel[i];
  const s = tag.slots[i];
  if (!v || !s) return null;
  const art: MomentArt = istJetzt ? 'jetzt' : v.vorbei ? 'vorbei' : 'geplant';
  const ph = phaseVon(tag, i);
  const leistung = planLeistung(zahl(s.batteryKw));
  const soc = zahl(s.socPct);
  const teile = [
    leistung,
    soc == null ? null : `Ladestand danach ${pct(soc)}`,
  ].filter((x): x is string => x != null);
  return {
    art,
    zeit:
      istJetzt && tag.jetzt != null
        ? `Jetzt · ${uhrzeit(tag.jetzt)}`
        : `${uhrzeit(v.von)}–${uhrzeit(v.bis)} Uhr`,
    was: ph?.label ?? null,
    role: ph?.role ?? null,
    plan: teile.length === 0 ? null : `${art === 'vorbei' ? 'War geplant' : 'Geplant'}: ${teile.join(' · ')}`,
  };
}

/** Ein Wert am Zeiger — drei kurze Zeilen, damit vier nebeneinander passen. */
export interface ZeigerWert {
  ebene: TagesbildEbene;
  label: string;
  wert: string;
  /** „gemessen", „erwartet", „geplant", „Börse" …; null = kein Wert. */
  herkunft: string | null;
  /** Der ganze Satz für Screenreader („Speicher: lädt 2,2 kW, geplant"). */
  satz: string;
}

/**
 * Die vier Werte am Zeiger: Sonne, Strompreis, Speicher, Ladestand — die
 * Legende, die zugleich ablesbar ist.
 */
export function werteAmZeiger(tag: TagModell, i: number): ZeigerWert[] {
  const v = tag.viertel[i];
  const s = tag.slots[i];
  if (!v || !s) return [];
  const gewesen = v.vorbei || v.laeuft;
  const pvGemessen = gewesen ? zahl(s.measuredPvKw) : null;
  const pvErwartet = zahl(s.pvKw);
  const preis = tag.preis?.ct[i] ?? null;
  const kw = zahl(s.batteryKw);
  const soc = zahl(s.socPct);
  const planWort = v.vorbei ? 'war geplant' : 'geplant';
  const sonneWert = pvGemessen != null ? fmtNum(pvGemessen, 'kW') : pvErwartet != null ? fmtNum(pvErwartet, 'kW') : '–';
  const sonneHer = pvGemessen != null ? 'gemessen' : pvErwartet != null ? 'erwartet' : null;
  // Der Preis, mit dem entschieden wurde (Bezug), sonst ausdrücklich die Börse.
  const preisHer = preis == null ? null : tag.preis?.art === 'boerse' ? 'Börse' : 'Bezug';
  // Die Richtung des Speichers sagt das Wort der Phase direkt darüber; die
  // Zelle nennt die Leistung und dass sie geplant ist.
  const speicherWert = kw == null ? '–' : Math.abs(kw) > RUHE_KW ? fmtNum(Math.abs(kw), 'kW') : 'ruht';
  const richtung = kw == null ? '' : kw > RUHE_KW ? 'lädt ' : kw < -RUHE_KW ? 'gibt ab ' : '';
  return [
    {
      ebene: 'sonne',
      label: 'Sonne',
      wert: sonneWert,
      herkunft: sonneHer,
      satz: `Sonne: ${sonneWert}${sonneHer ? `, ${sonneHer}` : ''}`,
    },
    {
      ebene: 'preis',
      label: 'Preis',
      // Kurz in der Leiste („ct" je kWh); voll in Lupe und Erklär-Panel.
      wert: preis == null ? '–' : fmtNum(preis, 'ct', 1),
      herkunft: preisHer,
      satz:
        preis == null
          ? 'Preis: kein Wert'
          : `${tag.preis?.art === 'boerse' ? 'Börsenpreis' : 'Strompreis'}: ${ct(preis)}`,
    },
    {
      ebene: 'taetigkeit',
      label: 'Speicher',
      wert: speicherWert,
      herkunft: kw == null ? null : planWort,
      satz: kw == null ? 'Speicher: kein Wert' : `Speicher: ${richtung}${speicherWert}, ${planWort}`,
    },
    {
      ebene: 'ladestand',
      label: 'Ladestand',
      wert: soc == null ? '–' : pct(soc),
      herkunft: soc == null ? null : planWort,
      satz: soc == null ? 'Ladestand: kein Wert' : `Ladestand: ${pct(soc)}, ${planWort}`,
    },
  ];
}

/** Die Schritte der Einführung (E11): Ring für Ring, zuletzt der Zeiger. */
export const EINFUEHRUNG: readonly { ebene: TagesbildEbene | 'zeiger'; titel: string }[] = [
  { ebene: 'sonne', titel: 'Sonne' },
  { ebene: 'preis', titel: 'Strompreis' },
  { ebene: 'taetigkeit', titel: 'Was der Speicher tut' },
  { ebene: 'ladestand', titel: 'Ladestand' },
  { ebene: 'zeiger', titel: 'Der Zeiger' },
];

/**
 * Der Schlüssel der „gesehen"-Marke der Einführung — im Layout-Dokument der
 * Organisation (`document.seen`, das Muster von `steuerungIntro.ts`): auf
 * jedem Gerät desselben Kunden nur einmal, nie über `localStorage`.
 */
export const EINFUEHRUNG_KEY = 'fahrplan-uhr-einfuehrung';

/** Der Satz, der eine Ebene der Uhr erklärt (Werte am Zeiger, Einführung). */
export function ebenenSatz(tag: TagModell, ebene: TagesbildEbene | 'zeiger'): string {
  switch (ebene) {
    case 'sonne':
      return 'Außen die Sonne: ein Strahl je Viertelstunde. Kräftig ist gemessen, hell ist erwartet.';
    case 'preis': {
      const pr = tag.preis;
      const name = pr?.art === 'boerse' ? 'der Börsenpreis' : 'Ihr Strompreis';
      const satz = `Der blaue Ring ist ${name} je Viertelstunde: hell günstig, dunkel teuer.`;
      if (!pr) return satz;
      const tagWort = tag.jetzt != null ? 'Heute' : 'An diesem Tag';
      return (
        `${satz} ${tagWort} am günstigsten um ${uhrzeit(tag.viertel[pr.iMin].von)} Uhr (${ct(pr.min)}), ` +
        `am teuersten um ${uhrzeit(tag.viertel[pr.iMax].von)} Uhr (${ct(pr.max)}).`
      );
    }
    case 'taetigkeit':
      return 'Der breite Ring zeigt, was der Speicher tun soll, jede längere Phase mit Symbol. Was vorbei ist, ist blasser: so war es geplant.';
    case 'ladestand':
      return 'Die lila Fläche ist der geplante Ladestand: je weiter außen, desto voller. Die Mitte zeigt den Wert am Zeiger.';
    case 'zeiger':
      return 'Ziehen Sie den Zeiger oder tippen Sie auf eine Uhrzeit: Alle Antworten gelten dann für diesen Moment. Ein Tipp in die Mitte holt die Gegenwart zurück. Tippen Sie auf eine Antwort, zeigt die Uhr, wo sie steht.';
  }
}

/**
 * Welcher Plan erklärt eine Viertelstunde des Tagesbilds? Der JÜNGSTE Lauf,
 * wenn er sie trägt — das sind die Zahlen, die das Gerät gerade ausführt, mit
 * den Lauf-Fakten dazu. Sonst (Vergangenes) der Tages-Splice, der sie damals
 * geplant hat. Ergebnis: der Index im jüngsten Lauf, oder -1.
 */
export function indexImLauf(start: string, lauf: readonly { start: string }[]): number {
  const t = new Date(start).getTime();
  return lauf.findIndex((s) => new Date(s.start).getTime() === t);
}

/** Die Lupe des Bildfahrplans: eine Viertelstunde im Detail. */
export interface LupeView {
  zeit: string;
  art: MomentArt;
  was: string | null;
  role: SlotRole | null;
  /** Der GEPLANTE Energiefluss; null ohne Verbrauch oder Speicherwert. */
  fluss: FlussStrom[] | null;
  zeilen: { label: string; wert: string }[];
}

export function lupe(tag: TagModell, i: number): LupeView | null {
  const v = tag.viertel[i];
  const s = tag.slots[i];
  if (!v || !s) return null;
  const art: MomentArt = v.laeuft ? 'jetzt' : v.vorbei ? 'vorbei' : 'geplant';
  const ph = phaseVon(tag, i);
  const gewesen = v.vorbei || v.laeuft;
  const zeilen: { label: string; wert: string }[] = [];
  const preis = tag.preis?.ct[i] ?? null;
  if (preis != null) zeilen.push({ label: tag.preis?.art === 'boerse' ? 'Börsenpreis' : 'Strompreis', wert: ct(preis) });
  const einspeisung = zahl(s.exportValueCtKwh);
  if (einspeisung != null) zeilen.push({ label: 'Einspeisewert', wert: ct(einspeisung) });
  const lambda = zahl(s.storedValueCtKwh);
  if (lambda != null) zeilen.push({ label: 'Wert gespeicherter Energie', wert: ct(lambda) });
  const pvM = gewesen ? zahl(s.measuredPvKw) : null;
  const pvF = zahl(s.pvKw);
  if (pvM != null) zeilen.push({ label: 'Sonne gemessen', wert: fmtNum(pvM, 'kW') });
  else if (pvF != null) zeilen.push({ label: 'Sonne erwartet', wert: fmtNum(pvF, 'kW') });
  const ldM = gewesen ? zahl(s.measuredLoadKw) : null;
  const ldF = zahl(s.loadKw);
  if (ldM != null) zeilen.push({ label: 'Verbrauch gemessen', wert: fmtNum(ldM, 'kW') });
  else if (ldF != null) zeilen.push({ label: 'Verbrauch erwartet', wert: fmtNum(ldF, 'kW') });
  const soc = zahl(s.socPct);
  if (soc != null) zeilen.push({ label: 'Ladestand danach', wert: pct(soc) });
  return {
    zeit: `${uhrzeit(v.von)}–${uhrzeit(v.bis)} Uhr`,
    art,
    was: ph?.label ?? null,
    role: ph?.role ?? null,
    fluss: energieFluss({
      pvKw: pvF,
      loadKw: ldF,
      batteryKw: zahl(s.batteryKw),
      curtailKw: zahl(s.curtailKw),
    }),
    zeilen,
  };
}

/** Die Knoten des Energieflusses in Kundenwörtern. */
export const FLUSS_WORT: Readonly<Record<FlussStrom['von'], string>> = {
  sonne: 'Sonne',
  netz: 'Netz',
  speicher: 'Speicher',
  haus: 'Haus',
};
