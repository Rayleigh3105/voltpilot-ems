/**
 * K7 · Ablesen in Sätzen — die Grammatik JEDES Chart-Tooltips.
 *
 * Bis Stufe 5 war ein Fadenkreuz-Tooltip eine Zahlenkolonne: fünf Zeilen
 * „Name: Zahl Einheit", die der Leser selbst zu einer Aussage verrechnen
 * musste. K7 (`vp-charts-verstaendlich-r2` §3) dreht das um — oben ein
 * Mini-SATZ, darunter nur noch die Werte, die der Satz nicht trägt.
 *
 * ⚠ DIE EHRLICHKEITSREGEL DIESER DATEI, und sie ist der ganze Grund für ihre
 * Existenz: **es wird nur ausgesprochen, was GEMESSEN ist.** Ein Satz wie
 * „Sonne liefert 5,2 kW: 3,1 in die Batterie, 2,1 ins Haus" verlangt eine
 * Zuordnung je Fluss — die hat das Portal aber nirgends: die Batterieleistung
 * ist selbst schon eine Bilanz-Ableitung (`live.deriveBatteryKw`), und wohin
 * eine PV-Kilowattstunde geht, misst kein Kanal. Deshalb spricht
 * {@link flussTeil} je Größe genau das aus, was ihr eigener Messwert hergibt
 * (Betrag + die Richtung, die im VORZEICHEN steckt) — und keine Zeile mehr.
 * Wo eine Fläche eine Zuordnung wirklich BELEGEN kann, gibt sie ihren Satzteil
 * selbst dazu (der Fahrplan tut das über `schedule.chargeKind`: in einem
 * Solarlade-Slot ist „lädt Solarstrom" eine Aussage des Plans, keine Schätzung).
 *
 * Die zweite Regel ist die alte: **ein Formatter gibt ROHES HTML zurück.**
 * ECharts setzt den Rückgabewert per `innerHTML`, also darf hier nie ein
 * API-/kundenkontrollierter String unescaped hinein — {@link escHtml} ist der
 * eine Ausgang dafür, und die Zahlen kommen als fertig formatierte Strings aus
 * `format.ts` herein (kein zweiter Zahlen-Formatierer an dieser Stelle).
 *
 * Die dritte Regel ist M10 im Geiste (r2 §7 führt M10 selbst als ENTFALLEN,
 * weil K2 „es an der besseren Stelle löst"): **keine Doppel-Kolonne.** Sie ist
 * hier STRUKTURELL eingelöst statt per Schalter — eine Fläche baut ihren Satz
 * aus den Fluss-Größen und ihre Wert-Zeilen aus dem REST. Was der Satz
 * ausspricht, steht darunter nicht noch einmal; was er nicht tragen kann
 * (Ladestand, Preis, Prognose, Verbraucher-Schichten), behält seine Zeile.
 * Genau das ist die Entlastung, die die Direktbeschriftung aus Stufe 1
 * verlangt: dort steht der Wert schon am Kurvenende, hier steht die AUSSAGE.
 */

import { DEADBAND_KW, gridState, loadState, pvState } from './live';

/* ---------------------------------------------------------------------------
 * Der Kasten selbst — ein SATZ muss umbrechen dürfen
 * ------------------------------------------------------------------------- */

/**
 * ⚠ ECharts setzt auf seinen HTML-Tooltip hart `white-space: nowrap` und
 * KEINE Breitenbegrenzung. Für eine Zahlenkolonne ist das richtig (jede Zeile
 * ist kurz), für einen SATZ ist es fatal: „Sonne liefert 1,6 kW, Haus braucht
 * 3,4 kW, 1,8 kW aus dem Netz." wurde damit **431 px breit** und lief auf
 * einem 327-px-Canvas seitlich heraus — `confine: true` verschiebt den Kasten
 * nur, es macht ihn nicht schmaler. **Im Browser bei Telefonbreite gemessen,
 * nicht im Test** (jsdom rendert keine Textbreite).
 *
 * Jede Fläche, die einen K7-Satz zeigt, MUSS das hier mitgeben. `100%` ist die
 * Breite des Chart-Containers (er ist `position: relative`, der Tooltip liegt
 * als absolut positioniertes Kind darin) — der Kasten wird also nie breiter
 * als sein eigenes Diagramm; der 320-px-Deckel hält ihn am Schreibtisch
 * lesbar, statt eine Zeile über die halbe Leinwand zu ziehen.
 */
