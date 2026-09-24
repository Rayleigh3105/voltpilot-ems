/**
 * Das TAGESMODELL des Fahrplan-Tagesbilds (Konzept „Tagesuhr und Bildfahrplan",
 * Entscheide E1/E10 vom 24.09.2026): EINE Ableitung, aus der die Tagesuhr
 * (Telefon) und der Bildfahrplan (Rechner) zeichnen. Beide Bilder dürfen sich
 * damit nicht widersprechen — sie lesen dieselben Viertelstunden, dieselben
 * Phasen und denselben Preis.
 *
 * ⚠ **Es wird nichts neu gerechnet.** Die Phasen kommen aus `fahrplanWhy.phases`
 * (dieselbe Glättung wie Film und Erklär-Panel), die Wörter aus
 * `fahrplanFilm.filmLabel` (der eine Wortschatz, E8). Dieses Modul schneidet
 * die Viertelstunden EINES Kalendertags heraus und legt sie auf die Uhrzeit.
 *
 * ⚠ **Ohne Warum-Ebene gibt es kein Tagesbild.** `phases()` ist per
 * Konstruktion alles-oder-nichts; eine leere Phasenliste heißt, dass nicht jede
 * Viertelstunde eine bekannte Rolle trägt. Dann ist `hatWarum` false und die
 * Seite fällt auf das bisherige Diagramm zurück — ein Tagesbild ohne Rollen
 * müsste Tätigkeiten erfinden.
 *
 * Zeit: lokale Uhrzeit, wie jede Zeitangabe des Fahrplans (`toLocaleTimeString`
 * im Film und im Panel). An den zwei Umstellungstagen hat ein Tag 92 bzw. 100
 * Viertelstunden; die Uhr legt sie nach Wanduhrzeit ab, im Herbst liegen die
 * doppelten Viertelstunden 02:00–03:00 also übereinander. Das ist ehrlicher als
 * eine 25-Stunden-Uhr, die es in keiner Küche gibt.
 *
 * Rein: kein React, kein Netz.
 */

import { filmLabel } from './fahrplanFilm';
import { phases, type PhaseKind, type PlanPhase, type SlotRole, type WhySlot } from './fahrplanWhy';
import type { PlanWordingKind } from './schedule';

/** Minuten eines Tages. */
export const TAG_MINUTEN = 24 * 60;

/**
 * Was das Tagesbild je Viertelstunde liest: die Warum-Felder plus Prognose und
 * Messung von Verbrauch und Sonne (Teilmenge von `api.ScheduleSlot`).
 */
export type TagSlot = WhySlot & {
  loadKw?: number | null;
  measuredLoadKw?: number | null;
  measuredPvKw?: number | null;
};

/** Eine Viertelstunde des Tages, auf die Uhrzeit gelegt. */
export interface TagViertel {
  /** Index in {@link TagModell.slots} — dieselbe Liste wie die Phasen. */
  i: number;
  /** Beginn in Minuten seit Mitternacht (lokale Zeit). */
  von: number;
  /** Ende in Minuten seit Mitternacht; 1440 = Mitternacht am Tagesende. */
  bis: number;
  /** Schon vorbei (endete vor jetzt). */
  vorbei: boolean;
  /** Läuft gerade. */
  laeuft: boolean;
}

/** Eine Phase des Tages, auf die Uhrzeit gelegt. */
export interface TagPhase {
  /** Index in {@link TagModell.phasenRoh} (für das Erklär-Panel). */
  phaseIndex: number;
  role: SlotRole;
  kind: PhaseKind;
  /** Das Listenwort der Phase (E8) — die Identität, die nie an der Farbe hängt. */
  label: string;
  von: number;
  bis: number;
  vorbei: boolean;
  laeuft: boolean;
}

/**
 * Der Preis je Viertelstunde, den das Bild zeigt. `bezug` ist der Preis, mit
 * dem der Optimierer entschieden hat (P0-Preiswahrheit); nur wenn ihn nicht
 * jede Viertelstunde trägt, zeigt das Bild den Börsenpreis — und nennt ihn
 * dann auch so, statt ihn als „Netzstrom" auszugeben.
 */
export interface TagPreis {
  art: 'bezug' | 'boerse';
  /** ct/kWh je Viertelstunde; null = kein Preis (eine Lücke, nie eine 0). */
  ct: (number | null)[];
  min: number;
  max: number;
  /** Index der günstigsten bzw. teuersten Viertelstunde. */
  iMin: number;
  iMax: number;
}

export interface TagModell {
  /** Lokale Mitternacht des gezeigten Tages. */
  datum: Date;
  /** Die Viertelstunden dieses Tages (Teilliste der Eingabe, gleiche Objekte). */
  slots: TagSlot[];
  /** Die Phasen über {@link slots} — für Erklär-Panel und Film. */
  phasenRoh: PlanPhase[];
  viertel: TagViertel[];
  phasen: TagPhase[];
  /** Jetzt in Minuten seit Mitternacht; null, wenn der Tag nicht heute ist. */
  jetzt: number | null;
  /** Index der laufenden Viertelstunde in {@link slots}; -1 = keine. */
  jetztIndex: number;
  preis: TagPreis | null;
  /** Trägt jede Viertelstunde eine bekannte Rolle? Sonst kein Tagesbild. */
  hatWarum: boolean;
}

