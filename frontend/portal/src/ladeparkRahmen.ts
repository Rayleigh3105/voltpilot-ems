/**
 * Der LADEPARK-RAHMEN als eigene Fläche (Verbrauchsmanagement v1 / P5, E10).
 *
 * Bis hierher konnte ein Kunde die Zahlen, nach denen sein Ladepark rechnet,
 * im Portal nicht einmal LESEN — sie lebten ausschließlich auf `:8484`. Der
 * Rahmen ist deshalb hier eine LESE-Fläche mit einer einzigen Ausnahme (der
 * Anschlussgrenze, die dem Kunden gehört); alles Übrige richtet VoltPilot ein.
 *
 * ⚠ ZWEI QUELLEN, und ihr Unterschied ist die Aussage:
 *
 *  - das **IST** (`LadeparkRahmen` aus `GET /verbraucher`) ist das, wonach die
 *    BOX gerade wirklich rechnet — sie meldet es in ihrem Budget-Block;
 *  - das **SOLL** (`ChargingConfig.frame`) ist das, was das Portal hinterlegt
 *    hat. `null` heißt dort „das Portal äußert sich nicht und die Box behält
 *    ihre eigene Zahl" (die PATCH-Regel des retained Dokuments), NIE 0.
 *
 * Gezeigt wird bevorzugt das IST — es ist das, was wirkt. Wo nur ein Soll
 * vorliegt, wird es als solches BENANNT („hinterlegt, noch nicht gemeldet"),
 * statt es als Messung auszugeben.
 *
 * ⚠ Die ROTATION meldet die Box in ihrem Budget-Block NICHT. Sie steht deshalb
 * nur, wenn das Portal sie hinterlegt hat, und trägt dann ausdrücklich das
 * Soll-Wort — eine erfundene „alle 15 Minuten" wäre schlimmer als keine Zeile.
 */

import { fmtNum } from './format';
import type { LadeparkRahmen } from './verbraucherZone';

/** Der im Portal hinterlegte Rahmen (`charging-config.frame`). */
export interface RahmenSoll {
  houseReserveKw?: number | null;
  marginPct?: number | null;
  minPowerKw?: number | null;
  rotationMinutes?: number | null;
  maxHouseLoadKw?: number | null;
  staticBudget?: boolean | null;
}

export const RAHMEN_KARTE_TITEL = 'Ladepark-Rahmen';
export const RAHMEN_KARTE_INTRO =
  'Die Zahlen, nach denen Ihr Ladepark rechnet. Die Anschlussgrenze gehört Ihnen — '
  + 'alles Weitere richtet VoltPilot ein.';

/** Der Satz für eine Zahl, die nur hinterlegt, aber nie gemeldet wurde. */
export const NUR_HINTERLEGT = 'hinterlegt, von Ihrer Box noch nicht gemeldet';

/** Der ehrliche Satz, wenn die Box sich zu einem Feld nie geäußert hat. */
export const NICHT_GEMELDET = 'Nicht gemeldet';

export interface RahmenZeile {
  key: string;
  label: string;
  /** Der anzuzeigende Wert; null = die Zeile sagt nichts (siehe `hinweis`). */
  wert: string | null;
  /** Woher er kommt — die Fläche macht daraus den kleinen Zusatz. */
  quelle: 'gemeldet' | 'hinterlegt' | 'unbekannt';
  /** Eine erklärende Zeile darunter; null = keine nötig. */
  hinweis: string | null;
}

function kw(v: number | null | undefined): string | null {
  return v == null || !Number.isFinite(v) ? null : fmtNum(v, 'kW');
}

function num(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : v;
}

/**
 * Eine Zeile aus IST und SOLL — das Ist gewinnt, ein reines Soll wird benannt.
 *
 * ⚠ Sie behauptet NIE eine Zahl: liegt weder Ist noch Soll vor, ist `wert`
 * null und die Fläche zeigt `NICHT_GEMELDET`.
 */
function zeile(
  key: string,
  label: string,
  ist: string | null,
  soll: string | null,
): RahmenZeile {
  if (ist != null) return { key, label, wert: ist, quelle: 'gemeldet', hinweis: null };
  if (soll != null) {
    return { key, label, wert: soll, quelle: 'hinterlegt', hinweis: NUR_HINTERLEGT };
  }
  return { key, label, wert: null, quelle: 'unbekannt', hinweis: null };
}

/**
 * Die Zeilen der Rahmen-Karte, in der Reihenfolge der abgenommenen Mockups.
 *
 * ⚠ Die BUDGET-Art (`statisch`/`gemessen`) ist die einzige Zeile ohne Zahl —
 * sie beantwortet „rechnet die Box mit der Messung oder mit den gepflegten
 * Werten?", und genau das entscheidet, ob die anderen Zeilen überhaupt wirken.
 */
export function rahmenZeilen(
  ist: LadeparkRahmen | null | undefined,
  soll: RahmenSoll | null | undefined,
): RahmenZeile[] {
  const i = ist ?? null;
  const s = soll ?? null;
  const zeilen: RahmenZeile[] = [];

  zeilen.push(zeile(
    'netzanschluss',
    'Anschlussgrenze',
    kw(num(i?.netzanschlussKw) ?? num(i?.gepflegteGrenzeKw)),
    null,
  ));
  zeilen.push(zeile(
    'hausreserve',
    'Höchste Gebäudelast',
    kw(num(i?.hoechsteHausLastKw)),
    kw(num(s?.maxHouseLoadKw)),
  ));
  zeilen.push(zeile(
    'abstand',
    'Sicherheitsabstand',
    pct(num(i?.sicherheitsabstandPct)),
    pct(num(s?.marginPct)),
  ));
  zeilen.push(zeile(
    'mindest',
    'Mindestleistung je Fahrzeug',
    kw(num(i?.mindestleistungKw)),
    kw(num(s?.minPowerKw)),
  ));
  // ⚠ Nur SOLL: die Box meldet ihre Rotation nicht (siehe Kopf).
  const rot = num(s?.rotationMinutes);
  zeilen.push(zeile(
    'rotation',
    'Wechsel bei knapper Leistung',
    null,
    rot == null ? null : `alle ${fmtNum(rot, 'Min.', 0)}`,
  ));
  zeilen.push(zeile(
    'modus',
    'Budget',
    modusWort(i?.modus),
    s?.staticBudget == null ? null : (s.staticBudget ? 'statisch' : 'gemessen'),
  ));
  return zeilen;
}

function pct(v: number | null): string | null {
  return v == null ? null : fmtNum(v, '%');
}

/**
 * Das Wort der Box zu ihrer Budget-Art — WÖRTLICH durchgereicht, wo wir es
 * kennen. Ein unbekanntes Wort wird NICHT übersetzt und NICHT geraten: es
 * steht so da, wie die Box es sagt.
 */
export function modusWort(modus: string | null | undefined): string | null {
  const m = (modus ?? '').trim();
  if (!m) return null;
  if (m === 'gemessen' || m === 'measured') return 'gemessen';
  if (m === 'statisch' || m === 'static') return 'statisch';
  return m;
}

/** Der Satz über der Karte, wenn die Box sich nie gemeldet hat. */
export const OHNE_MELDUNG =
  'Ihre Box hat sich zu diesen Werten noch nicht gemeldet — gezeigt wird, was hinterlegt ist.';

export function ohneMeldung(ist: LadeparkRahmen | null | undefined): boolean {
  if (!ist) return true;
  return num(ist.budgetKw) == null && num(ist.hoechsteHausLastKw) == null
    && num(ist.sicherheitsabstandPct) == null && num(ist.mindestleistungKw) == null;
}
