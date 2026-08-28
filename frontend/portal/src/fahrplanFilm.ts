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
 * Richtung (Captain-Entscheid D2, seit dem TAGES-SPLICE): der Film zeigt als
 * Standard den GANZEN Tag — auch die schon vergangenen Vormittags-Phasen,
 * abgehakt — und „Morgen" eingeklappt. Dieses Modul ändert sich dafür NICHT in
 * seiner Mechanik: es bekam die Vergangenheit von Anfang an mitgedacht (`past`
 * + `FilmRow.done`), und die api liefert sie jetzt (`api.schedule(id, 'day')`,
 * je Viertelstunde der Wert aus dem Lauf, der VOR ihrem Beginn galt). Ohne
 * diese Lesart (ältere api, oder ein Splice ohne vollständige Warum-Ebene)
 * bekommt `filmRows` weiter nur den jüngsten Lauf — dann ist `past` leer und
 * die Ansicht ist zeichengleich zur Rest-des-Tages-Fassung.
 *
 * EHRLICHKEIT der Vergangenheit: eine abgehakte Zeile sagt „so war es
 * GEPLANT", nie „so ist es gelaufen" — der Film trägt durchgehend das
 * Abzeichen „Geplant", es wird kein Ist-Wert erfunden, und der Verweis auf die
 * Messwerte bleibt (`filmPastNote`).
 *
 * Seit PR 4 trägt eine Zeile zusätzlich die DUTY-VORSCHAU: die zwei
 * In-Slot-Pflichten, die der Optimierer mit dem Plan persistiert, machen schon
 * VOR dem Abend sichtbar, dass der Watt-Wert dieser Phase eine Vorhersage ist
 * und kein fester Befehl („folgt dem gemessenen Verbrauch"). Die Worte dafür
 * stehen einmal in `schedule.ts` — Film und Diagramm-Tooltip teilen sie.
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
import {
  dutyLabel,
  DUTY_HINT,
  slotDuty,
  type PlanWordingKind,
  type SlotDuty,
} from './schedule';

/**
 * Die Pflicht-Vorschau einer Phase (PR 4): „folgt dem gemessenen Verbrauch" /
 * „lädt nur den Solar-Überschuss". Sie sagt VOR dem Slot, dass der Watt-Wert
 * dort eine Vorhersage ist und kein fester Befehl.
 */
export interface DutyNote {
  kind: SlotDuty;
  /** Das kurze Wort für die Zeile (mit „zeitweise", wenn nur ein Teil). */
  text: string;
  /** Der ausführliche Satz für den Tipp/`title`. */
  hint: string;
  /** true = nur ein TEIL der Viertelstunden der Phase trägt die Pflicht. */
  partial: boolean;
}

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
  /** Die In-Slot-Pflicht dieser Phase; null = keine (oder nicht bewertet). */
  duty: DutyNote | null;
}

