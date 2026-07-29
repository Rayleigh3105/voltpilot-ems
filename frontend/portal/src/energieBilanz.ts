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
  /** Die realen Bezugskosten des Netzbezugs (siehe `gridCostHinweis`). */
  gridCostEur: number | null;
  /** Der ehrliche Zusatz zu `gridCostEur` — nie ohne ihn anzeigen. */
  gridCostHinweis: string;
  /** Keine einzige Summe vorhanden → der ehrliche Leerzustand. */
  empty: boolean;
}

/**
 * `gridCostEur` wird serverseitig seit dem strukturierten Bezugspreis (Stufe 3)
 * mit DERSELBEN Preiskomposition bewertet, mit der auch die Steuerung plant:
 * hat die Anlage einen Tarif bzw. ein gepflegtes Preisblatt (`tarifPriced`),
 * ist das der echte Rechnungs-Level („bewertet zu Ihrem Stromtarif"); ohne
 * jede Preispflege bleibt es der reine Börsenpreis-Wert. Ein älteres Backend
 * liefert das Flag nicht — dann wird ehrlich „zu Börsenpreisen" gesagt, nie
 * ein Tarif behauptet, der nicht eingerechnet ist.
 */
export function gridCostHinweis(tarifPriced: boolean | null | undefined): string {
  return tarifPriced ? 'bewertet zu Ihrem Stromtarif' : 'zu Börsenpreisen';
}

export function energieBilanz(history: History): EnergieBilanz {
  const summen = energieSummen(history.buckets);
  return {
    summen,
    autarkiePct: num(history.totals.autarkiePct),
    eigenverbrauchPct: num(history.totals.eigenverbrauchPct),
    gridCostEur: num(history.totals.gridCostEur),
    gridCostHinweis: gridCostHinweis(history.totals.tarifPriced),
    empty: summen.every((s) => s.kwh == null),
  };
}

// --- B1-a: die Reihen des EINEN Diagramms ------------------------------------

/** Die fünf Reihen der Standardansicht. */
export type EnergieSerieKey = 'pv' | 'haus' | 'netz' | 'batterie' | 'soc';

/** Totband, unter dem ein Vorzeichen nichts mehr bedeutet (die `live.ts`-Regel). */
export const DEADBAND = 0.05;

export interface EnergieSerie {
  key: EnergieSerieKey;
  /** Legenden-Etikett. */
  label: string;
  /** Einheit hinter dem Etikett (kW/kWh, %). */
  unit: string;
  /** Der Vorzeichen-Zusatz der Legende („+ Bezug / − Einspeisung"), sonst null. */
  vorzeichen: string | null;
  farbe: EnergieFarbe;
  /** Vorzeichenbehaftet (Netz, Batterie) → um die betonte Nulllinie gespiegelt. */
  signed: boolean;
  /** Auf der zweiten Achse (Ladestand in %). */
  zweiteAchse: boolean;
  /** Als Linie/Fläche zeichnen statt als Balken (immer für den Ladestand). */
  linie: boolean;
  /** Werte in `zeiten`-Reihenfolge; `null` = abwesend (nie eine 0-Linie). */
  werte: (number | null)[];
  /** Kein einziger Wert → die Reihe fehlt, und die Legende sagt warum. */
  leer: boolean;
  /** Der ehrliche Grund, wenn `leer` — nie „keine Batterie" (Audit V1). */
  fehlt: string | null;
}

export interface EnergieDiagramm {
  /** Bucket-Startzeiten (ISO) — die gemeinsame Zeitachse aller Reihen. */
  zeiten: string[];
  /** Alle fünf Reihen, in fester Reihenfolge; leere tragen ihren Grund. */
  serien: EnergieSerie[];
  /** Tag = kW-Linien, Woche/Monat/Jahr = kWh-Balken (SolarEdge/Fronius-Wechsel). */
  balken: boolean;
  /** Die Einheit der vier Leistungs-/Energiereihen. */
  einheit: 'kW' | 'kWh';
  bucketMinutes: number;
  /** Index des letzten Buckets bei/vor „jetzt", sonst -1 (der Jetzt-Marker). */
  jetztIndex: number;
  /** Keine einzige Reihe trägt einen Wert. */
  leer: boolean;
}

interface SerieDesc {
  key: EnergieSerieKey;
  label: string;
  vorzeichen: string | null;
  farbe: EnergieFarbe;
  signed: boolean;
  zweiteAchse: boolean;
  linie: boolean;
  percent: boolean;
  /**
   * Der ehrliche Grund, wenn die Reihe leer ist. Bewusst „keine Werte in diesem
   * Zeitraum" und NICHT „keine Batterie"/„kein Zähler": ein fehlender Wert ist
   * eine Datenlage, keine Anlagen-Aussage (Audit V1). Die Erklärung „wird über
   * den Wechselrichter gemessen" gehört zur Expertenansicht, wo sie für einen
   * einzelnen Erzeuger tatsächlich zutrifft — hier wären sie geraten.
   */
  fehlt: string;
  /** Wert eines Buckets; null bleibt null. */
  from: (b: HistoryBucket) => number | null;
}

/** Signierte Differenz zweier Kanäle: null nur, wenn BEIDE fehlen. */
function signedDiff(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) - (b ?? 0);
}

