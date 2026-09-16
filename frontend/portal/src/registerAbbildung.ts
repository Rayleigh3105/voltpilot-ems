/**
 * Der FRONTEND-Zwilling von `MesskanalAbbildung.java`: die rohen Katalogwörter
 * eines Registers (`quantity`/`direction`/`aggregation_kind`) in den Wörtern des
 * Messstellen-Vertrags (Größe · Richtung · Wertart). Bis Konzept
 * vp-agg-konzept3-r8 stand diese Ableitung nur serverseitig zur Verfügung (über
 * das `messkanaele`-Read-Model, nur für SELEKTIERTE Kanäle); seit der Katalog
 * `quantity`/`direction` je Punkt mitliefert, kann der Summenwert-Assistent den
 * Guard auch auf noch nicht beobachtete Register anwenden.
 *
 * ⚠ Die drei Vertrags-Tabellen (`GROESSE`, `RICHTUNG`, `WERTARTEN`) sind
 * ZEICHENGLEICH mit dem Java-Zwilling (`services/api/.../measurement/
 * MesskanalAbbildung.java`) und der Katalog-Quelle
 * (`catalog/measurement-points/README.md`, „Größe und Richtung"). Ein Katalogwort
 * ohne Vertragswort ergibt `null` - ein solches Register speist keine Summe (nie
 * ein geratenes Nachbarwort). `kategorieWort` ist eine reine ANZEIGE-Erweiterung
 * (der Kategorie-Text der Zeile) und trägt keine Vertragslast.
 */

/** `quantity` → Vertrags-Größe (die fünf summierbaren Messgrößen). */
export const GROESSE: Record<string, string> = {
  active_energy: 'Wirkenergie',
  active_power: 'Wirkleistung',
  reactive_energy: 'Blindenergie',
  apparent_power: 'Scheinleistung',
  soc: 'Ladestand',
};

/** `direction` → Vertrags-Richtung. */
export const RICHTUNG: Record<string, string> = {
  import: 'Bezug',
  export: 'Abgabe',
  generation: 'Erzeugung',
  charge: 'Laden',
  discharge: 'Entladen',
  charge_discharge: 'Laden / Entladen',
  import_export: 'richtungslos',
  none: 'richtungslos',
};

/**
 * `aggregation_kind` → die WERTART des Messstellen-Formel-Modells
 * (`uemsMessstelle.ts` `GROESSEN_KATALOG.wertarten`, dieselben Wörter wie
 * `gesamtwert.ts`): ein laufender Zähler ist ein `Zählerstand`, ein Momentanwert
 * ein `Momentanwert`. Das ist BEWUSST nicht das rohe `gauge`/`counter` der
 * Katalog-Wertart - der Summen-Guard (`summierbar`/`passt`, `formelGroesse`)
 * rechnet mit den Vertragswörtern; ein rohes `gauge` würde `groessen_gemischt`
 * erzwingen. `state`/`text`/`bitfield`/`event` tragen keine summierbare Wertart.
 */
export const WERTART: Record<string, string> = {
  gauge: 'Momentanwert',
  counter: 'Zählerstand',
};

/** Die Vertrags-Größe eines Registers, oder `null` (dann nicht summierbar). */
export function groesseAus(quantity: string | null): string | null {
  return quantity == null ? null : GROESSE[quantity] ?? null;
}

/** Die Vertrags-Richtung eines Registers, oder `null` (der Katalog gibt keine). */
export function richtungAus(direction: string | null): string | null {
  return direction == null ? null : RICHTUNG[direction] ?? null;
}

/** Die summierbare Wertart aus `aggregation_kind`, oder `null` (kein Zahlenwert). */
export function wertartAus(aggregationKind: string | null): string | null {
  return aggregationKind == null ? null : WERTART[aggregationKind] ?? null;
}

/**
 * Das ANZEIGE-Kategoriewort einer Register-Zeile (die Unterzeile des Pickers) -
 * kein Vertragswort. Trägt das Register eine Vertrags-Größe, ist es diese; sonst
 * ein sprechendes Wort der rohen Messgröße (Spannung, Temperatur …) und, wenn
 * auch die fehlt, die Art des Werts (Zustand, Text …). Eine unbekannte Kategorie
 * ergibt `null` - dann steht schlicht kein Vorwort, nie ein geratenes.
 */
const QUANTITY_WORT: Record<string, string> = {
  active_energy: 'Wirkenergie',
  active_power: 'Wirkleistung',
  reactive_energy: 'Blindenergie',
  reactive_power: 'Blindleistung',
  apparent_power: 'Scheinleistung',
  apparent_energy: 'Scheinenergie',
  soc: 'Ladestand',
  voltage: 'Spannung',
  current: 'Strom',
  temperature: 'Temperatur',
  frequency: 'Frequenz',
  power_factor: 'Leistungsfaktor',
  energy_capacity: 'Kapazität',
};

const WERTART_WORT: Record<string, string> = {
  state: 'Zustand',
  text: 'Text',
  bitfield: 'Merker',
  event: 'Ereignis',
};

export function kategorieWort(
  quantity: string | null,
  aggregationKind: string | null,
): string | null {
  if (quantity && QUANTITY_WORT[quantity]) return QUANTITY_WORT[quantity];
  if (aggregationKind && WERTART_WORT[aggregationKind]) return WERTART_WORT[aggregationKind];
  return null;
}
