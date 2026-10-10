/**
 * „Was misst dieser Wert?" — die EINE Frage im Formular „Eigenen Messwert
 * hinzufügen" (Schnitt 2 der Untersuchung „Portal-Weg Messkunde", 21.09.2026).
 * `components/BeobachteteRegister.tsx` rendert sie und entscheidet nichts.
 *
 * ⚠ **Nur, was das System nicht selbst wissen kann.** Einheit, Skala und
 * Datentyp stehen schon im Register; gefragt wird allein, WAS gemessen wird.
 * Aus der Antwort folgen die drei Katalogwörter (`quantity`, `direction`,
 * `aggregationKind`, openapi `CustomMeasurementMeasures`) und die
 * Aufbewahrungsklasse — der Kunde sieht keins davon.
 *
 * ⚠ **Nur, was danach auch eine Messstelle trägt.** Die Liste ist genau die
 * Menge, die die API annimmt (`CustomMeasurementPoint.MESSGROESSEN` ×
 * `RICHTUNGEN`): eine Wirkgröße mit einem Fluss des Messstellen-Vorschlags.
 * Alles andere ist „Etwas anderes (ohne Messstelle)" — der Wert wird
 * beobachtet und aufgezeichnet wie bisher.
 *
 * ⚠ **Die Aufbewahrungsklasse folgt der Antwort.** Aus ihr liest der Writer die
 * Wertart der gespeicherten Werte (`energy_counter` → Zählerstand, sonst
 * Momentanwert). Das Formular schickte bis hierher fest `gauge` — eine Klasse,
 * die die API gar nicht kennt (`MeasurementRetention.ofCustomClass`), jeder
 * Speicherversuch endete in 400.
 */
import type { CustomMeasurementMeasures } from './api';

export const MESSWERT_FRAGE = 'Was misst dieser Wert?';

export interface MesswertArt {
  value: string;
  label: string;
  /** `null` = keine Messstelle (die Form von vor Schnitt 2). */
  measures: CustomMeasurementMeasures | null;
  retentionClass: string;
  /** Die Einheiten, die die Messstelle umrechnen kann (`MessstelleRegeln.KANAL_EINHEITEN`). */
  einheiten: readonly string[];
}

const RICHTUNGEN: ReadonlyArray<readonly [CustomMeasurementMeasures['direction'], string]> = [
  ['import', 'Bezug'],
  ['export', 'Abgabe'],
  ['generation', 'Erzeugung'],
  ['charge', 'Laden'],
  ['discharge', 'Entladen'],
];

const ENERGIE_EINHEITEN = ['Wh', 'kWh', 'MWh'] as const;
const LEISTUNG_EINHEITEN = ['W', 'kW', 'MW'] as const;

export const ANDERES = 'anderes';

export const MESSWERT_ARTEN: readonly MesswertArt[] = [
  ...RICHTUNGEN.map(([direction, wort]) => ({
    value: `energie.${direction}`,
    label: `Energie-Zählerstand – ${wort}`,
    measures: { quantity: 'active_energy', direction, aggregationKind: 'counter' } as CustomMeasurementMeasures,
    retentionClass: 'energy_counter',
    einheiten: ENERGIE_EINHEITEN,
  })),
  ...RICHTUNGEN.map(([direction, wort]) => ({
    value: `leistung.${direction}`,
    label: `Leistung – ${wort}`,
    measures: { quantity: 'active_power', direction, aggregationKind: 'gauge' } as CustomMeasurementMeasures,
    retentionClass: 'live_power',
    einheiten: LEISTUNG_EINHEITEN,
  })),
  {
    value: ANDERES,
    label: 'Etwas anderes (ohne Messstelle)',
    measures: null,
    // Ein gemessener Wert ohne Zählerstand: der Writer liest ihn als Momentanwert.
    retentionClass: 'live_power',
    einheiten: [],
  },
];

export function messwertArt(value: string | null | undefined): MesswertArt | null {
  return MESSWERT_ARTEN.find((a) => a.value === value) ?? null;
}

function aufzaehlung(woerter: readonly string[]): string {
  return woerter.length < 2 ? woerter.join('') : `${woerter.slice(0, -1).join(', ')} oder ${woerter[woerter.length - 1]}`;
}

/** Die Zeile unter der Frage: was aus der Antwort folgt. */
export function messwertHinweis(art: MesswertArt | null): string {
  if (!art) return 'Nur mit dieser Angabe bekommt der Wert eine Messstelle.';
  if (!art.measures) return 'Der Wert wird aufgezeichnet, bekommt aber keine Messstelle.';
  return `Bekommt eine Messstelle über den Messen-Assistenten. Einheit ${aufzaehlung(art.einheiten)}.`;
}

/** Passt die Einheit zur Antwort? Sonst der Satz, den auch die API sagt. */
export function einheitFehler(art: MesswertArt | null, unit: string): string | null {
  if (!art || art.einheiten.length === 0 || art.einheiten.includes(unit.trim())) return null;
  const was = art.measures?.aggregationKind === 'counter' ? 'Ein Energie-Zählerstand' : 'Eine Leistung';
  return `${was} braucht die Einheit ${aufzaehlung(art.einheiten)}.`;
}

/** Der Teil der Definition, der aus der Antwort folgt. */
export function definitionAusArt(art: MesswertArt): { retentionClass: string; measures?: CustomMeasurementMeasures } {
  return art.measures ? { retentionClass: art.retentionClass, measures: art.measures } : { retentionClass: art.retentionClass };
}
