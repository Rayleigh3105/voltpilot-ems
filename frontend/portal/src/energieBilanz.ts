/**
 * Die reine Ableitung hinter der Standardansicht „Energie" (Historie, Struktur
 * B1 des Owner-Entwurfs `data/vp-ui-pv-hist-d8`).
 *
 * Zwei Dinge stehen hier — und NUR hier:
 *
 *  - **B1-b, die Periodensummen** ({@link energieBilanz}): erzeugt · verbraucht ·
 *    bezogen · eingespeist · **geladen · entladen**. Der recherchierte Standard
 *    (Fronius Solar.web, SolarEdge, Home Assistant Energy, Victron VRM, OpenEMS,
 *    evcc) führt eine Energie-Historie mit den **Energiemengen des Zeitraums** —
 *    nicht mit Min/Max/Ø einer einzelnen Kurve, wie es die Seite bisher tat.
 *  - **B1-a, die Reihen des EINEN Diagramms** ({@link energieSerien}): PV,
 *    Hausverbrauch, Netz (+Bezug/−Einspeisung), Batterie (+laden/−entladen) und
 *    der Ladestand auf zweiter Achse.
 *
 * Rein + framework-frei (der `nodata.ts`/`fleet.ts`-Präzedenzfall), unit-getestet
 * in `energieBilanz.test.ts`. Zwei Regeln sind Gesetz:
 *
 *  1. **Eine Summe wird aus den Buckets gebildet und ist `null`, wenn KEIN
 *     Bucket diesen Kanal getragen hat** — nie eine erfundene 0. Das gilt für
 *     alle sechs Summen gleich; die vier, die der Server ebenfalls liefert,
 *     summiert er über dieselben Buckets (`HistoryTotalsDto`), laden/entladen
 *     stehen gar nicht in `totals`. EINE Regel statt zwei Wahrheiten.
 *  2. **Ein fehlender Messwert bleibt in der Reihe abwesend (`null`)**, damit das
 *     Diagramm eine Lücke zeichnet statt einer 0-Linie.
 */
import type { History, HistoryBucket, HistoryRange } from './api';
import { periodLabel } from './periodNav';

/** Ein `chartTheme()`-Schlüssel — die Fläche löst ihn zur Farbe auf. */
export type EnergieFarbe =
  | 'pv'
  | 'load'
  | 'grid'
  | 'gridImport'
  | 'gridExport'
  | 'charge'
  | 'battDischarge'
  | 'soc';

// --- B1-b: Periodensummen ----------------------------------------------------

/** Die sechs Summen des Zeitraums, in fester Reihenfolge. */
export type EnergieSummeKey =
  | 'erzeugt'
  | 'verbraucht'
  | 'bezogen'
  | 'eingespeist'
  | 'geladen'
  | 'entladen';

export interface EnergieSumme {
  key: EnergieSummeKey;
  /** Deutsches Etikett („Erzeugt", „Geladen", …). */
  label: string;
  /** Energiemenge in kWh, oder `null` = kein Bucket trug diesen Kanal. */
  kwh: number | null;
  farbe: EnergieFarbe;
  /** Ein erklärender Satz (Tooltip/Untertitel), nie Fachjargon. */
  hinweis: string;
}

interface SummeDesc {
  key: EnergieSummeKey;
  label: string;
  farbe: EnergieFarbe;
  hinweis: string;
  field: keyof HistoryBucket;
}

const SUMMEN: SummeDesc[] = [
  {
    key: 'erzeugt',
    label: 'Erzeugt',
    farbe: 'pv',
    hinweis: 'Was Ihre PV-Anlage im Zeitraum erzeugt hat.',
    field: 'pvKwh',
  },
  {
    key: 'verbraucht',
    label: 'Verbraucht',
    farbe: 'load',
    hinweis: 'Was Ihr Haus im Zeitraum verbraucht hat.',
    field: 'loadKwh',
  },
  {
    key: 'bezogen',
    label: 'Bezogen',
    farbe: 'gridImport',
    hinweis: 'Was Sie aus dem Netz bezogen haben.',
    field: 'gridImportKwh',
  },
  {
    key: 'eingespeist',
    label: 'Eingespeist',
    farbe: 'gridExport',
    hinweis: 'Was Sie ins Netz eingespeist haben.',
    field: 'gridExportKwh',
  },
  {
    key: 'geladen',
    label: 'Geladen',
    farbe: 'charge',
    hinweis: 'Was in den Speicher geflossen ist.',
    field: 'batteryChargeKwh',
  },
  {
    key: 'entladen',
    label: 'Entladen',
    farbe: 'battDischarge',
    hinweis: 'Was der Speicher wieder abgegeben hat.',
    field: 'batteryDischargeKwh',
  },
];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Summe eines Bucket-Kanals über den Zeitraum — `null`, wenn KEIN Bucket diesen
 * Kanal getragen hat (Regel 1). Eine gemessene 0 zählt als Wert.
 */