const SERIEN: SerieDesc[] = [
  {
    key: 'pv',
    label: 'PV-Erzeugung',
    vorzeichen: null,
    farbe: 'pv',
    signed: false,
    zweiteAchse: false,
    linie: false,
    percent: false,
    fehlt: 'Für die PV-Erzeugung liegen in diesem Zeitraum keine Werte vor.',
    from: (b) => num(b.pvKwh),
  },
  {
    key: 'haus',
    label: 'Hausverbrauch',
    vorzeichen: null,
    farbe: 'load',
    signed: false,
    zweiteAchse: false,
    linie: false,
    percent: false,
    fehlt: 'Für den Hausverbrauch liegen in diesem Zeitraum keine Werte vor.',
    from: (b) => num(b.loadKwh),
  },
  {
    key: 'netz',
    label: 'Netz',
    vorzeichen: '+ Bezug / − Einspeisung',
    farbe: 'grid',
    signed: true,
    zweiteAchse: false,
    linie: false,
    percent: false,
    fehlt: 'Für das Netz liegen in diesem Zeitraum keine Werte vor.',
    from: (b) => signedDiff(num(b.gridImportKwh), num(b.gridExportKwh)),
  },
  {
    key: 'batterie',
    label: 'Batterie',
    vorzeichen: '+ laden / − entladen',
    farbe: 'charge',
    signed: true,
    zweiteAchse: false,
    linie: false,
    percent: false,
    fehlt: 'Für den Speicher liegen in diesem Zeitraum keine Werte vor.',
    from: (b) => signedDiff(num(b.batteryChargeKwh), num(b.batteryDischargeKwh)),
  },
  {
    key: 'soc',
    label: 'Ladestand',
    vorzeichen: null,
    farbe: 'soc',
    signed: false,
    zweiteAchse: true,
    linie: true,
    percent: true,
    fehlt: 'Für den Ladestand liegen in diesem Zeitraum keine Werte vor.',
    from: (b) => num(b.socLastPct),
  },
];

/** kWh eines Buckets → mittlere kW über den Bucket. */
export function kwFromKwh(kwh: number | null, bucketMinutes: number): number | null {
  if (kwh == null) return null;
  if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) return null;
  return (kwh * 60) / bucketMinutes;
}

/** Index des letzten Buckets, dessen Start bei/vor `now` liegt, sonst -1. */
export function jetztIndex(zeiten: string[], now: Date): number {
  const ms = now.getTime();
  let idx = -1;
  for (let i = 0; i < zeiten.length; i++) {
    if (new Date(zeiten[i]).getTime() <= ms) idx = i;
    else break;
  }
  return idx;
}

/**
 * Die EINE Energiegeschichte des Zeitraums: PV, Hausverbrauch, Netz
 * (+Bezug/−Einspeisung), Batterie (+laden/−entladen) und der Ladestand auf
 * zweiter Achse — alle auf derselben Zeitachse. Der Tag zeigt mittlere
 * LEISTUNG (kW-Linien), Woche/Monat/Jahr die ENERGIE je Abschnitt (kWh-Balken);
 * der Ladestand bleibt in beiden Fällen eine %-Linie.
 */
export function energieDiagramm(history: History, now: Date = new Date()): EnergieDiagramm {
  const { buckets, bucketMinutes } = history;
  const day = history.range === 'day';
  const zeiten = buckets.map((b) => b.start);

  const serien: EnergieSerie[] = SERIEN.map((d) => {
    const werte = buckets.map((b) => {
      const raw = d.from(b);
      if (d.percent) return raw;
      return day ? kwFromKwh(raw, bucketMinutes) : raw;
    });
    const leer = !werte.some((v) => v != null);
    return {
      key: d.key,
      label: d.label,
      unit: d.percent ? '%' : day ? 'kW' : 'kWh',
      vorzeichen: d.vorzeichen,
      farbe: d.farbe,
      signed: d.signed,
      zweiteAchse: d.zweiteAchse,
      // Am Tag sind alle Reihen Linien; ab der Woche Balken (außer dem Ladestand).
      linie: d.linie || day,
      werte,
      leer,
      fehlt: leer ? d.fehlt : null,
    };
  });

  return {
    zeiten,
    serien,
    balken: !day,
    einheit: day ? 'kW' : 'kWh',
    bucketMinutes,
    jetztIndex: day ? jetztIndex(zeiten, now) : -1,
    leer: serien.every((s) => s.leer),
  };
}

/**
 * Das sign-bewusste Etikett eines Werts — Vorzeichen erreichen den Kunden nie
 * als Minuszeichen, sondern als Wort (die `live.ts`-Konvention). Der Tooltip
 * nennt damit ALLE Reihen zu einem Zeitpunkt in Klartext.
 */
export function vorzeichenLabel(key: EnergieSerieKey, value: number): string {
  switch (key) {
    case 'netz':
      return value > DEADBAND ? 'Netzbezug' : value < -DEADBAND ? 'Einspeisung' : 'Netz ausgeglichen';
    case 'batterie':
      return value > DEADBAND ? 'Batterie lädt' : value < -DEADBAND ? 'Batterie entlädt' : 'Batterie hält';
    case 'pv':
      return 'PV-Erzeugung';
    case 'haus':
      return 'Hausverbrauch';
    case 'soc':
    default:
      return 'Ladestand';
  }
}

/** Der angezeigte Betrag: bei vorzeichenbehafteten Reihen ohne Vorzeichen. */
export function anzeigeWert(serie: Pick<EnergieSerie, 'signed'>, value: number): number {
  return serie.signed ? Math.abs(value) : value;
}

/**
 * Legenden-Umschaltung: die Legende IST die Bedienung. Eine Reihe kann
 * aus- und eingeblendet werden, aber niemals die letzte sichtbare — ein leeres
 * Diagramm ist kein Zustand, den ein Klick erreichen darf.
 */
export function toggleSerie(hidden: Set<string>, key: string, sichtbareGesamt: number): Set<string> {
  const next = new Set(hidden);
  if (next.has(key)) next.delete(key);
  else if (next.size < sichtbareGesamt - 1) next.add(key);
  return next;
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