export interface FilmView {
  /**
   * Abgeschlossene Phasen des Tages — abgehakt, nie als Ist behauptet. Leer,
   * solange nur der jüngste Lauf vorliegt (dann beginnt der Film bei „jetzt").
   */
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
      // Infinitiv wie die anderen Listenformen: der Film ist eine PLAN-Liste
      // (die Karte trägt das Abzeichen „Geplant" für alle Zeilen), also darf
      // die Zeile die Drosselung nicht im Indikativ behaupten.
      return 'Einspeisung pausieren';
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

/**
 * Die In-Slot-Pflicht einer PHASE, aus den Pflichten ihrer Viertelstunden.
 *
 * Der Optimierer setzt die Pflicht je Slot und nur dort, wo der Plan keinen
 * Netzhandel vorsieht — eine Phase trägt sie also typischerweise NICHT
 * durchgehend. Deshalb zählt diese Ableitung und sagt „zeitweise", statt für
 * die ganze Phase zu sprechen (`partial`). Null, wenn KEIN Slot sie
 * ausdrücklich trägt (ältere Zeilen → null → keine Markierung, nie geraten);
 * bei einem Gleichstand zweier verschiedener Pflichten ebenfalls null.
 */
export function phaseDuty(phase: PlanPhase, slots: WhySlot[]): DutyNote | null {
  const own = slots.slice(phase.startIdx, phase.endIdx + 1);
  if (own.length === 0) return null;
  let folgen = 0;
  let ueberschuss = 0;
  for (const s of own) {
    const kind = slotDuty(s);
    if (kind === 'verbrauch-folgen') folgen++;
    else if (kind === 'ueberschuss-laden') ueberschuss++;
  }
  if (folgen === 0 && ueberschuss === 0) return null;
  if (folgen === ueberschuss) return null; // widersprüchlich → lieber schweigen
  const kind: SlotDuty = folgen > ueberschuss ? 'verbrauch-folgen' : 'ueberschuss-laden';
  const count = Math.max(folgen, ueberschuss);
  const partial = count < own.length;
  return { kind, text: dutyLabel(kind, partial), hint: DUTY_HINT[kind], partial };
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
      duty: phaseDuty(phase, slots),
    };
    if (done) past.push(row);
    else if (running || sameDay(from, now)) today.push(row);
    else tomorrow.push(row);
  });

  const first = tomorrow[0];
  const naechsterTag = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // ⚠ Der Kopf sagt, WIE WEIT der Rest reicht - seit dem 48-h-Horizont
  // (28.08.2026) kann er über zwei Kalendertage laufen, und ein blosses
  // „Morgen" behauptete dann einen Tag zu viel. Zählt der Rest genau einen
  // Tag, bleibt der Satz Zeichen für Zeichen der bisherige.
  const restTage = new Set(tomorrow.map((r) => new Date(r.from).toDateString()));
  const kopf =
    first == null
      ? null
      : !sameDay(new Date(first.from), naechsterTag)
        ? 'Danach'
        : restTage.size > 1
          ? 'Morgen und danach'
          : 'Morgen';
  return {
    past,
    today,
    tomorrow,
    tomorrowSummary:
      first == null
        ? null
        : `${kopf} · ` +
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
 * Die Überschrift des Films: sobald abgehakte Phasen dabei sind, erzählt er
 * den GANZEN Tag — sonst bleibt es bei der Rest-des-Tages-Fassung (und damit
 * bei der bisherigen Beschriftung, damit eine ältere api nichts verspricht,
 * was sie nicht liefert).
 */
export function filmKicker(view: FilmView): string {
  return view.past.length > 0 ? 'Der ganze Tag' : 'Heute noch';
}

/**
 * Der Ehrlichkeits-Satz über den abgehakten Phasen: sie sagen, wie die
 * Viertelstunde GEPLANT war — nicht, wie sie gelaufen ist. Der Film hat keine
 * Ist-Werte und erfindet auch keine; was wirklich passiert ist, steht in den
 * Messwerten (der Verweis dazu lebt in der Fußzeile der Karte). Null ohne
 * Vergangenheit — dann gibt es nichts zu erklären.
 */
export function filmPastNote(view: FilmView): string | null {
  return view.past.length > 0
    ? 'Bereits gelaufen — so war es geplant, nicht wie es gelaufen ist.'
    : null;
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

/**
 * Die Erzählzeile der Speicher-Fahrplan-Karte des Cockpits
 * (vp-cockpit-unten-ux-n3 PR 4): wörtlich die {@link filmKurzfassung} — außer
 * die LAUFENDE Phase ist Ruhe, dann nennt die Zeile den Blick nach vorn
 * („Ruhe — als Nächstes: {Label} ab HH:MM Uhr.", via {@link naechsterEinsatz})
 * statt eines Leerlauf-Rätsels. Eine Ruhe ohne späteren Einsatz und jede
 * Nicht-Ruhe bleiben zeichengleich die Kurzfassung; null ohne Zeilen (der
 * Aufrufer fällt auf `planSentence` zurück — die Band-Disziplin).
 */
export function speicherKurzzeile(view: FilmView): string | null {
  const head = view.today[0];
  if (head?.now && head.kind === 'idle') {
    const next = naechsterEinsatz(view);
    if (next) return `Ruhe — als Nächstes: ${next.label} ab ${hm(next.at)} Uhr.`;
  }
  return filmKurzfassung(view);
}
