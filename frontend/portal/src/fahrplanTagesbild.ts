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
import { VOM_WR_BESTAETIGT } from './control';
import { energieFluss, type FlussStrom } from './fahrplanBildfahrplan';
import type { JetztHeldView } from './fahrplanJetzt';
import { phaseVon, uhrzeit, type TagModell } from './fahrplanTag';
import { phaseWhy, type SlotRole } from './fahrplanWhy';
import { fmtNum } from './format';
import type { PlanWordingKind } from './schedule';

/** Die Ebenen des Bildes, die man einzeln hervorheben kann. */
export type TagesbildEbene = 'sonne' | 'preis' | 'taetigkeit' | 'ladestand';

/**
 * Der Tag des Tagesschalters (E2 = A: Gestern · Heute · Morgen). Nur HEUTE hat
 * ein Jetzt, eine Ausführung und eine Geldzahl im Lauf; gestern ist der Plan,
 * wie er galt, morgen der jüngste Plan für den Folgetag.
 */
export type TagArt = 'gestern' | 'heute' | 'morgen';

/** Mitternacht (lokal) des Tages `art`, von `now` aus gezählt. */
export function tagDatum(now: Date, art: TagArt): Date {
  const versatz = art === 'gestern' ? -1 : art === 'morgen' ? 1 : 0;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + versatz);
}

const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

function zweistellig(n: number): string {
  return String(n).padStart(2, '0');
}

/** „Mi 24.09." */
export function kurzDatum(d: Date): string {
  return `${WOCHENTAG[d.getDay()]} ${zweistellig(d.getDate())}.${zweistellig(d.getMonth() + 1)}.`;
}

/** Ab dieser Stunde ist „ab ca. 13 Uhr" für den fehlenden Folgetag vorbei. */
const MORGEN_PREISE_BIS_H = 14;

/**
 * Die drei Einträge des Tagesschalters, je mit Wort und Datum wie im
 * Prototyp. Gibt es für morgen noch keinen Plan, steht an Stelle des Datums
 * der Grund — wie beim Tag-Segment der Marktpreise („Morgen ab ca. 13 Uhr":
 * die Börse veröffentlicht den Folgetag gegen 12:45, der nächste Lauf plant
 * ihn). Nach 14 Uhr wäre das eine falsche Zusage; dann „noch kein Plan".
 */
export function tagesSchalter(
  now: Date,
  morgenGeplant: boolean,
): { optionen: { id: TagArt; label: string; datum: string }[]; chip: null } {
  const morgen = morgenGeplant
    ? kurzDatum(tagDatum(now, 'morgen'))
    : now.getHours() < MORGEN_PREISE_BIS_H
      ? 'ab ca. 13 Uhr'
      : 'noch kein Plan';
  return {
    optionen: [
      { id: 'gestern', label: 'Gestern', datum: kurzDatum(tagDatum(now, 'gestern')) },
      { id: 'heute', label: 'Heute', datum: kurzDatum(tagDatum(now, 'heute')) },
      { id: 'morgen', label: 'Morgen', datum: morgen },
    ],
    chip: null,
  };
}

/** Ein Tag des Schalters OHNE Tagesbild: was die Fläche statt dessen sagt. */
export interface TagOhneBild {
  titel: string;
  text: string | null;
  /** Der Abruf läuft noch. */
  laedt: boolean;
  /** Der Abruf ist gescheitert — „Erneut versuchen" hilft. */
  erneut: boolean;
  /** Der Weg zu dem, was wirklich passiert ist. */
  mitMesswerte: boolean;
}

/**
 * Der GRUND statt einer leeren Fläche, wenn der gewählte Tag kein Tagesbild
 * hat (heute entscheidet darüber der Aufbau der Seite, nicht der Schalter):
 *  - morgen, solange der jüngste Lauf den Folgetag nicht trägt — die Börse
 *    veröffentlicht ihn gegen 12:45, der nächste Lauf plant ihn;
 *  - gestern, solange der Abruf läuft, wenn er scheitert, oder wenn der Tag
 *    keinen Plan trägt, dessen Viertelstunden alle ihren Grund kennen (das
 *    Tagesbild erfände sonst Tätigkeiten).
 * Die Seite lädt den Plan nicht nach; „erscheint von selbst" wäre gelogen.
 */
