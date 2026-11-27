/**
 * „Ab wann?“ einer Preisänderung (vp-tarif-ab-tag): Stromtarif, Preisblatt und
 * Einspeisevergütung gelten ab einem Tag. Die Erlöse jeder Viertelstunde rechnen
 * mit dem Satz, der zu ihrer Zeit galt - eine Änderung ab heute lässt die
 * Vergangenheit, wie sie war. Rein: die Komponente `PreisGiltAbFeld` rendert nur.
 *
 * Wert an der API (`tarifGueltigAb` / `gueltigAb`): ein Tag `JJJJ-MM-TT` (heute
 * oder davor - nie in der Zukunft, denn der heutige Satz ist der, mit dem der
 * Fahrplan rechnet) oder `beginn` (der alte Wert war schon immer falsch).
 */

/** Die Wahl im Formular. `tag` ist ISO, `schonImmer` überstimmt ihn. */
export interface PreisGiltAb {
  tag: string;
  schonImmer: boolean;
}

export const LABEL_AB_WANN = 'Ab wann?';
export const LABEL_SCHON_IMMER = 'Schon immer – der alte Wert war falsch';
export const FEHLER_KEIN_TAG = 'Bitte wählen Sie den ersten Tag, ab dem der neue Wert gilt.';

/** Der heutige Tag der Anlage (Europe/Berlin) als JJJJ-MM-TT. */
export function heuteBerlin(jetzt: Date = new Date()): string {
  return jetzt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

/** Die Vorgabe: ab heute. */
export function preisGiltAbStart(jetzt: Date = new Date()): PreisGiltAb {
  return { tag: heuteBerlin(jetzt), schonImmer: false };
}

/** Der Wert für die API, oder `null`, wenn noch kein gültiger Tag gewählt ist. */
export function gueltigAbWert(w: PreisGiltAb, jetzt: Date = new Date()): string | null {
  if (w.schonImmer) return 'beginn';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.tag) || w.tag > heuteBerlin(jetzt)) return null;
  return w.tag;
}

function tagText(iso: string): string {
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
}

/** Der Satz unter dem Feld: was die Wahl mit den Erlösen macht. */
export function preisGiltAbSatz(w: PreisGiltAb, jetzt: Date = new Date()): string {
  if (w.schonImmer) {
    return 'Alle bisherigen Erlöse werden mit dem neuen Wert neu berechnet.';
  }
  if (w.tag === heuteBerlin(jetzt)) {
    return 'Ab heute. Die Erlöse der Tage davor bleiben, wie sie waren.';
  }
  return `Ab dem ${tagText(w.tag)}. Die Erlöse ab diesem Tag werden neu berechnet, die davor bleiben.`;
}