export const TOOLTIP_CSS = 'white-space: normal; max-width: min(320px, 100%);';

/* ---------------------------------------------------------------------------
 * Bausteine — Kopf, Zeile, Punkt
 * ------------------------------------------------------------------------- */

/**
 * Der eine HTML-Ausgang für Text, den nicht wir geschrieben haben
 * (Verbrauchernamen, Gerätebezeichnungen). Bis Stufe 6 lebte er als private
 * Kopie im `ScheduleChart`; hier steht er, damit die nächste Fläche mit einem
 * dynamischen Namen ihn nicht neu erfindet.
 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Die fette Kopfzeile eines Tooltips — der Zeitpunkt, den man abliest. */
export function kopf(text: string): string {
  return `<b>${escHtml(text)}</b>`;
}

/**
 * Der farbige Punkt einer Wert-Zeile. Drei Flächen bauten dieselbe
 * `<span>`-Kette selbst (Fahrplan, Tagesbild, Admin-Plan) — sie ist eine
 * Darstellungs-Entscheidung, keine Fachaussage, und gehört deshalb an EINE
 * Stelle.
 *
 * `farbe` ist immer ein aufgelöster Token-Wert aus `chartTheme()`, nie eine
 * Eingabe von aussen.
 */
export function punkt(farbe: string): string {
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${farbe};margin-right:6px"></span>`;
}

/** Eine Wert-Zeile: farbiger Punkt + fertiger Text. */
export function wertZeile(farbe: string, text: string): string {
  return `${punkt(farbe)}${text}`;
}

/**
 * Eine ruhige Zusatz-Zeile (Grund, Hinweis, Geste) — kein Punkt, gedämpfte
 * Farbe. Sie trägt nie eine Zahl, die schon im Satz steht.
 */
export function notizZeile(farbe: string, text: string): string {
  return `<span style="color:${farbe}">${text}</span>`;
}

/**
 * Setzt den Tooltip zusammen. `null`/`''` fallen heraus, damit eine Fläche ihre
 * Zeilen bedingungslos aufzählen kann und trotzdem nie eine Leerzeile entsteht.
 */
export function tooltip(...teile: (string | null | undefined)[]): string {
  return teile.filter((z): z is string => !!z).join('<br/>');
}

/* ---------------------------------------------------------------------------
 * Der SATZ
 * ------------------------------------------------------------------------- */

/**
 * Fügt Satzteile zu EINEM Mini-Satz. Der letzte Teil bekommt kein „und" —
 * eine Ablese-Zeile ist eine Aufzählung von Messwerten, kein Fließtext, und
 * „und" liest sich an dieser Stelle wie eine Folgerung.
 *
 * `null` ⇒ es gab nichts Belegtes zu sagen; die Fläche zeigt dann nur ihre
 * Wert-Zeilen (oder gar nichts) — nie einen Satz über Nichts.
 */
export function ableseSatz(teile: (string | null | undefined)[]): string | null {
  const echte = teile.filter((t): t is string => !!t);
  if (echte.length === 0) return null;
  return `${echte.join(', ')}.`;
}

/** Die vier Größen, für die es ein gemessenes Richtungs-WORT gibt. */
export type FlussRolle = 'pv' | 'haus' | 'netz' | 'speicher';

/**
 * Der Satzteil EINER Größe — Betrag plus die Richtung, die wirklich im
 * Messwert steckt.
 *
 * ⚠ `wert == null` ⇒ `null`: eine Größe, die nicht gemessen wurde, kommt im
 * Satz NICHT vor (sie ist nicht „0" und nicht „ausgeglichen"). Das ist
 * dieselbe „—"-Disziplin, mit der die Kacheln rechnen.
 *
 * Deadband und Richtungsregel kommen aus `live.ts` — es gibt im Portal genau
 * EINE Antwort auf „lädt oder entlädt", „Bezug oder Einspeisung", und ein
 * vierter Schwellwert an dieser Stelle wäre die Rückkehr des Zustands, den
 * `chartStyle.ts` beendet hat.
 *
 * @param fmt formatiert den BETRAG samt Einheit („5,2 kW"); das Vorzeichen
 *   erreicht den Kunden nie als Minus, sondern immer als Wort.
 */
