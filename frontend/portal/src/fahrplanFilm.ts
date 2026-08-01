/**
 * Der FILM DES TAGES der Fahrplan-Seite (Konzept `vp-fahrplan-kunde-konzept`
 * §6.2): die Phasen des Plans als ERZÄHLTE LISTE mit Jetzt-Anker statt eines
 * unbeschrifteten Farbstreifens und einer →-Kette.
 *
 * Warum eine Liste: bei 375 px zeigte der Streifen nur Farbblöcke ohne
 * Beschriftung, und Grün↔Türkis liegt unter dem Normalsicht-Schwellwert des
 * Farb-Validators — Identität darf also nie allein an der Farbe hängen. Jede
 * Zeile trägt deshalb ihr WORT; die Farbe verstärkt nur.
 *
 * Richtung v1 (Captain-Entscheid D2): der Film zeigt den REST DES HEUTIGEN
 * TAGES voll und „Morgen" eingeklappt — ohne API-Änderung. **Die Vergangenheit
 * ist im Datenmodell aber schon vorgesehen** (`past` + `FilmRow.done`), damit
 * die spätere Ganztages-Slotliste (Tages-Splice über mehrere Läufe) ohne Umbau
 * hineinpasst: sie füllt dann nur `past` mit abgehakten Phasen.
 *
 * Rein, ohne React/Netz. Es wird NICHTS neu gerechnet: Phasen, €-Beiträge und
 * Zeiträume kommen aus dem bestehenden `fahrplanWhy.ts`; dieses Modul ordnet
 * sie nur zu Zeilen. Ehrlichkeit: ein Zusatz erscheint nur, wenn der Plan die
 * Zahl wirklich trägt — nie ein erfundener Wert, nie ein behaupteter Messwert
 * (der Film trägt das Abzeichen „Geplant").
 */

import {
  phaseEurAmount,
  phaseRange,
  roleLabel,
  type PhaseKind,
  type PlanPhase,
  type SlotRole,
  type WhySlot,
} from './fahrplanWhy';
import type { PlanWordingKind } from './schedule';

/** Eine Zeile des Films — genau eine Phase des Plans. */
export interface FilmRow {
  /** Index in die Phasenliste (Tipp → das bestehende Erklär-Panel). */
  phaseIndex: number;
  role: SlotRole;
  kind: PhaseKind;
  /** Die LAUFENDE Phase — sie führt die Liste an. */
  now: boolean;
  /** Bereits abgeschlossen (heute leer; Platz für den Ganztages-Film). */
  done: boolean;
  /** Das Wort der Phase — die Identität, die nie an der Farbe hängt. */
  label: string;
  /** „17:45–21:30 Uhr". */
  time: string;
  /** ISO-Grenzen der Phase (für Ausblick + Kurzfassung). */
  from: string;
  to: string;
  /** Der ehrliche Zusatz („läuft · noch bis 21:30 Uhr"); null = keiner. */
  sub: string | null;
  /** „+2,80 €" / „−0,61 €"; null = kein berechenbarer Beitrag. */
  eur: string | null;
  /** true, wenn der Betrag ein EINKAUF ist (die Zeile sagt das Wort dazu). */
  einkauf: boolean;
}

export interface FilmView {
  /** Abgeschlossene Phasen (Ganztages-Film; in v1 leer). */
  past: FilmRow[];
  /** Der Rest des heutigen Tages, laufende Phase zuerst. */
  today: FilmRow[];
  /** Der Folgetag — eingeklappt. */
  tomorrow: FilmRow[];
  /** „Morgen · 3 weitere Phasen"; null = es gibt keinen Folgetag im Plan. */
  tomorrowSummary: string | null;
  /** Ehrlicher Leerzustand für „heute"; null = es gibt Zeilen. */
  empty: string | null;
}

/**
 * Das Vokabular des Films. Es ist bewusst eine LISTE mittlerer Länge (der
 * Streifen brauchte Kurzformen, das Panel die vollen Sätze) und bleibt
 * ansonsten `roleLabel` — nur vier Rollen bekommen die listen-taugliche Form.
 */
export function filmLabel(
  role: SlotRole,
  kind: PlanWordingKind,
  flags?: string[] | null,
): string {
  switch (role) {
    case 'warten':
      return 'Ruhe';
    case 'pv_speichern':
      return 'Sonne speichern';
    case 'eigenverbrauch':
      return 'Verbrauch decken';
    case 'abregeln':
      return 'Einspeisung pausiert';
    default:
      return roleLabel(role, kind, flags);
  }
}

function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/** de-DE „3,4 ct/kWh". */
function ct(v: number): string {
  return `${v.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} ct/kWh`;
}

/**
 * Der ehrliche Zusatz einer Zeile, aus dem, was der Lauf WIRKLICH trägt:
 *  - die laufende Phase sagt, wie lange sie noch läuft (der Live-Anteil, der
 *    ohne jeden neuen Messwert von selbst tickt);
 *  - eine Ruhe-/Reserve-Phase nennt den geplanten Ladestand an ihrem Ende;
 *  - eine Netzlade-Phase nennt den Ø BEZUGSPREIS (P0-Preiswahrheit — nie den
 *    nackten Börsenpreis als „Netzstrom"), sofern der Lauf ihn trägt;
 *  - eine Abregel-Phase nennt den Negativpreis als Grund.
 * Alles andere: kein Zusatz statt eines erfundenen.
 */
