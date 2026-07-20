// U4 - the cockpit lead-slot switch (design vp-ems-ui-overhaul §6 "one NEW
// lead-slot switch"). Every face is the SAME cockpit component tree; only the
// LEAD artifact varies. This is the ONE new mechanism U4 adds on top of the
// AE7 emphasis map (usageProfile.ts `emphasisFor`): it decides which artifact
// fills the cockpit's lead slot.
//
//   peak profile (emphasis.peak === 'prominent')  → the Peak-Band (¼-h mean
//                                                    vs. Ziel + PS-4 numbers)
//   everything else                               → the money hero (today's
//                                                    cockpit, byte-identical)
//
// It is a pure, unit-tested function of the AE7 emphasis (the adaptiveLive /
// moneyEmphasis pattern). A null/unknown/undefined emphasis - an un-migrated or
// profile-less site - resolves to the money lead, so those sites render exactly
// as they do today (v1-safe).

/** Which artifact fills the cockpit's lead slot. */
export type LeadArtifact = 'peakband' | 'money';

/**
 * Resolve the cockpit lead artifact from the AE7 `emphasis.peak` level. Only a
 * peak-profile site (peak emphasis `prominent`) leads with the Peak-Band;
 * anything else - including null/undefined/unknown - leads with money, so the
 * private and arbitrage faces are byte-identical to today.
 */
export function leadArtifact(emphasisPeak: string | null | undefined): LeadArtifact {
  return emphasisPeak === 'prominent' ? 'peakband' : 'money';
}
