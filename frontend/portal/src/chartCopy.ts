/**
 * K4 · Klartext statt Fachwort — das Wörterbuch der Chart-Beschriftungen.
 *
 * Eine Achse, eine Legendenzeile und ein Tooltip sind KUNDENCOPY. Sie standen
 * bisher unter keinem Wächter: `src/copy.test.ts` prüft das gesperrte
 * D3-Vokabular (Gerät/Komponente/Messwert), aber „SoC", „Day-Ahead" oder eine
 * nackte Einheit als Achsenname sind ebenso Fachjargon — nur eine Ebene tiefer.
 *
 * Hier stehen deshalb (a) die Ersetzungen als benannte Konstanten, damit
 * dieselbe Größe auf jeder Fläche gleich heißt, und (b) `axisName`, das eine
 * Einheit NIE allein stehen lässt. Der zugehörige Wächter lebt als eigener
 * Block in `copy.test.ts` — er liest die Chart-Quelldateien und macht ein
 * zurückgekehrtes Fachwort rot.
 */

/* ---------------------------------------------------------------------------
 * Die Größen — EIN Wort je Größe, portalweit
 * ------------------------------------------------------------------------- */

/** „Ladestand", nie „SoC" / „State of Charge". */
export const LADESTAND = 'Ladestand';
/** „Börsenpreis", nie „Day-Ahead" / „Spotpreis". */
export const BOERSENPREIS = 'Börsenpreis';
/** Der komponierte Bezugspreis (P0-Textwahrheit) — nicht der nackte Börsenpreis. */
export const BEZUGSPREIS = 'Bezugspreis';
/**
 * Was eine eingespeiste Kilowattstunde WIRKLICH einbringt (Börsenpreis +
 * Marktprämie bzw. feste Vergütung) — der Gegenpol zum {@link BEZUGSPREIS}.
 */
export const EINSPEISEWERT = 'Einspeisewert';
/**
 * Der Abstand zwischen {@link BEZUGSPREIS} und {@link EINSPEISEWERT}. Er IST
 * der Grund fürs Laden und Entladen, deshalb trägt die Fläche dazwischen ihr
 * Wort im Bild (K10) und nicht nur eine Legendenzeile.
 */
export const SPANNE = 'Spanne';
/** Die Leistung der Sonne auf die Anlage — nie „Einstrahlung (W/m²)" allein. */
export const SONNENSTAERKE = 'Sonnenstärke';

/* ---------------------------------------------------------------------------
 * Einheiten — als WORT plus Einheit, nie die Einheit allein
 *
 * „kW" über einer Achse beantwortet nicht, WAS dort gemessen wird; und kW
 * (Leistung) neben kWh (Energie) unkommentiert zu mischen ist die häufigste
 * Verwechslung im Energie-Portal. Deshalb trägt jeder Achsenname bei normaler
 * Breite die Größe als Wort und die Einheit in Klammern; nur wenn wirklich kein
 * Platz ist (schmale Telefon-Fassung), fällt das Wort weg.
 * ------------------------------------------------------------------------- */

/**
 * Der Achsenname einer Größe: `„Leistung (kW)"` bei normaler Breite, bei
 * Platzmangel die nackte Einheit.
 *
 * ⚠ Ein Achsenname darf NIE als Literal `name: 'kW'` in einer Chart-Datei
 * stehen — der Wächter in `copy.test.ts` macht genau das rot.
 */
export function axisName(quantity: string, unit: string, narrow = false): string {
  return narrow ? unit : `${quantity} (${unit})`;
}

/** Die im Portal gebräuchlichen Achsennamen, damit sie überall gleich lauten. */
export const AXIS = {
  leistung: (narrow = false) => axisName('Leistung', 'kW', narrow),
  energie: (narrow = false) => axisName('Energie', 'kWh', narrow),
  preis: (narrow = false) => axisName('Preis', 'ct/kWh', narrow),
  ladestand: (narrow = false) => axisName(LADESTAND, '%', narrow),
  geld: (narrow = false) => axisName('Ergebnis', '€', narrow),
  temperatur: (narrow = false) => axisName('Temperatur', '°C', narrow),
  bewoelkung: (narrow = false) => axisName('Bewölkung', '%', narrow),
  sonnenstaerke: (narrow = false) => axisName(SONNENSTAERKE, 'W/m²', narrow),
  /**
   * K4 in Reinform: „Ø kW" liest sich als DURCHSCHNITTSLEISTUNG — gemeint ist
   * aber, wie weit die Prognose danebenlag. Die Einheit steht deshalb als WORT
   * da; nur in der schmalen Fassung fällt sie auf ihr Kürzel zurück.
   */
  abweichung: (narrow = false) => (narrow ? 'kW' : 'Kilowatt Abweichung'),
} as const;

/* ---------------------------------------------------------------------------
 * Das Fallenwort
 * ------------------------------------------------------------------------- */

/**
 * „Viertel" ist im Energie-Portal besetzt — es liest sich als VIERTELSTUNDE.
 * Wer ein Tages-Quartil meint, schreibt die Zeitspanne aus („die günstigsten
 * 2½ Stunden"). Der Wächter macht das Wort in einer Chart-Beschriftung rot.
 */
export const VIERTEL_FALLE = 'Viertel';
