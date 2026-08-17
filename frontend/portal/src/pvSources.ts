/**
 * PV breakdown logic: turn the site's reported measurement points into the calm
 * "39,0 kW = Deye 8,3 + Fronius Anlage 21,3 + Fronius WR 2 9,3" line under the
 * live PV figure. Pure, framework-free, fully unit-tested.
 *
 * The reason it exists (PV incident 2026-07-21): a multi-inverter site's portal
 * PV was ONE composite number, so nobody could tell it was the sum of three
 * devices - verifying meant opening the edge device's own :8484 page. This is
 * pure added VISIBILITY; the composite number itself is untouched.
 *
 * Two honesty rules, both mirroring the edge:
 *  - a point without a PV reading is NOT a zero part - it is left out of the
 *    parts and named in a note, so the shown parts always sum to what they say;
 *  - a stale point keeps its last value but is flagged (freshness dot), never
 *    silently presented as live;
 *  - a point reporting exactly 0 while a sibling generates SAYS SO
 *    ({@link NO_GENERATION_NOTE}) instead of standing there as a confident,
 *    unexplained "0,0 kW" (Herzogau 17.08.2026 — the customer read that row as
 *    "VoltPilot claims my inverter is dead"). `null` stays a gap, 0 stays a
 *    measured zero; the two must never look the same.
 */
import type { SiteSource } from './api';
import { newestTs } from './datenAlter';
import { deviceName } from './entityLabel';
import { fmtNum } from './format';

/** Below this magnitude a PV reading counts as "no generation" (live.ts DEADBAND_KW). */
const PV_DEADBAND_KW = 0.05;

/** Show the breakdown only when it actually explains something (2+ parts). */
const MIN_PARTS = 2;

/**
 * Die eine ruhige Zusatzzeile für einen Erzeuger, der GEMESSEN nichts liefert,
 * während ein Geschwister erzeugt. Bewusst kein Alarm und kein Rot: **0 ist ein
 * Zustand, kein Fehler** (Wolke, abgeschalteter String, Nacht auf einem
 * Ost-West-Dach) — die Zeile ordnet die Null nur ein, statt sie stumm neben
 * produzierende Nachbarn zu stellen.
 */
export const NO_GENERATION_NOTE = 'liefert gerade keine Erzeugung';

/**
 * Ob eine gemessene Zahl innerhalb des PV-Totbands liegt, also „keine
 * Erzeugung" bedeutet. `null` (= kein Messwert) ist ausdrücklich KEINE Null und
 * wird hier nie so behandelt.
 */
export function isMeasuredZero(kw: number | null | undefined): boolean {
  return kw != null && Number.isFinite(kw) && Math.abs(kw) <= PV_DEADBAND_KW;
}

/**
 * Die Zusatzzeile für EINEN Wert, gegeben ob irgendein Geschwister gerade
 * erzeugt. **Nachts, wenn alle 0 melden, gibt es KEINE Kennzeichnung** — sonst
 * stünde sie jede Nacht an jedem Gerät und wäre damit wertlos. Geteilt von der
 * v1-Aufteilung und der PV-Zusammensetzung der migrierten Anlage, damit
 * dieselbe Lage nicht zwei verschiedene Sätze bekommt.
 */
export function noGenerationNote(
  kw: number | null | undefined,
  anySiblingGenerates: boolean,
): string | null {
  return anySiblingGenerates && isMeasuredZero(kw) ? NO_GENERATION_NOTE : null;
}

/** One named part of the composite PV figure. */
export interface PvPart {
  id: string;
  /** Customer-facing name of the device ("Deye", "Fronius WR 2"). */
  label: string;
  kw: number;
  /** ok = live | stale = last known value | never = no reading yet. */
  health: SiteSource['health'];
  /**
   * Ruhige Einordnung einer gemessenen Null neben produzierenden Geschwistern
   * ({@link NO_GENERATION_NOTE}), sonst `null`.
   */
  note: string | null;
}

