/**
 * Die WÖRTER UND WERTE des Fahrplan-Tagesbilds: der Kopfsatz des Tages, die
 * Jetzt-Zeile, die Stationen („Ihr Tag"), die Lupe des Tagesbands und der
 * Tagesschalter (Überblick 20.10.2026; davor Konzept „Tagesuhr und
 * Bildfahrplan").
 *
 * Jede Zahl ist ein Feld des Plans oder eine Messung, die die Viertelstunde
 * trägt; es wird nichts neu gerechnet. Drei Ehrlichkeitsregeln:
 *  - Vergangene Viertelstunden zeigen den Plan, der für sie GALT („war
 *    geplant") - oder, wo die Ist-Spur sie trägt, den gemessenen Ladestand.
 *  - Sonne und Verbrauch sind gemessen, wo die Viertelstunde eine Messung
 *    trägt, sonst erwartet — und sagen das.
 *  - Fehlt ein Wert, steht „–", nie eine 0.
 *
 * Rein: kein React, kein Netz.
 */

import type { IconName } from '../designsystem/components/core/Icon';
import { VOM_WR_BESTAETIGT } from './control';
import { energieFluss, type FlussStrom } from './fahrplanTagesband';
import { IST_BEWEGUNG_PCT, istVerlauf } from './fahrplanIst';
import { ZUSTAND_KURZ, actionPhrase, type JetztHeldView, type JetztTone } from './fahrplanJetzt';
import { TAG_MINUTEN, phaseVon, uhrzeit, type TagModell, type TagPhase } from './fahrplanTag';
import { phaseWhy, type SlotRole } from './fahrplanWhy';
import { fmtNum } from './format';
import type { PlanWordingKind } from './schedule';

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

/** Ab dieser Inhaltsbreite zeigt die Seite das Tagesband statt der Uhr. */
export const BILD_AB_PX = 900;
/** Ab dieser Breite stehen Uhr und Antworten nebeneinander. */
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

/** Was die Viertelstunde am Zeiger ist: jetzt, noch geplant oder vorbei. */
export type MomentArt = 'jetzt' | 'geplant' | 'vorbei';