export function sumChannel(buckets: HistoryBucket[], field: keyof HistoryBucket): number | null {
  let sum = 0;
  let any = false;
  for (const b of buckets) {
    const v = num(b[field]);
    if (v == null) continue;
    sum += v;
    any = true;
  }
  return any ? sum : null;
}

/** Die Kennzahl-Zeile der Standardansicht: sechs Energiemengen des Zeitraums. */
export function energieSummen(buckets: HistoryBucket[]): EnergieSumme[] {
  return SUMMEN.map((d) => ({
    key: d.key,
    label: d.label,
    kwh: sumChannel(buckets, d.field),
    farbe: d.farbe,
    hinweis: d.hinweis,
  }));
}

/** Die komplette Bilanz des Zeitraums: Summen + Quoten + Kosten. */
export interface EnergieBilanz {
  summen: EnergieSumme[];
  autarkiePct: number | null;
  eigenverbrauchPct: number | null;
  /** IMMER die reinen Börsenkosten des Netzbezugs (nie der Haustarif). */
  gridCostEur: number | null;
  /** Der ehrliche Zusatz zu `gridCostEur` — nie ohne ihn anzeigen. */
  gridCostHinweis: string;
  /** Keine einzige Summe vorhanden → der ehrliche Leerzustand. */
  empty: boolean;
}

/**
 * `gridCostEur` ist serverseitig immer der **Börsenpreis-Wert** des Netzbezugs;
 * ein konfigurierter Haustarif ist NICHT eingerechnet (Audit H8). Der Zusatz
 * sagt das — und zwar unterschiedlich, je nachdem ob der Kunde überhaupt einen
 * Tarif hinterlegt hat (sonst wäre „ohne Ihren Tarif" verwirrend).
 */
export function gridCostHinweis(tarifArt: History['totals']['tarifArt']): string {
  return tarifArt === 'fest' || tarifArt === 'dynamisch'
    ? 'zu Börsenpreisen · ohne Ihren Tarif'
    : 'zu Börsenpreisen';
}

export function energieBilanz(history: History): EnergieBilanz {
  const summen = energieSummen(history.buckets);
  return {
    summen,
    autarkiePct: num(history.totals.autarkiePct),
    eigenverbrauchPct: num(history.totals.eigenverbrauchPct),
    gridCostEur: num(history.totals.gridCostEur),
    gridCostHinweis: gridCostHinweis(history.totals.tarifArt),
    empty: summen.every((s) => s.kwh == null),
  };
}

// --- Zeitraum-Ehrlichkeit ----------------------------------------------------

/** Trägt der Anker denselben Zeitraum wie „jetzt"? */
export function isCurrentPeriod(anchor: Date, range: HistoryRange, now: Date): boolean {
  if (anchor.getFullYear() !== now.getFullYear()) return false;
  if (range === 'year') return true;
  if (range === 'month') return anchor.getMonth() === now.getMonth();
  if (range === 'day') {
    return anchor.getMonth() === now.getMonth() && anchor.getDate() === now.getDate();
  }
  // Woche: gleicher Montag.
  const monday = (d: Date) => {
    const m = new Date(d);
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
    return `${m.getFullYear()}-${m.getMonth()}-${m.getDate()}`;
  };
  return monday(anchor) === monday(now);
}

/**
 * Der Zeitraum-Hinweis des Entwurfs: „nie zwei Zahlen unter einem Wort". Wenn
 * ein vergangener Zeitraum gewählt ist, sagt die Seite ausdrücklich, dass ihre
 * Zahlen zu DIESEM Etikett gehören — eine Zahl, die der Kunde im Cockpit
 * („heute") oder unter „Erlöse" gesehen hat, ist dann eine andere. Im laufenden
 * Zeitraum gibt es keinen Widerspruch, also auch keinen Hinweis (null).
 */
export function zeitraumHinweis(anchor: Date, range: HistoryRange, now: Date): string | null {
  if (isCurrentPeriod(anchor, range, now)) return null;
  return `Alle Zahlen auf dieser Seite gelten für ${periodLabel(anchor, range)} — nicht für heute.`;
}

/** Das Etikett der Kennzahl-Zeile: die Summen tragen ihren Zeitraum am Kopf. */
export function summenTitel(anchor: Date, range: HistoryRange): string {
  return `Energie im Zeitraum · ${periodLabel(anchor, range)}`;
}
