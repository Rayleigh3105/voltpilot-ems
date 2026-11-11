/**
 * Eine **Erzeugungseinheit als Gerät** (Konzept „Ein Gerät, ein Eintrag“, GE-3, Variante d1): ihre Adresse und ihr
 * Zustand aus den jüngsten Werten der Steuerung — der leichte Teil, den Aufbau, Steuerung › Geräte und die Seite der
 * Steuerung brauchen. Die Seite der Einheit selbst (Jetzt, Heute, Aktivität) steht in `einheitSeite.ts`.
 *
 * Rein: kein React, kein Netz. Fehlend ist keine Null — ohne Gültigkeitsbit „—“, ohne Lesung „noch keine Daten“.
 */
import type { AnlagensteuerungListe, AnlagensteuerungWerte, Anlagensteuerung, Erzeugungseinheit, ErzeugungseinheitArt } from './api';
import {
  bitVon,
  EINHEIT_ART_WORT,
  einheitArt,
  einheitName,
  einheitNenn,
  einheitPunkt,
  einheitTyp,
  einheitZustand,
  juengsteLesung,
  NOCH_KEINE_DATEN,
  werteJe,
  wertVon,
  type EinheitFeld,
} from './anlagensteuerung';
import { fmtRelative, NBSP } from './format';
import { einheitGeraetId } from './geraetAdresse';
import type { GeraetTon } from './geraetSeite';
import { geraetSeiteHash } from './nav';

const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** Wie die Seite der Steuerung (EZ-22) und `werte`: eine Lesung ist höchstens 120 s lang aktuell. */
const AKTUELL_MS = 120_000;

/** Die Art-Spalte im Aufbau: „PV-Wechselrichter · über die Steuerung“ — gefiltert wird nach dem Teil vor dem Punkt. */
export const UEBER_DIE_STEUERUNG = 'über die Steuerung';

// ---------------------------------------------------------------------------
// Adresse
// ---------------------------------------------------------------------------

/** Die Seite einer Einheit; null ohne Box-Referenz (nie ein Weg ins Leere). */
export function einheitHref(siteId: string, ref: string | null | undefined, entityId: string, teNr: number): string | null {
  return ref ? geraetSeiteHash(siteId, ref, einheitGeraetId(entityId, teNr)) : null;
}

/** Die Steuerung und ihre Einheit zu einer Adresse — null, wenn die Steuerung oder die Nummer nicht (mehr) da ist. */
export function findeEinheit(
  liste: AnlagensteuerungListe | null | undefined,
  entityId: string,
  teNr: number,
): { steuerung: Anlagensteuerung; einheit: Erzeugungseinheit } | null {
  const steuerung = liste?.steuerungen.find((s) => s.entity_id === entityId);
  const einheit = steuerung?.einheiten.find((e) => e.te_nr === teNr);
  return steuerung && einheit ? { steuerung, einheit } : null;
}

// ---------------------------------------------------------------------------
// Zustand einer Einheit (Aufbau-Zeile und Kopf der Seite)
// ---------------------------------------------------------------------------

export interface EinheitStand {
  teNr: number;
  /** Die Bezeichnung, sonst „Wechselrichter 2“ — dieselbe wie überall (`einheitName`). */
  name: string;
  art: ErzeugungseinheitArt | null;
  /** „PV-Wechselrichter“, „BHKW-Motor“, ohne Art „Erzeugungseinheit“. */
  artWort: string;
  symbol: 'sun' | 'flame';
  typ: string | null;
  nenn: { kw: number; ausBild: boolean } | null;
  /** Typ und Nennleistung: „Growatt MAX 125KTL3-X · 125 kW“; ohne beides die Art. */
  unter: string;
  /** Ist und Soll in W, nur mit ihrem Gültigkeitsbit; `null` = unbekannt, nie 0. */
  istW: number | null;
  sollW: number | null;
  /** Der Zustand aus `t_zustand` („läuft begrenzt“), nur mit Bit 0; null = keiner gelesen. */
  zustand: string | null;
  ton: GeraetTon;
  zustandWort: string;
  /** Der Zeitbezug zum Zustand („vor 12 Sek.“, „zuletzt vor 3 Min.“); null = keiner. */
  zustandZeit: string | null;
  /** Die jüngste Lesung eines Felds dieser Einheit (ISO); null = keine. */
  gelesenAm: string | null;
  ohneDaten: boolean;
}