/** Die Leistung des Plans in Worten („laden mit 2,2 kW"). */
function planLeistung(batteryKw: number | null): string | null {
  if (batteryKw == null) return null;
  if (batteryKw > RUHE_KW) return `laden mit ${fmtNum(batteryKw, 'kW')}`;
  if (batteryKw < -RUHE_KW) return `abgeben mit ${fmtNum(-batteryKw, 'kW')}`;
  return 'kein Laden, kein Abgeben';
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
 * Wie viel eine Phase BEWEGT (kWh): die geplante Speicher- und Abregel-Leistung
 * über ihre Viertelstunden. Sie entscheidet, was den Tag erzählt - nicht die
 * Dauer: acht Stunden „Verbrauch decken" mit 0,4 kW sind weniger Tag als
 * anderthalb Stunden „Sonne speichern" mit 4 kW.
 */
function phasenEnergie(tag: TagModell, p: TagPhase): number {
  const roh = tag.phasenRoh[p.phaseIndex];
  let kwh = 0;
  for (let i = roh.startIdx; i <= roh.endIdx; i++) {
    const s = tag.slots[i];
    const v = tag.viertel[i];
    if (!s || !v) continue;
    const kw = Math.abs(zahl(s.batteryKw) ?? 0) + Math.max(0, zahl(s.curtailKw) ?? 0);
    kwh += (kw * (v.bis - v.von)) / 60;
  }
  return kwh;
}

/**
 * Der KOPFSATZ des Tages: was der Speicher heute tut, nach Tageszeiten - aus
 * den Phasen des Plans und mit ihren Wörtern (E8). Ohne Wetter- oder
 * Preisurteil: das stünde nirgends belegt. „Warten" ist keine Tätigkeit.
 *
 * Es zählen die Tätigkeiten, die am meisten Energie bewegen, höchstens drei,
 * und JEDES WORT NUR EINMAL (sein stärkster Auftritt): der Satz „nachts
 * Verbrauch decken, abends einspeisen, nachts Verbrauch decken" nannte eine
 * Tätigkeit zweimal und ließ dafür das Sonne-Speichern des Mittags weg (Demo,
 * 20.10.2026). Gesprochen wird in der Reihenfolge des Tages. Ohne Tätigkeit:
 * „Heute wartet der Speicher." Der Tagesschalter nennt seinen Tag.
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
  const gewicht = new Map((lang.length > 0 ? lang : aktiv).map((p) => [p, phasenEnergie(tag, p)]));
  const staerkste = new Map<string, TagPhase>();
  for (const [p, kwh] of gewicht) {
    const bisher = staerkste.get(p.label);
    const vorher = bisher ? (gewicht.get(bisher) ?? 0) : -1;
    // Gleich viel Energie (ein Plan ohne Leistungswerte): die längere zählt.
    const besser = kwh > vorher + 1e-9 || (bisher != null && Math.abs(kwh - vorher) <= 1e-9 && p.bis - p.von > bisher.bis - bisher.von);
    if (!bisher || besser) staerkste.set(p.label, p);
  }
  const auswahl = [...staerkste.values()]
    .sort((a, b) => (gewicht.get(b) ?? 0) - (gewicht.get(a) ?? 0) || b.bis - b.von - (a.bis - a.von) || a.von - b.von)
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

/**
 * Die JETZT-ZEILE (Überblick 20.10.2026: „in fünf Sekunden verstehen, was
 * abgeht"): wer was tut, in einem Satz („Speicher wartet"), darunter höchstens
 * drei Stichworte („98 % · voll · ab 17:15 Verbrauch decken") - statt drei
 * Sätzen an drei Stellen.
 *
 *  - `titel` nimmt das Verb der AUSFÜHRUNG, wenn das Gerät sie bestätigt
 *    (`JetztHeldView.lead`, dieselbe Ableitung wie die Cockpit-Karte), sonst
 *    das des Plans - und `geplant` sagt es. Es gibt keine zweite Formulierung.
 *  - Die Stichworte kommen nur aus Fakten: dem Ladestand (gemessen, wenn die
 *    Messung frisch ist), einer bindenden Grenze der Viertelstunde (voll, am
 *    Minimum, Reserve) bzw. der Leistung, und dem nächsten Wechsel des Plans.
 *  - `zustand` steht nur, wenn das Gerät NICHT dem Plan folgt
 *    ({@link ZUSTAND_KURZ}, der volle Satz als `lang`) oder bewusst nachführt
 *    (dann mit dem Plan-Wert): ein ruhiges Gerät braucht keine Zeile.
 */
export interface JetztZeile {
  /** „Jetzt · 13:57" bzw. „15:00–15:15 Uhr · geplant". */
  kopf: string;
  role: SlotRole | null;
  titel: string | null;
  geplant: boolean;
  unterzeile: string | null;
  zustand: { ton: JetztTone; kurz: string; lang: string } | null;
}

/** Bindende Grenzen der Viertelstunde als ein Wort hinter dem Ladestand. */
const BINDUNG_KURZ: Readonly<Record<string, string>> = {
  soc_max: 'voll',
  soc_floor: 'am Minimum',
  reserve_backup: 'Notstrom-Reserve',
  reserve_peak: 'Reserve für Lastspitzen',
};

export function jetztZeile(
  tag: TagModell,
  i: number,
  istJetzt: boolean,
  held: JetztHeldView | null,
  plantKind: PlanWordingKind,
  /** Der GEMESSENE Ladestand jetzt (frische Telemetrie); null = keiner. */
  ladestandJetzt: number | null = null,
): JetztZeile | null {
  const v = tag.viertel[i];
  const s = tag.slots[i];
  if (!v || !s) return null;
  const ph = phaseVon(tag, i);
  const role = ph?.role ?? null;
  const mitGeraet = istJetzt && held != null && tag.jetzt != null;
  const ausgefuehrt = mitGeraet && held.value != null && held.lead.startsWith(BATTERIE);
  const phrase = ausgefuehrt ? held.lead.slice(BATTERIE.length) : role ? actionPhrase(role, null, plantKind) : null;
  // Abregeln drosselt die Anlage, nicht den Speicher.
  const subjekt = role === 'abregeln' ? 'Anlage' : 'Speicher';

  const teile: string[] = [];
  const socPlan = zahl(s.socPct);
  if (mitGeraet && ladestandJetzt != null) teile.push(pct(ladestandJetzt));
  else if (socPlan != null) teile.push(mitGeraet ? `${pct(socPlan)} geplant` : pct(socPlan));
  const bindung = (s.slotFlags ?? []).map((f) => BINDUNG_KURZ[f]).find((x): x is string => x != null);
  const kw = zahl(s.batteryKw);
  if (bindung) teile.push(bindung);
  else if (ausgefuehrt && held.value) teile.push(held.value);
  // Wartend hat der Speicher keine Leistung zu nennen - „0,0 kW" wäre Rauschen.
  else if (role !== 'warten' && kw != null && Math.abs(kw) > RUHE_KW) teile.push(fmtNum(Math.abs(kw), 'kW'));
  if (ph) {
    const k = tag.phasen.indexOf(ph);
    const naechste = tag.phasen[k + 1];
    teile.push(
      naechste
        ? `ab ${uhrzeit(naechste.von)} ${naechste.label}`
        : ph.bis >= TAG_MINUTEN
          ? 'bis Mitternacht'
          : `bis ${uhrzeit(ph.bis)}`,
    );
  }

  // Eine bewusste Nachführung ist kein Fehler - aber der Plan-Wert bleibt
  // sichtbar (Regel aus 047): dann steht die Gerätezeile auch bei „ok".
  const nachfuehrung = mitGeraet && held.adjust != null && held.tone === 'ok';
  const kurz = mitGeraet
    ? nachfuehrung
      ? `Gerät führt nach${kw != null && Math.abs(kw) > RUHE_KW ? ` · Plan ${fmtNum(Math.abs(kw), 'kW')}` : ''}`
      : ZUSTAND_KURZ[held.state]
    : null;
  return {
    kopf:
      istJetzt && tag.jetzt != null
        ? `Jetzt · ${uhrzeit(tag.jetzt)}`
        : `${uhrzeit(v.von)}–${uhrzeit(v.bis)} Uhr · ${v.vorbei ? 'war geplant' : 'geplant'}`,
    role,
    // „Speicher speichert Solarstrom" sagte dasselbe zweimal: im Titel lädt er.
    titel: phrase ? `${subjekt} ${phrase.replace(/\s*\bgerade\b/, '').replace(/^speichert Solarstrom/, 'lädt Solarstrom')}` : null,
    geplant: !ausgefuehrt,
    unterzeile: teile.length > 0 ? teile.join(' · ') : null,
    zustand:
      mitGeraet && kurz && (held.tone !== 'ok' || nachfuehrung)
        ? {
            ton: held.tone,
            kurz,
            lang: [held.adjust, held.status, held.valueMissing].filter((x): x is string => !!x).join(' '),
          }
        : null,
  };
}

/** So beginnt `JetztHeldView.lead`, wenn das Gerät die Ausführung bestätigt. */
const BATTERIE = 'Ihre Batterie ';

/** Eine STATION des Tages (Prototyp „Der Tag in Stationen"): eine Phase als Halt. */
export interface Station {
  phaseIndex: number;
  role: SlotRole;
  label: string;
  /** „05:45–07:30". */
  zeit: string;
  vorbei: boolean;
  laeuft: boolean;
  /** „21 % → 10 %" bzw. „95 %"; null ohne Ladestand. */
  ladestand: string | null;
  /** true = `ladestand` ist GEMESSEN (Ist-Spur), sonst der Plan. */
  gemessen: boolean;
  /**
   * Der Speicher tat GEMESSEN das Gegenteil des Plans („tatsächlich geladen");
   * null, wo Plan und Messung zusammenpassen oder keine Messung da ist.
   */
  abweichung: string | null;
  /** Der Satz der Phase (dieselbe Quelle wie die Phasen-Karte); beim Warten keiner. */
  grund: string | null;
}

/** Rollen, deren Plan den Speicher ruhen lässt, laden bzw. entladen will. */
const RUHT = new Set<SlotRole>(['warten', 'reserve_halten', 'abregeln']);
const LAEDT = new Set<SlotRole>(['pv_speichern', 'guenstig_laden']);
const ENTLAEDT = new Set<SlotRole>(['eigenverbrauch', 'verkaufen', 'spitze_kappen']);

function ladestandSpanne(anfang: number | null, ende: number | null): string | null {
  if (ende == null) return null;
  return anfang == null || Math.abs(anfang - ende) < 1 ? pct(ende) : `${pct(anfang)} → ${pct(ende)}`;
}

/**
 * Die Stationen des Tages - dieselben Phasen wie Uhr und Bild (`tag.phasen`),
 * also nie ein zweiter Schnitt. Der Ladestand ist der PLAN: Anfang = Stand am
 * Ende der Viertelstunde davor, Ende = Stand am Ende der Phase; fehlt der
 * Anfang (Mitternacht), steht nur das Ende.
 *
 * Mit der IST-SPUR (`ist`, `fahrplanIst.istLadestand`) zeigt eine VERGANGENE
 * Phase den gemessenen Ladestand - und sagt es, wenn der Speicher das
 * Gegenteil des Plans tat (der Plan wartete, gemessen lud er um mehr als
 * {@link IST_BEWEGUNG_PCT} Punkte). Ohne Messung bleibt es beim Plan.
 */
export function stationen(
  tag: TagModell,
  plantKind: PlanWordingKind,
  ist: readonly (number | null)[] | null = null,
  sonne = false,
): Station[] {
  return tag.phasen.map((p) => {
    const roh = tag.phasenRoh[p.phaseIndex];
    const anfang = roh.startIdx > 0 ? zahl(tag.slots[roh.startIdx - 1]?.socPct) : null;
    const ende = zahl(tag.slots[roh.endIdx]?.socPct);
    // Vergangen: die ganze Phase gemessen; laufend: gemessen bis jetzt.
    const bisIdx = p.laeuft && tag.jetztIndex >= roh.startIdx ? tag.jetztIndex : roh.endIdx;
    const gemessen = (p.vorbei || p.laeuft) && ist ? istVerlauf(ist, roh.startIdx, bisIdx) : null;
    let abweichung: string | null = null;
    if (gemessen) {
      const d = gemessen.bis - gemessen.von;
      const geladen = d >= IST_BEWEGUNG_PCT;
      const entladen = d <= -IST_BEWEGUNG_PCT;
      if (geladen && (RUHT.has(p.role) || ENTLAEDT.has(p.role))) abweichung = 'tatsächlich geladen';
      else if (entladen && (RUHT.has(p.role) || LAEDT.has(p.role))) abweichung = 'tatsächlich entladen';
    }
    return {
      phaseIndex: p.phaseIndex,
      role: p.role,
      label: p.label,
      zeit: `${uhrzeit(p.von)}–${uhrzeit(p.bis)}`,
      vorbei: p.vorbei,
      laeuft: p.laeuft,
      ladestand: gemessen ? ladestandSpanne(gemessen.von, gemessen.bis) : ladestandSpanne(anfang, ende),
      gemessen: gemessen != null,
      abweichung,
      grund:
        p.role === 'warten'
          ? sonne
            ? stationWartenGrund(tag.slots[roh.startIdx]?.slotFlags ?? [])
            : null
          : phaseWhy(roh, plantKind, undefined, undefined, sonne),
    };
  });
}

/**
 * Der kurze Warten-Grund der Sonnen-Erzählung (§4.5 „Ihr Tag"): „voll genug –
 * Sonne geht ins Netz" oder „leer – Haus nimmt Netzstrom"; sonst kein Grund
 * (die Station bleibt stumm, wie bisher).
 */
function stationWartenGrund(flags: readonly string[]): string | null {
  if (flags.includes('soc_max')) return 'voll genug – Sonne geht ins Netz';
  if (flags.includes('soc_floor')) return 'leer – Haus nimmt Netzstrom';
  return null;
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

/** Die Lupe des Tagesbands: eine Viertelstunde im Detail. */
export interface LupeView {
  zeit: string;
  art: MomentArt;
  was: string | null;
  role: SlotRole | null;
  /** Der GEPLANTE Energiefluss; null ohne Verbrauch oder Speicherwert. */
  fluss: FlussStrom[] | null;
  zeilen: { label: string; wert: string }[];
}

/** Die kW eines Flusses zwischen zwei Knoten; 0 ohne ihn (nie eine Lücke). */
function flussKw(fluss: FlussStrom[] | null, von: FlussStrom['von'], nach: FlussStrom['nach']): number {
  return fluss?.find((f) => f.von === von && f.nach === nach)?.kw ?? 0;
}

/**
 * „5,7 kW → Haus 0,4 · Speicher 0 · Netz 5,3" (§4.6: die Lupe zeigt den Fluss
 * statt der drei Preiszeilen) - reiner Fluss aus `energieFluss`, keine zweite
 * Rechnung.
 */
function sonneFlussZeile(fluss: FlussStrom[] | null, pvKw: number | null): string | null {
  if (pvKw == null) return null;
  const haus = flussKw(fluss, 'sonne', 'haus');
  const speicher = flussKw(fluss, 'sonne', 'speicher');
  const netz = flussKw(fluss, 'sonne', 'netz');
  return `${fmtNum(pvKw, 'kW')} → Haus ${fmtNum(haus, 'kW')} · Speicher ${fmtNum(speicher, 'kW')} · Netz ${fmtNum(netz, 'kW')}`;
}

/**
 * `sonne` (§4.6, Vorgabe `false` lässt jeden bestehenden Aufrufer
 * unverändert): statt der drei Preiszeilen (Strom kostet/Einspeisewert/Wert
 * gespeicherter Energie) steht hier der Sonnenfluss dieser Viertelstunde.
 */
export function lupe(tag: TagModell, i: number, sonne = false): LupeView | null {
  const v = tag.viertel[i];
  const s = tag.slots[i];
  if (!v || !s) return null;
  const art: MomentArt = v.laeuft ? 'jetzt' : v.vorbei ? 'vorbei' : 'geplant';
  const ph = phaseVon(tag, i);
  const gewesen = v.vorbei || v.laeuft;
  const zeilen: { label: string; wert: string }[] = [];
  const preis = tag.preis?.ct[i] ?? null;
  if (preis != null) zeilen.push({ label: tag.preis?.art === 'boerse' ? 'Börsenpreis' : 'Strompreis', wert: ct(preis) });
  const pvF = zahl(s.pvKw);
  const ldF = zahl(s.loadKw);
  const fluss = energieFluss({
    pvKw: pvF,
    loadKw: ldF,
    batteryKw: zahl(s.batteryKw),
    curtailKw: zahl(s.curtailKw),
  });
  if (sonne) {
    const sonnenZeile = sonneFlussZeile(fluss, pvF);
    if (sonnenZeile != null) zeilen.push({ label: 'Sonne', wert: sonnenZeile });
  } else {
    // Zeigt das Bild die Börse (oder gar keinen Preis), nennt die Lupe den
    // Bezugspreis trotzdem: was eine kWh aus dem Netz hier kostet, ist ein Fakt.
    const bezug = tag.preis?.art === 'bezug' ? null : zahl(s.importPriceCtKwh);
    if (bezug != null) zeilen.push({ label: 'Strom kostet', wert: ct(bezug) });
    const einspeisung = zahl(s.exportValueCtKwh);
    if (einspeisung != null) zeilen.push({ label: 'Einspeisewert', wert: ct(einspeisung) });
    const lambda = zahl(s.storedValueCtKwh);
    if (lambda != null) zeilen.push({ label: 'Wert gespeicherter Energie', wert: ct(lambda) });
  }
  const pvM = gewesen ? zahl(s.measuredPvKw) : null;
  if (pvM != null) zeilen.push({ label: 'Sonne gemessen', wert: fmtNum(pvM, 'kW') });
  else if (pvF != null) zeilen.push({ label: 'Sonne erwartet', wert: fmtNum(pvF, 'kW') });
  const ldM = gewesen ? zahl(s.measuredLoadKw) : null;
  if (ldM != null) zeilen.push({ label: 'Verbrauch gemessen', wert: fmtNum(ldM, 'kW') });
  else if (ldF != null) zeilen.push({ label: 'Verbrauch erwartet', wert: fmtNum(ldF, 'kW') });
  const soc = zahl(s.socPct);
  if (soc != null) zeilen.push({ label: 'Ladestand danach', wert: pct(soc) });
  return {
    zeit: `${uhrzeit(v.von)}–${uhrzeit(v.bis)} Uhr`,
    art,
    was: ph?.label ?? null,
    role: ph?.role ?? null,
    fluss,
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
