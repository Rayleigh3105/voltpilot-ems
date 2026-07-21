// The cockpit lead-slot switch. Every Anlage renders the SAME block set; only
// which artifact fills the LEAD slot varies.
//
// U4 shipped the binary form (`leadArtifact`, AE7 emphasis → Peak-Band | money).
// M3 ("Projektion" #531, report `data/vp-anlagen-face-k9/report.md` §1.3)
// evolves it to **N-ary over the M0 module stack**: the lead is simply the
// FIRST block of the deterministic §1.3 order that this Anlage actually has —
//
//   Peak-Band            (iff the Lastspitzenkappung mode is active)
//   → Erlös-Komposition  (iff ≥1 money mode contributes a stream)
//   → Energiefluss-Hub   (base — a pure private/flow Anlage leads with the hub)
//
// i.e. **peak → money → flow**, exactly the rule the report names. It is a pure
// function of the M0 read-model (`cockpitBlocks(base, modes)`), never of a
// re-derived profile: a mode being active IS the emphasis (report §1.1), so no
// argmax and no emphasis raster is consulted any more.
//
// `leadArtifact` stays for the v1 path: an un-migrated site has no blocks at
// all, keeps the AE7 emphasis lens and therefore renders byte-identically.

import type { CockpitBlock, CockpitBlockId } from './surface';

/** Which artifact fills the cockpit's lead slot (U4, binary/v1 form). */
export type LeadArtifact = 'peakband' | 'money';

/**
 * Resolve the cockpit lead artifact from the AE7 `emphasis.peak` level. Only a
 * peak-profile site (peak emphasis `prominent`) leads with the Peak-Band;
 * anything else - including null/undefined/unknown - leads with money, so the
 * private and arbitrage faces are byte-identical to today.
 *
 * Still the rule on the **v1 (un-migrated) path**; a projected Anlage uses the
 * N-ary `leadBlock` below.
 */
export function leadArtifact(emphasisPeak: string | null | undefined): LeadArtifact {
  return emphasisPeak === 'prominent' ? 'peakband' : 'money';
}

/**
 * The N-ary lead rule (report §1.3): peak → money → flow. Deliberately derived
 * from the ORDERED block list, so the lead can never disagree with the stack
 * that renders below it, and a future lead-capable block only has to be listed
 * here once.
 */
export const LEAD_CANDIDATES: CockpitBlockId[] = [
  'peak-band',
  'erloes-komposition',
  'energiefluss',
];

/**
 * Which block leads the cockpit of a projected Anlage. Null when the Anlage has
 * no lead-capable block at all — the "Neu / leer" Ausprägung, whose cockpit is
 * the setup path (M5), not a stack.
 */
export function leadBlock(blocks: CockpitBlock[] | null | undefined): CockpitBlockId | null {
  const present = new Set((blocks ?? []).map((b) => b.id));
  return LEAD_CANDIDATES.find((id) => present.has(id)) ?? null;
}