/** Die Felder, die den Zustand einer Einheit tragen. */
const ZUSTANDS_FELDER: readonly EinheitFeld[] = ['t_zustand', 't_bits', 't_p_ist_w', 't_p_soll_w', 't_e'];

/** `t_zustand` 4 Störung, 5 Hand/Wartung, 6 Not-Aus brauchen Aufmerksamkeit; aus, bereit und läuft nicht. */
const ACHTUNG = new Set([4, 5, 6]);

export function nennText(nenn: { kw: number; ausBild: boolean } | null): string | null {
  return nenn ? `${NF0.format(nenn.kw)}${NBSP}kW` : null;
}

/**
 * Der Zustand einer Einheit aus den jüngsten Werten ihrer Steuerung. Ohne Antwort „unbekannt“, ohne jede Lesung
 * „noch keine Daten“; ist die jüngste Lesung älter als 120 s, „meldet sich gerade nicht“; ohne Bit 0 „Werte
 * ungültig“. Eine Einheit, die nachts „aus“ oder „bereit“ ist, ist in Ordnung — sie braucht keine Aufmerksamkeit.
 */
export function einheitStand(e: Erzeugungseinheit, werte: AnlagensteuerungWerte | null | undefined, now: Date): EinheitStand {
  const je = werteJe(werte);
  const art = einheitArt(e, je);
  const nenn = einheitNenn(e, je);
  const typ = einheitTyp(e);
  const artWort = art ? EINHEIT_ART_WORT[art] : 'Erzeugungseinheit';
  const bits = einheitPunkt(e.te_nr, 't_bits');
  const gueltig = bitVon(je, bits, 0);
  const keys = ZUSTANDS_FELDER.map((f) => einheitPunkt(e.te_nr, f));
  const ohneDaten = keys.every((k) => (je.get(k)?.zustand ?? 'keine_daten') === 'keine_daten');
  const gelesenAm = werte && !ohneDaten ? juengsteLesung(je, keys) : null;
  const zustand = einheitZustand(je, e.te_nr);
  const zustandRoh = gueltig === false ? null : wertVon(je, einheitPunkt(e.te_nr, 't_zustand'));
  return {
    teNr: e.te_nr,
    name: einheitName(e, je),
    art,
    artWort,
    symbol: art === 'bhkw_motor' ? 'flame' : 'sun',
    typ,
    nenn,
    unter: [typ, nennText(nenn)].filter(Boolean).join(' · ') || artWort,
    istW: gueltig === false ? null : wertVon(je, einheitPunkt(e.te_nr, 't_p_ist_w')),
    sollW: bitVon(je, bits, 1) === false ? null : wertVon(je, einheitPunkt(e.te_nr, 't_p_soll_w')),
    zustand,
    ...lage(Boolean(werte), gelesenAm, gueltig, zustand, zustandRoh, now),
    gelesenAm,
    ohneDaten,
  };
}

function lage(
  geladen: boolean,
  gelesenAm: string | null,
  gueltig: boolean | null,
  zustand: string | null,
  zustandRoh: number | null,
  now: Date,
): Pick<EinheitStand, 'ton' | 'zustandWort' | 'zustandZeit'> {
  if (!geladen) return { ton: 'off', zustandWort: 'unbekannt', zustandZeit: null };
  if (!gelesenAm) return { ton: 'off', zustandWort: NOCH_KEINE_DATEN, zustandZeit: null };
  const rel = fmtRelative(gelesenAm, now);
  if (Date.parse(gelesenAm) < now.getTime() - AKTUELL_MS) {
    return { ton: 'warn', zustandWort: 'meldet sich gerade nicht', zustandZeit: `zuletzt ${rel}` };
  }
  if (gueltig === false) return { ton: 'warn', zustandWort: 'Werte ungültig', zustandZeit: rel };
  if (zustand == null) return { ton: 'ok', zustandWort: 'liefert Daten', zustandZeit: rel };
  return { ton: zustandRoh != null && ACHTUNG.has(zustandRoh) ? 'warn' : 'ok', zustandWort: zustand, zustandZeit: rel };
}

