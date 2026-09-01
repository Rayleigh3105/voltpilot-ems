/**
 * Der TAGES-ZEITSTRAHL der Fahrplan-Seite (UX-Runde r7): der textlastige „Film
 * des Tages" (eine Zeilenliste) wird zu einem waagerechten Band über der
 * Tagesachse. Jede Phase ist ein farbiges Segment, dessen Breite ihrer Dauer
 * entspricht; die laufende Phase trägt den Jetzt-Marker, die vergangenen sind
 * gedämpft. Ein Tipp auf ein Segment öffnet das BESTEHENDE Erklär-Panel.
 *
 * Warum ein Band statt einer Zeilenliste: der Kunde sieht „was passiert wann"
 * auf EINEN Blick, statt sechs Zeilen zu lesen (Captain: „zu viel Text"). Die
 * volle Liste bleibt als Aufklapper darunter erhalten — nichts geht verloren,
 * es führt nur nicht mehr die Seite.
 *
 * K10 (Farbe nie allein): die breiten Segmente tragen ihr WORT inline, die
 * schmalen ihr Wort im `title`/Accessible-Name, und die Legende unter dem Band
 * nennt jede vorkommende Phase mit Wort UND Farbe. Farbe ist also nie die
 * einzige Kodierung.
 *
 * Rein, ohne React/Netz. Es wird NICHTS neu gerechnet: Rollen, Zeiträume und
 * €-Beiträge kommen aus der schon abgeleiteten {@link FilmView} (`fahrplanFilm`),
 * dieses Modul rechnet nur die Geometrie. Ehrlichkeit: ohne Phasen gibt es
 * keinen Strahl (`null`), und der Jetzt-Marker erscheint nur, solange „jetzt"
 * wirklich im gezeigten Tag liegt.
 */

import type { FilmView, FilmRow } from './fahrplanFilm';
import type { SlotRole } from './fahrplanWhy';

/** Ein Segment des Bandes — genau eine Phase des Plans. */
export interface StrahlSegment {
  /** Index in die Phasenliste (Tipp → das bestehende Erklär-Panel). */
  phaseIndex: number;
  role: SlotRole;
  /** Das Wort der Phase — die Identität, die nie an der Farbe hängt. */
  label: string;
  /** Linke Kante in Prozent der Achse (0..100). */
  leftPct: number;
  /** Breite in Prozent der Achse (> 0). */
  widthPct: number;
  /** „17:45–21:30 Uhr" — der Accessible-Name/`title` des Segments. */
  time: string;
  /** Die LAUFENDE Phase (trägt den Jetzt-Marker, führt die Legende). */
  now: boolean;
  /** Bereits gelaufen — gedämpft gezeichnet, aber in der Farbsprache. */
  done: boolean;
  /** Breit genug für das WORT direkt im Segment (K10 in-place). */
  big: boolean;
  /** „+2,80 €" / null — nur auf einem breiten Segment gezeigt. */
  eur: string | null;
}

/** Eine Stundenmarke unter dem Band. */
export interface StrahlTick {
  /** Position in Prozent der Achse (0..100). */
  atPct: number;
  /** Die Stunde als Ziffer, z. B. „6", „12", „18". */
  label: string;
}

/** Eine Zeile der Legende — eine vorkommende Rolle mit Wort + Farbe. */
export interface StrahlLegende {
  role: SlotRole;
  label: string;
}

export interface StrahlView {
  segments: StrahlSegment[];
  ticks: StrahlTick[];
  legende: StrahlLegende[];
  /** Position des Jetzt-Markers (0..100); null = „jetzt" liegt außerhalb. */
  nowPct: number | null;
  /** „7:00 Uhr" — der Anfang der gezeigten Achse. */
  fromLabel: string;
  /** „0:00 Uhr" — das Ende der gezeigten Achse. */
  toLabel: string;
}

/**
 * Ab dieser Breite trägt ein Segment sein WORT direkt (K10 in-place). Schmalere
 * Segmente tragen es im Accessible-Name/`title` und in der Legende darunter.
 */
const MIN_LABEL_PCT = 11;

function hm(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: 'numeric', minute: '2-digit' });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Nette Stundenmarken STRIKT innerhalb der Achse. Der Abstand folgt der Spanne
 * (bis 6 h stündlich, bis 12 h alle 2 h, bis ~26 h alle 3 h, sonst alle 6 h),
 * damit ein 24-Stunden-Tag nicht 24 Ziffern trägt. Gerechnet in LOKALER Zeit —
 * der Kunde liest die Uhrzeit seiner Anlage.
 */
function hourTicks(start: number, end: number): number[] {
  const spanH = (end - start) / 3_600_000;
  const step = spanH <= 6 ? 1 : spanH <= 12 ? 2 : spanH <= 26 ? 3 : 6;
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  // Auf die erste lokale Stunde > start, die ein Vielfaches von `step` ist.
  while (d.getTime() <= start || d.getHours() % step !== 0) {
    d.setHours(d.getHours() + 1);
  }
  const ticks: number[] = [];
  for (let m = d.getTime(); m < end; ) {
    ticks.push(m);
    const nd = new Date(m);
    nd.setHours(nd.getHours() + step);
    m = nd.getTime();
  }
  return ticks;
}

/**
 * Die Geometrie des Bandes aus der {@link FilmView}. Das Band spannt den
 * SICHTBAREN Tag (Vergangenheit + Rest des heutigen Tages); „Morgen" bleibt in
 * der aufklappbaren Vollliste, es ist ein anderer Tag.
 *
 * Null, wenn es keine Phase für heute gibt oder die Spanne entartet ist — dann
 * gibt es nichts zu zeichnen, und die Fläche fällt auf die Vollliste zurück.
 */
export function strahlView(view: FilmView, now: Date): StrahlView | null {
  const rows: FilmRow[] = [...view.past, ...view.today];
  if (rows.length === 0) return null;
  const start = new Date(rows[0].from).getTime();
  const end = new Date(rows[rows.length - 1].to).getTime();
  const span = end - start;
  if (!(span > 0)) return null;

  const pct = (ms: number): number => ((ms - start) / span) * 100;

  const segments: StrahlSegment[] = rows.map((r) => {
    const l = new Date(r.from).getTime();
    const rr = new Date(r.to).getTime();
    const leftPct = clamp(pct(l), 0, 100);
    const widthPct = clamp(pct(rr) - pct(l), 0, 100 - leftPct);
    return {
      phaseIndex: r.phaseIndex,
      role: r.role,
      label: r.label,
      leftPct,
      widthPct,
      time: r.time,
      now: r.now,
      done: r.done,
      big: widthPct >= MIN_LABEL_PCT,
      eur: r.eur,
    };
  });

  // Legende: jede VORKOMMENDE Rolle EINMAL, mit dem Wort der ersten Zeile dieser
  // Rolle. So trägt auch ein schmales Segment sein Wort — Farbe nie allein.
  const seen = new Set<SlotRole>();
  const legende: StrahlLegende[] = [];
  for (const s of segments) {
    if (seen.has(s.role)) continue;
    seen.add(s.role);
    legende.push({ role: s.role, label: s.label });
  }

  const t = now.getTime();
  const nowPct = t >= start && t <= end ? clamp(pct(t), 0, 100) : null;

  const ticks: StrahlTick[] = hourTicks(start, end).map((ms) => ({
    atPct: clamp(pct(ms), 0, 100),
    label: new Date(ms).toLocaleTimeString('de-DE', { hour: 'numeric' }),
  }));

  return {
    segments,
    ticks,
    legende,
    nowPct,
    fromLabel: hm(start),
    toLabel: hm(end),
  };
}
