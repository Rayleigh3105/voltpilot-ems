/**
 * Speicherschonung (FK4): the customer's "Umgang mit dem Speicher" choice,
 * offered as three presets the backend maps onto the optimizer's battery wear
 * cost. The consequence sentences are honest derivations from the solver audit
 * (vp-solver-xlsx-f2 §4.4): on typical PV days the daily dispatch is invariant
 * across the ladder, so the presets differentiate only on marginal
 * opportunities (flat spreads, micro-arbitrage). Customer copy deliberately
 * carries NO ct/kWh numbers - the raw value stays admin-only (optimizer-config).
 *
 * The EFFECTIVE preset is derived server-side (`SiteAsset.speicherschonung`):
 * one of the three preset names, or 'individuell' when an admin configured a
 * custom wear cost - shown honestly, and a customer preset pick overwrites it.
 */

export type SpeicherschonungPreset = 'aggressiv' | 'ausgewogen' | 'schonend';

export interface SpeicherschonungOption {
  value: SpeicherschonungPreset;
  label: string;
  recommended: boolean;
  /** One honest German consequence sentence (no numbers, no jargon). */
  sentence: string;
}

export const SPEICHERSCHONUNG_OPTIONS: SpeicherschonungOption[] = [
  {
    value: 'aggressiv',
    label: 'Aggressiv',
    recommended: false,
    sentence:
      'Jede Gelegenheit wird genutzt; der Speicher arbeitet am meisten und altert am schnellsten.',
  },
  {
    value: 'ausgewogen',
    label: 'Ausgewogen',
    recommended: true,
    sentence:
      'Tägliche Solar-Verschiebung und lohnende Gelegenheiten; unwirtschaftliche Mini-Zyklen ' +
      'unterbleiben. Auf typischen PV-Anlagen entgeht gegenüber „Aggressiv“ praktisch kein Ertrag.',
  },
  {
    value: 'schonend',
    label: 'Schonend',
    recommended: false,
    sentence: 'Der Speicher arbeitet nur, wenn es sich deutlich lohnt – längste Lebensdauer.',
  },
];

/** The label an admin-configured custom wear cost reads as. */
export const SPEICHERSCHONUNG_INDIVIDUELL_LABEL = 'Individuell (durch VoltPilot konfiguriert)';

/**
 * Read-view label for the server-derived effective preset. Null/unknown falls
 * back to Ausgewogen (the server derives a stored NULL the same way).
 */
export function speicherschonungLabel(value: string | null | undefined): string {
  if (value === 'individuell') return SPEICHERSCHONUNG_INDIVIDUELL_LABEL;
  const opt =
    SPEICHERSCHONUNG_OPTIONS.find((o) => o.value === value) ??
    SPEICHERSCHONUNG_OPTIONS.find((o) => o.value === 'ausgewogen')!;
  return opt.recommended ? `${opt.label} (empfohlen)` : opt.label;
}

/**
 * The preset a radio group can pre-select; null for 'individuell' (nothing
 * pre-selected - the presets are offered, picking one overwrites the custom
 * value) and for null/unknown values.
 */
export function presetOf(value: string | null | undefined): SpeicherschonungPreset | null {
  return SPEICHERSCHONUNG_OPTIONS.some((o) => o.value === value)
    ? (value as SpeicherschonungPreset)
    : null;
}