function rowSub(phase: PlanPhase, slots: WhySlot[], running: boolean): string | null {
  if (running) return `läuft · noch bis ${hm(phase.to)} Uhr`;
  const own = slots.slice(phase.startIdx, phase.endIdx + 1);
  if (phase.kind === 'idle') {
    const soc = lastNumber(own.map((s) => s.socPct));
    return soc == null
      ? null
      : `Speicher hält ~${Math.round(soc).toLocaleString('de-DE')} %`;
  }
  if (phase.role === 'guenstig_laden') {
    const avg = mean(own.map((s) => s.importPriceCtKwh));
    return avg == null ? null : `Ø Bezugspreis ${ct(avg)}`;
  }
  if (phase.role === 'abregeln') {
    const neg = own.some((s) => s.priceEurMwh != null && Number(s.priceEurMwh) < 0);
    return neg ? 'Negativpreis — nicht draufzahlen' : null;
  }
  return null;
}

function lastNumber(values: (number | null | undefined)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function mean(values: (number | null | undefined)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(Number(v))) continue;
    sum += Number(v);
    n++;
  }
  return n > 0 ? sum / n : null;
}

/**
 * Die Phasen als Filmzeilen, aufgeteilt in Vergangenheit / Rest des heutigen
 * Tages / Morgen. Eine Phase, die JETZT läuft, führt „heute" an — auch wenn
 * sie gestern begann; sonst entscheidet ihr Startzeitpunkt.
 */
export function filmRows(
  phases: PlanPhase[],
  slots: WhySlot[],
  kind: PlanWordingKind,
  now: Date,
): FilmView {
  const past: FilmRow[] = [];
  const today: FilmRow[] = [];
  const tomorrow: FilmRow[] = [];
  const t = now.getTime();

  phases.forEach((phase, phaseIndex) => {
    const from = new Date(phase.from);
    const to = new Date(phase.to);
    const done = to.getTime() <= t;
    const running = !done && from.getTime() <= t;
    const eur = phaseEurAmount(phase);
    const row: FilmRow = {
      phaseIndex,
      role: phase.role,
      kind: phase.kind,
      now: running,
      done,
      label: filmLabel(phase.role, kind, slots[phase.startIdx]?.slotFlags),
      time: phaseRange(phase),
      from: phase.from,
      to: phase.to,
      sub: rowSub(phase, slots, running),
      eur,
      einkauf: phase.kind === 'charge' && (phase.eur ?? 0) < 0,
    };
    if (done) past.push(row);
    else if (running || sameDay(from, now)) today.push(row);
    else tomorrow.push(row);
  });

  const first = tomorrow[0];
  const naechsterTag = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    past,
    today,
    tomorrow,
    tomorrowSummary:
      first == null
        ? null
        : `${sameDay(new Date(first.from), naechsterTag) ? 'Morgen' : 'Danach'} · ` +
          `${tomorrow.length} weitere ${tomorrow.length === 1 ? 'Phase' : 'Phasen'}`,
    empty:
      today.length > 0
        ? null
        : tomorrow.length > 0
          ? 'Für heute stehen keine weiteren Phasen an.'
          : 'Für den Rest des Tages ist derzeit nichts weiter geplant.',
  };
}

/**
 * Der nächste ECHTE Einsatz nach der laufenden Phase (Ruhe/Reserve zählen
 * nicht) — der Blick nach vorn, den der Jetzt-Held bei geplanter Ruhe zeigt.
 * Null, wenn nichts mehr folgt.
 */
export function naechsterEinsatz(view: FilmView): { label: string; at: string } | null {
  const rest = [...view.today, ...view.tomorrow].filter((r) => !r.now && r.kind !== 'idle');
  const next = rest[0];
  return next ? { label: next.label, at: next.from } : null;
}

/**
 * Die KURZFASSUNG des Films — eine ruhige Zeile für das Cockpit-Band und sein
 * Detail-Fenster. Sie ERSETZT die frühere →-Kette (Techniker-Kompression mit
 * Wiederholungen); die Liste selbst ist die Erzählung, hier steht nur ihr
 * Anfang. Null ohne Zeilen.
 */
export function filmKurzfassung(view: FilmView): string | null {
  const rows = view.today.length > 0 ? view.today : view.tomorrow;
  if (rows.length === 0) return null;
  const head = rows[0];
  // Die Labels bleiben VERBATIM: sie beginnen im Deutschen mit einem
  // Substantiv („Verbrauch decken", „Sonne speichern"), das auch in der
  // Satzmitte groß bleibt - eine Kleinschreibung wäre schlicht falsch.
  const parts = head.now
    ? [`Jetzt ${head.label} bis ${hm(head.to)} Uhr`]
    : [`Ab ${hm(head.from)} Uhr ${head.label}`];
  if (rows[1]) parts.push(`danach ${rows[1].label}`);
  if (rows[2]) parts.push(`dann ${rows[2].label}`);
  return `${parts.join(' · ')}.`;
}