export function tagOhneBild(
  art: TagArt,
  gestern: { laedt: boolean; fehler: boolean } | null,
  now: Date,
): TagOhneBild | null {
  if (art === 'heute') return null;
  if (art === 'morgen') {
    return {
      titel: 'Für morgen gibt es noch keinen Plan',
      text:
        now.getHours() < MORGEN_PREISE_BIS_H
          ? 'Die Börsenpreise für morgen kommen gegen 13 Uhr. Dann plant VoltPilot den ganzen Tag.'
          : 'Sobald die Börsenpreise für morgen vorliegen, plant VoltPilot den ganzen Tag.',
      laedt: false,
      erneut: false,
      mitMesswerte: false,
    };
  }
  if (gestern == null || gestern.laedt) {
    return { titel: 'Der Plan von gestern wird geladen …', text: null, laedt: true, erneut: false, mitMesswerte: false };
  }
  if (gestern.fehler) {
    return {
      titel: 'Der Plan von gestern ist gerade nicht abrufbar',
      text: 'Bitte versuchen Sie es gleich noch einmal.',
      laedt: false,
      erneut: true,
      mitMesswerte: false,
    };
  }
  return {
    titel: 'Für gestern ist kein vollständiger Plan gespeichert',
    text: 'Das Tagesbild zeigt nur Tage, an denen jede Viertelstunde ihren Grund kennt. Was gestern wirklich passiert ist, zeigen die Messwerte.',
    laedt: false,
    erneut: false,
    mitMesswerte: true,
  };
}

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

// ---- Kopfsatz, Moment-Band, Stationen (Aufbau des Prototyps) -----------------------

/** Die Tageszeit einer Minute, wie man sie sagt. */
function tageszeit(minute: number): string {
  if (minute < 5 * 60) return 'nachts';
  if (minute < 10 * 60) return 'morgens';
  if (minute < 14 * 60) return 'mittags';
  if (minute < 17 * 60) return 'nachmittags';
  if (minute < 22 * 60) return 'abends';
  return 'nachts';
}

