// The cockpit lead-slot switch. Every Anlage renders the SAME block set; only
// which artifact fills the LEAD slot varies.
//
// U4 originally shipped a binary form (AE7 emphasis → Peak-Band | money) for
// the (now removed, Captain-Nachtrag 06.08.2026) v1 zone-dashboard path.
// M3 ("Projektion" #531, report `data/vp-anlagen-face-k9/report.md` §1.3)
// evolved it to **N-ary over the M0 module stack**: the lead is simply the
// FIRST block of the deterministic §1.3 order that this Anlage actually has —
//
//   Peak-Band            (iff the Lastspitzenkappung mode is active)
//   → Erlös-Komposition  (iff ≥1 money mode contributes a stream)
//   → Energiefluss-Hub   (base — a pure private/flow Anlage leads with the hub)
//
// i.e. **peak → money → flow**, exactly the rule the report names. It is a pure
// function of the M0 read-model (`cockpitBlocks(base, modes)`), never of a
// re-derived profile: a mode being active IS the emphasis (report §1.1), so no
// argmax and no emphasis raster is consulted any more. This is now the ONLY
// lead rule - the binary v1 form (`leadArtifact`) was removed with the v1
// render path it served.

import type { CockpitBlock, CockpitBlockId } from './surface';

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
  // Das Ladebudget führt NUR, wenn es sonst nichts zu führen gibt - also auf
  // der reinen Ladepark-Anlage, die gar keinen Energiefluss-Block bekommt
  // (`surface.ts` isLadeparkOnly). Auf einer Misch-Anlage bleibt der Fluss der
  // Held und das Band wird zur Wächter-Kachel (Mockups §2 Entscheidung 1).
  'lade-budget',
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