export function flussTeil(
  rolle: FlussRolle,
  wert: number | null,
  fmt: (betrag: number) => string,
): string | null {
  if (wert == null) return null;
  const betrag = fmt(Math.abs(wert));
  switch (rolle) {
    case 'pv':
      return pvState(wert) === 'erzeugt' ? `Sonne liefert ${betrag}` : 'keine Sonne';
    case 'haus':
      return loadState(wert) === 'bedarf' ? `Haus braucht ${betrag}` : 'Haus braucht nichts';
    case 'netz': {
      const s = gridState(wert);
      if (s === 'bezug') return `${betrag} aus dem Netz`;
      if (s === 'einspeisung') return `${betrag} ins Netz`;
      return 'Netz ausgeglichen';
    }
    case 'speicher':
    default:
      if (wert > DEADBAND_KW) return `Speicher lädt mit ${betrag}`;
      if (wert < -DEADBAND_KW) return `Speicher gibt ${betrag} ab`;
      return 'Speicher hält';
  }
}

/**
 * Derselbe Satzteil für eine ENERGIE-Reihe (kWh je Eimer statt kW je
 * Augenblick). Die Richtung steckt hier nicht im Vorzeichen einer Leistung,
 * sondern in der Reihe selbst — deshalb ein eigener Bauer statt einer
 * Einheiten-Fallunterscheidung in {@link flussTeil}: „Haus braucht 31 kWh"
 * beschreibt einen Zeitraum, „Haus braucht 3,4 kW" einen Zeitpunkt, und die
 * zwei Sätze dürfen sich nicht gegenseitig umformulieren.
 */
export function energieTeil(
  rolle: FlussRolle,
  wert: number | null,
  fmt: (betrag: number) => string,
): string | null {
  if (wert == null) return null;
  const betrag = fmt(Math.abs(wert));
  switch (rolle) {
    case 'pv':
      return `Sonne ${betrag} erzeugt`;
    case 'haus':
      return `Haus ${betrag} verbraucht`;
    case 'netz':
      if (wert > 0) return `${betrag} bezogen`;
      if (wert < 0) return `${betrag} eingespeist`;
      return 'nichts über das Netz';
    case 'speicher':
    default:
      if (wert > 0) return `${betrag} geladen`;
      if (wert < 0) return `${betrag} abgegeben`;
      return 'Speicher unbewegt';
  }
}

/* ---------------------------------------------------------------------------
 * M10 im Geiste · keine Doppel-Kolonne
 * ------------------------------------------------------------------------- */

/** Die Fluss-Rollen, die {@link flussSatz} in EINEN Satz zusammenzieht. */
const SATZ_ROLLEN: readonly FlussRolle[] = ['pv', 'haus', 'netz', 'speicher'];

/**
 * Der komplette Ablese-Satz einer Fluss-Fläche plus die Auskunft, WELCHE
 * Größen er ausgesprochen hat.
 *
 * Die zweite Hälfte ist der Punkt: sie ist die Bedingung dafür, dass darunter
 * keine Doppel-Kolonne entsteht. Eine Fläche fragt `genannt`, bevor sie eine
 * Wert-Zeile baut — und was der Satz nicht tragen konnte (weil nicht gemessen),
 * bekommt seine Zeile zurück, statt still zu verschwinden.
 */
export interface FlussSatz {
  /** Der Mini-Satz — `null`, wenn keine einzige Größe belegt war. */
  text: string | null;
  /** Die Rollen, die im Satz WIRKLICH vorkommen. */
  genannt: ReadonlySet<FlussRolle>;
}

/**
 * Baut {@link FlussSatz} aus den Messwerten. Die Reihenfolge im Satz ist fest
 * (Sonne → Haus → Netz → Speicher) — sie folgt dem Weg der Energie und ist
 * damit auf jeder Fläche dieselbe, egal in welcher Reihenfolge die Reihen
 * gezeichnet werden.
 */
export function flussSatz(
  werte: Partial<Record<FlussRolle, number | null>>,
  fmt: (betrag: number) => string,
  teil: (rolle: FlussRolle, wert: number | null, fmt: (b: number) => string) => string | null = flussTeil,
): FlussSatz {
  const genannt = new Set<FlussRolle>();
  const teile: string[] = [];
  for (const rolle of SATZ_ROLLEN) {
    const t = teil(rolle, werte[rolle] ?? null, fmt);
    if (t == null) continue;
    genannt.add(rolle);
    teile.push(t);
  }
  return { text: ableseSatz(teile), genannt };
}