export interface PvBreakdown {
  /** Sum of the shown parts (kW) - always exactly what the parts add up to. */
  totalKw: number;
  parts: PvPart[];
  /**
   * Honest note when some point could not contribute (no reading yet), or null.
   * Never hidden - a missing part is why the sum may trail the site figure.
   */
  note: string | null;
  /**
   * Der jüngste Messzeitpunkt der gezeigten Teile (`readAt`, ersatzweise
   * `reportedAt`) — die Bezugszeit für den Daten-Alter-Ausweis „Stand: HH:MM".
   * `null`, wenn kein Teil einen verwertbaren Zeitstempel trägt.
   *
   * **Warum die Aufteilung ihre EIGENE Bezugszeit braucht:** ihre Punkte färben
   * sich aus `health`, und das ist der zuletzt GEMELDETE Zustand — er steht
   * grün auf einem stundenalten Datensatz weiter (Herzogau 17:55). Das Alter
   * kann also nur aus dem Zeitstempel kommen, nie aus der Farbe.
   */
  asOf: string | null;
}

/**
 * A customer-facing name for one measurement point. The derivation itself is
 * the SHARED `entityLabel.deviceName` (edge label → brand + short model), so
 * this box reads identically here and in the energy flow's composition; only
 * the last resorts are source-specific.
 */
export function sourceLabel(s: SiteSource): string {
  const derived = deviceName({ edgeLabel: s.label, brand: s.brand, model: s.model });
  if (derived) return derived;
  if (s.kind === 'primary') return 'Wechselrichter';
  if (s.role === 'grid-meter') return 'Netz-Zähler';
  return s.sourceId;
}

/**
 * The PV breakdown for a site, or null when it would not explain anything:
 * fewer than two generating points (a single-inverter site stays exactly as it
 * is today) or no data at all.
 *
 * Only points that actually report PV take part - a grid meter or a wallbox
 * never appears, and a producer without a reading is named in `note` instead of
 * being counted as 0.
 */
export function pvBreakdown(sources: SiteSource[] | null | undefined): PvBreakdown | null {
  if (!sources || sources.length === 0) return null;
  // A point can only be a PV part if it EVER reports PV; a point that measures
  // something else (grid meter, consumer) is simply not part of this picture.
  const producers = sources.filter((s) => s.role !== 'grid-meter' && s.role !== 'consumer');
  const parts: PvPart[] = [];
  const silent: string[] = [];
  const stamps: (string | null)[] = [];
  for (const s of producers) {
    if (s.pvKw == null) {
      // No PV reading: either it does not measure PV at all (then it has never
      // delivered and we stay quiet) or it is a producer we cannot read.
      if (s.health !== 'never') silent.push(sourceLabel(s));
      continue;
    }
    parts.push({
      id: s.sourceId,
      label: sourceLabel(s),
      kw: s.pvKw,
      health: s.health,
      // Erst gefüllt, wenn die ganze Liste steht - ob eine Null erklärt werden
      // muss, hängt an den GESCHWISTERN.
      note: null,
    });
    stamps.push(s.readAt ?? s.reportedAt ?? null);
  }
  const generating = parts.filter((p) => Math.abs(p.kw) > PV_DEADBAND_KW);
  if (parts.length < MIN_PARTS || generating.length < 1) return null;
  // Hier steht fest, dass mindestens ein Teil erzeugt (sonst wäre oben `null`
  // zurückgegangen) - die Nacht-Ausnahme ist damit strukturell erfüllt, nicht
  // nur zugesagt.
  for (const p of parts) p.note = noGenerationNote(p.kw, true);
  const totalKw = parts.reduce((sum, p) => sum + p.kw, 0);
  return { totalKw, parts, note: noteFor(silent), asOf: newestTs(stamps) };
}

function noteFor(silent: string[]): string | null {
  if (silent.length === 0) return null;
  if (silent.length === 1) return `${silent[0]} liefert gerade keine Werte.`;
  return `${silent.join(', ')} liefern gerade keine Werte.`;
}

/** The breakdown as ONE German line: "39,0 kW = Deye 8,3 + Fronius 21,3". */
export function breakdownLine(b: PvBreakdown): string {
  const parts = b.parts.map((p) => `${p.label} ${fmtNum(p.kw, '', 1)}`).join(' + ');
  return `${fmtNum(b.totalKw, 'kW', 1)} = ${parts}`;
}

/** German explanation of one part's freshness, for the dot's tooltip/aria text. */
export function healthTitle(health: SiteSource['health'], label: string): string {
  switch (health) {
    case 'ok':
      return `${label}: aktuelle Werte`;
    case 'stale':
      return `${label}: zuletzt bekannter Wert, aktuell keine neuen Daten`;
    default:
      return `${label}: wartet auf erste Daten`;
  }
}