/** Ein Listenwort mitten im Satz: „zum Spitzenpreis verkaufen", aber „Sonne speichern". */
function imSatz(label: string): string {
  return /^(Zum|Günstig|Einspeisen)\b/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** Ab dieser Dauer (Minuten) zählt eine Tätigkeit für den Kopfsatz. */
const KOPF_MIN_DAUER = 30;

/**
 * Der KOPFSATZ des Tages (Prototyp: die Zeile über Uhr und Bildfahrplan): was
 * der Speicher heute tut, nach Tageszeiten — aus den Phasen des Plans und mit
 * ihren Wörtern (E8). Ohne Wetter- oder Preisurteil: das stünde nirgends
 * belegt. „Warten" ist keine Tätigkeit; höchstens die drei längsten zählen,
 * in der Reihenfolge des Tages. Ohne Tätigkeit: „Heute wartet der Speicher."
 * Der Tagesschalter nennt seinen Tag: „Gestern: …", „Morgen: …".
 */
export function kopfsatz(tag: TagModell, art: TagArt = 'heute'): string | null {
  if (tag.phasen.length === 0) return null;
  const aktiv = tag.phasen.filter((p) => p.role !== 'warten');
  if (aktiv.length === 0) {
    return art === 'gestern'
      ? 'Gestern wartete der Speicher.'
      : art === 'morgen'
        ? 'Morgen wartet der Speicher.'
        : 'Heute wartet der Speicher.';
  }
  const lang = aktiv.filter((p) => p.bis - p.von >= KOPF_MIN_DAUER);
  const auswahl = (lang.length > 0 ? lang : aktiv)
    .slice()
    .sort((a, b) => b.bis - b.von - (a.bis - a.von) || a.von - b.von)
    .slice(0, 3)
    .sort((a, b) => a.von - b.von);
  // Gleiche Tätigkeit hintereinander: „mittags und nachmittags Sonne speichern";
  // gleiche Tageszeit hintereinander: „abends Verbrauch decken und … verkaufen".
  const teile: { zeiten: string[]; woerter: string[] }[] = [];
  for (const p of auswahl) {
    const zeit = tageszeit((p.von + p.bis) / 2);
    const wort = imSatz(p.label);
    const letzter = teile[teile.length - 1];
    if (letzter && letzter.woerter.length === 1 && letzter.woerter[0] === wort) {
      if (!letzter.zeiten.includes(zeit)) letzter.zeiten.push(zeit);
    } else if (letzter && letzter.zeiten.length === 1 && letzter.zeiten[0] === zeit) {
      if (!letzter.woerter.includes(wort)) letzter.woerter.push(wort);
    } else {
      teile.push({ zeiten: [zeit], woerter: [wort] });
    }
  }
  const saetze = teile.map((t) => `${t.zeiten.join(' und ')} ${t.woerter.join(' und ')}`);
  const satz = saetze.join(', ');
  return `${art === 'gestern' ? 'Gestern' : art === 'morgen' ? 'Morgen' : 'Heute'}: ${satz}.`;
}

/**
 * Die Zeile zum MOMENT am Zeiger — am Rechner das Jetzt-Band über dem Bild,
 * am Telefon die Zeile unter der Uhr. Steht der Zeiger auf jetzt, spricht das
 * GERÄT (Ausführung aus `jetztHeld`, getrennt vom Plan); sonst der Plan der
 * Viertelstunde, für Vergangenes als „war geplant".
 */
export interface MomentBand {
  /** „Jetzt · 14:10" bzw. „15:45–16:00 Uhr · geplant". */
  kopf: string;
  /** Was geschieht; null ohne Aussage. */
  was: string | null;
  role: SlotRole | null;
  /** Die Zahl dazu: die Ausführung (jetzt) bzw. der Plan; null = keine. */
  zahl: string | null;
  /** Der eine Warum-Satz; null = keiner aufgezeichnet. */
  warum: string | null;
}

export function momentBand(
  tag: TagModell,
  i: number,
  istJetzt: boolean,
  held: JetztHeldView | null,
  /** Der Satz der Waage dieser Viertelstunde (`fahrplanWaage`); null = keine Waage. */
  waageSatz: string | null,
): MomentBand | null {
  const v = tag.viertel[i];
  const s = tag.slots[i];
  if (!v || !s) return null;
  const ph = phaseVon(tag, i);
  if (istJetzt && held && tag.jetzt != null) {
    const wert = held.value
      ? `${held.value}${held.valueNote ? ` ${held.valueNote}` : ''}`
      : held.valueMissing
        ? `— ${held.valueMissing}`
        : null;
    const zahl = [wert, held.confirm ? VOM_WR_BESTAETIGT : null].filter((x): x is string => x != null).join(' · ');
    return {
      kopf: `Jetzt · ${uhrzeit(tag.jetzt)}`,
      was: held.lead || ph?.label || null,
      role: ph?.role ?? null,
      zahl: zahl || null,
      warum: held.why ?? waageSatz,
    };
  }
  const art: MomentArt = istJetzt ? 'jetzt' : v.vorbei ? 'vorbei' : 'geplant';
  const soc = zahl(s.socPct);
  const teile = [planLeistung(zahl(s.batteryKw)), soc == null ? null : `Ladestand danach ${pct(soc)}`].filter(
    (x): x is string => x != null,
  );
  return {
    kopf:
      istJetzt && tag.jetzt != null
        ? `Jetzt · ${uhrzeit(tag.jetzt)}`
        : `${uhrzeit(v.von)}–${uhrzeit(v.bis)} Uhr · ${art === 'vorbei' ? 'war geplant' : 'geplant'}`,
    was: ph ? (art === 'vorbei' ? `War geplant: ${ph.label}` : ph.label) : null,
    role: ph?.role ?? null,
    zahl: teile.length === 0 ? null : teile.join(' · '),
    warum: waageSatz,
  };
}

/** Eine STATION des Tages (Prototyp „Der Tag in Stationen"): eine Phase als Halt. */
export interface Station {
  phaseIndex: number;
  role: SlotRole;
  label: string;
  /** „05:45–07:30". */
  zeit: string;
  vorbei: boolean;
  laeuft: boolean;
  /** „21 % → 10 %" bzw. „95 %" (geplant); null ohne Ladestand. */
  ladestand: string | null;
  /** Der Satz der Phase (dieselbe Quelle wie die Phasen-Karte); beim Warten keiner. */
  grund: string | null;
}

/**
 * Die Stationen des Tages — dieselben Phasen wie Uhr und Bildfahrplan
 * (`tag.phasen`), also nie ein zweiter Schnitt. Der Ladestand ist der PLAN:
 * Anfang = Stand am Ende der Viertelstunde davor, Ende = Stand am Ende der
 * Phase; fehlt der Anfang (Mitternacht), steht nur das Ende.
 */
export function stationen(tag: TagModell, plantKind: PlanWordingKind): Station[] {
  return tag.phasen.map((p) => {
    const roh = tag.phasenRoh[p.phaseIndex];
    const anfang = roh.startIdx > 0 ? zahl(tag.slots[roh.startIdx - 1]?.socPct) : null;
    const ende = zahl(tag.slots[roh.endIdx]?.socPct);
    const ladestand =
      ende == null ? null : anfang == null || Math.abs(anfang - ende) < 1 ? pct(ende) : `${pct(anfang)} → ${pct(ende)}`;
    return {
      phaseIndex: p.phaseIndex,
      role: p.role,
      label: p.label,
      zeit: `${uhrzeit(p.von)}–${uhrzeit(p.bis)}`,
      vorbei: p.vorbei,
      laeuft: p.laeuft,
      ladestand,
      grund: p.role === 'warten' ? null : phaseWhy(roh, plantKind),
    };
  });
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
  // Ohne einen Preis, der den Plan treibt (fester Tarif), hat die Uhr keinen
  // Preisring — und die Leiste keine Preiszelle.
  const preisZelle: ZeigerWert[] = tag.preis
    ? [
        {
          ebene: 'preis',
          label: 'Preis',
          // Kurz in der Leiste („ct" je kWh); voll in Lupe und Erklär-Panel.
          wert: preis == null ? '–' : fmtNum(preis, 'ct', 1),
          herkunft: preisHer,
          satz:
            preis == null
              ? 'Preis: kein Wert'
              : `${tag.preis.art === 'boerse' ? 'Börsenpreis' : 'Strompreis'}: ${ct(preis)}`,
        },
      ]
    : [];
  return [
    {
      ebene: 'sonne',
      label: 'Sonne',
      wert: sonneWert,
      herkunft: sonneHer,
      satz: `Sonne: ${sonneWert}${sonneHer ? `, ${sonneHer}` : ''}`,
    },
    ...preisZelle,
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

/** Die Einführung dieses Tages: ohne Preisring kein Schritt, der ihn erklärt. */
export function einfuehrungFuer(tag: TagModell): readonly { ebene: TagesbildEbene | 'zeiger'; titel: string }[] {
  if (!tag.preis) return EINFUEHRUNG.filter((s) => s.ebene !== 'preis');
  return tag.preis.art === 'boerse'
    ? EINFUEHRUNG.map((s) => (s.ebene === 'preis' ? { ...s, titel: 'Börsenpreis' } : s))
    : EINFUEHRUNG;
}

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
  // Zeigt das Bild die Börse (oder gar keinen Preis), nennt die Lupe den
  // Bezugspreis trotzdem: was eine kWh aus dem Netz hier kostet, ist ein Fakt.
  const bezug = tag.preis?.art === 'bezug' ? null : zahl(s.importPriceCtKwh);
  if (bezug != null) zeilen.push({ label: 'Strom kostet', wert: ct(bezug) });
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