export interface TagEingabe {
  /** Die Viertelstunden, aus denen der Tag geschnitten wird (Splice oder Lauf). */
  slots: TagSlot[];
  slotMinutes: number;
  now: Date;
  plantKind: PlanWordingKind;
  /** Der Tag, der gezeigt wird; ohne Angabe der Kalendertag von `now`. */
  tag?: Date;
}

/** Lokale Mitternacht eines Zeitpunkts. */
export function mitternacht(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Minuten seit lokaler Mitternacht (Wanduhrzeit). */
export function minuteDesTages(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function gleicherTag(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function zahl(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

/** Der Preis des Bildes — siehe {@link TagPreis}. */
function tagPreis(slots: WhySlot[]): TagPreis | null {
  if (slots.length === 0) return null;
  const bezug = slots.map((s) => zahl(s.importPriceCtKwh));
  const art: 'bezug' | 'boerse' = bezug.every((v) => v != null) ? 'bezug' : 'boerse';
  const ct =
    art === 'bezug'
      ? bezug
      : slots.map((s) => {
          const p = zahl(s.priceEurMwh);
          return p == null ? null : p / 10;
        });
  let iMin = -1;
  let iMax = -1;
  ct.forEach((v, i) => {
    if (v == null) return;
    if (iMin < 0 || v < (ct[iMin] as number)) iMin = i;
    if (iMax < 0 || v > (ct[iMax] as number)) iMax = i;
  });
  if (iMin < 0) return null;
  return { art, ct, min: ct[iMin] as number, max: ct[iMax] as number, iMin, iMax };
}

/**
 * Schneidet den Tag aus den Viertelstunden und legt ihn auf die Uhrzeit.
 * Gibt es für den Tag keine Viertelstunde, ist das Modell leer (`slots: []`).
 */
export function tagModell(input: TagEingabe): TagModell {
  const tag = mitternacht(input.tag ?? input.now);
  const slotMs = input.slotMinutes * 60_000;
  const slots = input.slots.filter((s) => gleicherTag(new Date(s.start), tag));
  const t = input.now.getTime();
  const heute = gleicherTag(input.now, tag);

  const viertel: TagViertel[] = slots.map((s, i) => {
    const start = new Date(s.start);
    const von = minuteDesTages(start);
    const ende = start.getTime() + slotMs;
    return {
      i,
      von,
      bis: Math.min(TAG_MINUTEN, von + input.slotMinutes),
      vorbei: ende <= t,
      laeuft: start.getTime() <= t && t < ende,
    };
  });

  const phasenRoh = phases(slots, input.slotMinutes);
  const phasen: TagPhase[] = phasenRoh.map((p, phaseIndex) => {
    const von = viertel[p.startIdx].von;
    const bis = viertel[p.endIdx].bis;
    const vorbei = viertel[p.endIdx].vorbei;
    const laeuft = viertel.slice(p.startIdx, p.endIdx + 1).some((v) => v.laeuft);
    return {
      phaseIndex,
      role: p.role,
      kind: p.kind,
      label: filmLabel(p.role, input.plantKind, slots[p.startIdx]?.slotFlags),
      von,
      bis,
      vorbei,
      laeuft,
    };
  });

  const jetztIndex = viertel.findIndex((v) => v.laeuft);
  return {
    datum: tag,
    slots,
    phasenRoh,
    viertel,
    phasen,
    jetzt: heute ? minuteDesTages(input.now) : null,
    jetztIndex,
    preis: tagPreis(slots),
    hatWarum: phasenRoh.length > 0,
  };
}

/** Die Viertelstunde, in der eine Uhrzeit liegt; -1 = keine. */
export function viertelBei(tag: TagModell, minute: number): number {
  const v = tag.viertel.find((q) => minute >= q.von && minute < q.bis);
  return v ? v.i : -1;
}

/** Die Phase, zu der eine Viertelstunde gehört; null = keine. */
export function phaseVon(tag: TagModell, i: number): TagPhase | null {
  return (
    tag.phasen.find((p) => {
      const roh = tag.phasenRoh[p.phaseIndex];
      return i >= roh.startIdx && i <= roh.endIdx;
    }) ?? null
  );
}

/**
 * Der GEPLANTE Ladestand an den Viertelstunden-Grenzen: Wert i ist der Stand am
 * Ende der Viertelstunde i (`socPct` des Plans). Ohne Wert eine Lücke (null),
 * nie eine erfundene Zahl.
 */
export function ladestandPlan(tag: TagModell): (number | null)[] {
  return tag.slots.map((s) => zahl(s.socPct));
}

/** „14:15" einer Minute des Tages; 1440 wird „24:00". */
export function uhrzeit(minute: number): string {
  const m = Math.round(minute);
  if (m >= TAG_MINUTEN) return '24:00';
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
