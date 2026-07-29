import type { SupplyPrice, SupplyPriceUpdate, TarifArt } from './api';

/**
 * Pure logic for the structured supply-price sheet (Bezugspreis-Komponenten,
 * report vp-nacht-bezug-e7 §3.1, Stufe 2): the researched SUGGESTION values,
 * which fields to show per Tarif-Art, and the text <-> patch conversions the
 * maintenance forms use. Kept side-effect-free so it is unit-tested without a
 * DOM (the anlage.ts / fleet.ts precedent).
 *
 * The suggestions are a PREFILL only - they are editable and become the
 * maintained sheet only when the operator saves. Nothing here auto-activates
 * the `OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS` flag.
 */

/** The component keys the sheet carries (ct/kWh netto), in display order. */
export type SupplyPriceComponentKey =
  | 'netzentgeltArbeitspreisCt'
  | 'stromsteuerCt'
  | 'konzessionsabgabeCt'
  | 'umlagenCt'
  | 'vertriebsaufschlagCt';

/** One editable field: its key, German label, suggestion and hint. */
export interface SupplyPriceField {
  key: SupplyPriceComponentKey;
  label: string;
  suggestion: number;
  help: string;
}

/**
 * The researched default set, Stand 2026 (report Teil 2) - the SAME numbers as
 * the backend `SlotEconomics.DEFAULT_SUPPLY_PRICE` / pricing.py
 * `DEFAULT_SUPPLY_COMPONENTS`. Shown as an editable prefill with a visible
 * source + Stand.
 */
export const SUPPLY_PRICE_FIELDS: SupplyPriceField[] = [
  {
    key: 'netzentgeltArbeitspreisCt',
    label: 'Netzentgelt-Arbeitspreis (ct/kWh)',
    suggestion: 7.6,
    help: 'Vom Preisblatt Ihres Netzbetreibers (je nach VNB ca. 5,5–11 ct).',
  },
  {
    key: 'stromsteuerCt',
    label: 'Stromsteuer (ct/kWh)',
    suggestion: 2.05,
    help: 'Bundesweit einheitlich 2,05 ct/kWh.',
  },
  {
    key: 'konzessionsabgabeCt',
    label: 'Konzessionsabgabe (ct/kWh)',
    suggestion: 1.59,
    help: 'Je Gemeindegröße (Stadt bis 100.000 Einw.: 1,59 ct).',
  },
  {
    key: 'umlagenCt',
    label: 'Umlagen (KWKG, Offshore, §19) (ct/kWh)',
    suggestion: 2.946,
    help: 'Als eine Summe – 2026 zusammen 2,946 ct/kWh.',
  },
  {
    key: 'vertriebsaufschlagCt',
    label: 'Vertriebsaufschlag (ct/kWh)',
    suggestion: 1.5,
    help: 'Marge Ihres dynamischen Tarifs (typisch 1–3 ct).',
  },
];

/** The suggested USt rate (household 19 %, C&I with Vorsteuer-Abzug 0). */
export const SUPPLY_PRICE_UST_SUGGESTION = 19;

/** The visible provenance shown next to the prefilled values. */
export const SUPPLY_PRICE_SOURCE_NOTE =
  'Vorschlagswerte Stand 2026 – bitte gegen das Preisblatt Ihres ' +
  'Netzbetreibers und Ihre Stromrechnung prüfen.';

/**
 * Whether the component fields apply for this Tarif-Art: only for the
 * structured tariffs (`dynamisch`/`ohne`). For `fest` the all-in price wins and
 * the components are ignored, so the form shows a hint instead.
 */
export function showSupplyPriceFields(tarifArt: TarifArt): boolean {
  return tarifArt === 'dynamisch' || tarifArt === 'ohne';
}

/** The German hint shown for `fest` (the sheet is not used). */
export const SUPPLY_PRICE_FEST_HINT =
  'Bei einem festen Arbeitspreis rechnen wir mit Ihrem all-in-Preis oben – die ' +
  'Bezugspreis-Komponenten werden dann nicht zusätzlich gezählt.';

/** The text values the form starts with: stored sheet, else the suggestions. */
export interface SupplyPriceFormValues {
  netzentgeltArbeitspreisCt: string;
  stromsteuerCt: string;
  konzessionsabgabeCt: string;
  umlagenCt: string;
  vertriebsaufschlagCt: string;
  ustPct: string;
  komponentenStand: string;
}

function numText(v: number | null | undefined): string {
  return v == null ? '' : String(v);
}

/**
 * Initial form values. A site WITHOUT a maintained sheet (`present` false, or a
 * null sheet) prefills the researched suggestions (editable); an existing sheet
 * shows its stored values verbatim (a cleared component stays empty).
 */
export function supplyPriceFormValues(
  sheet: SupplyPrice | null | undefined,
): SupplyPriceFormValues {
  const prefill = !sheet || !sheet.present;
  const comp = (key: SupplyPriceComponentKey, suggestion: number) =>
    prefill ? String(suggestion) : numText(sheet?.[key]);
  return {
    netzentgeltArbeitspreisCt: comp('netzentgeltArbeitspreisCt', 7.6),
    stromsteuerCt: comp('stromsteuerCt', 2.05),
    konzessionsabgabeCt: comp('konzessionsabgabeCt', 1.59),
    umlagenCt: comp('umlagenCt', 2.946),
    vertriebsaufschlagCt: comp('vertriebsaufschlagCt', 1.5),
    ustPct: prefill ? String(SUPPLY_PRICE_UST_SUGGESTION) : numText(sheet?.ustPct),
    komponentenStand: prefill ? '' : sheet?.komponentenStand ?? '',
  };
}

/**
 * Parse one numeric field: '' -> null (clear/unknown), a valid number (comma or
 * dot) -> that value, anything else -> undefined (a validation error).
 */
export function parseSupplyPriceNumber(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The running Σ of the currently entered components (ct/kWh netto), for the hint. */
export function supplyPriceComponentsSumCt(
  values: SupplyPriceFormValues,
): number {
  return SUPPLY_PRICE_FIELDS.reduce((sum, f) => {
    const n = parseSupplyPriceNumber(values[f.key]);
    return sum + (typeof n === 'number' ? n : 0);
  }, 0);
}

/**
 * Build the PATCH body from the form values, or a German error string. Every
 * component field is sent (so an emptied field CLEARS it); `ustPct` is sent only
 * when a valid non-empty value is present (it is NOT NULL server-side);
 * `komponentenStand` is sent as an ISO date or null when cleared.
 */
export function buildSupplyPricePatch(
  values: SupplyPriceFormValues,
): { patch: SupplyPriceUpdate } | { error: string } {
  const patch: SupplyPriceUpdate = {};
  for (const f of SUPPLY_PRICE_FIELDS) {
    const n = parseSupplyPriceNumber(values[f.key]);
    if (n === undefined) {
      return {
        error: `Bitte geben Sie „${f.label}" als Zahl in ct/kWh an (oder leer lassen).`,
      };
    }
    patch[f.key] = n;
  }
  const ustText = values.ustPct.trim();
  if (ustText !== '') {
    const ust = Number(ustText.replace(',', '.'));
    if (!Number.isFinite(ust) || ust < 0 || ust > 100) {
      return { error: 'Der USt-Satz muss eine Zahl zwischen 0 und 100 sein.' };
    }
    patch.ustPct = ust;
  }
  const stand = values.komponentenStand.trim();
  patch.komponentenStand = stand === '' ? null : stand;
  return { patch };
}
