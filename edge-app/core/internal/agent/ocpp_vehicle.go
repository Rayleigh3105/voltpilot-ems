package agent

import "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"

// Fahrzeug-Profile (Verbrauchsmanagement v1 / P7): at the same charge point one
// card may charge straight away while another waits for the sun.
//
// THE WHOLE FEATURE IS ONE OVERRIDE ON ONE SESSION, and that is why it needs no
// new rule in the allocator. `lastmgmt.Session.Source`/`MinKw` were already
// per-SESSION fields, and every rule downstream asks the SESSION, not the
// station: sessionPolicy, splitExempt, allowsMinimum, effectiveMin. The station
// is merely what `ocppSessions` copies in by default. Swapping that default for
// the card's own choice therefore changes nothing about budget, rotation,
// minimum concession, deadman or the K3 bridge - they all keep binding exactly
// as before, one line further down.
//
// ⚠ THE KEY IS THE BOX'S OWN PSEUDONYM. `csms.Session.TagRef` is minted once at
// StartTransaction from the box's privacy key; the plaintext idTag never leaves
// the csms package, and the cloud can only ever repeat the pseudonym the
// heartbeat told it. A profile keyed on the OCPP journal's cloud-side reference
// (which is re-HMACed with a cloud pepper) would never match anything - the two
// pseudonym spaces are deliberately separate.
//
// ⚠ A session WITHOUT a card keeps the station's lane. There is no fallback
// profile and no "default vehicle": an unknown card is a customer who has not
// decided, and deciding for them is exactly what this feature must not do.

// ocppApplyVehicleProfiles replaces the source lane of every session whose card
// carries a profile. It is restrict-free by construction - it swaps ONE
// economy for another and touches no physical bound.
func ocppApplyVehicleProfiles(sessions []lastmgmt.Session, byKey map[string]ocppClaim,
	profiles []lastmgmt.VehicleProfile) {
	if len(sessions) == 0 || len(profiles) == 0 {
		return
	}
	byTag := make(map[string]lastmgmt.VehicleProfile, len(profiles))
	for _, p := range profiles {
		if p.TagRef == "" || p.Source == "" {
			// A profile without a card or without a source says nothing. The
			// parser already drops both; this is the belt for a caller that
			// built the list some other way.
			continue
		}
		if _, dup := byTag[p.TagRef]; dup {
			// First wins - a duplicate is a document defect, and picking the
			// later one would make the outcome depend on list order.
			continue
		}
		byTag[p.TagRef] = p
	}
	if len(byTag) == 0 {
		return
	}
	for i := range sessions {
		claim, ok := byKey[sessions[i].Key]
		if !ok || claim.tagRef == "" {
			continue
		}
		p, ok := byTag[claim.tagRef]
		if !ok {
			continue
		}
		sessions[i].Source = p.Source
		// ⚠ Only a profile that NAMES a minimum overrides the station's: 0 is
		// „das Profil äußert sich nicht", and overwriting a station's floor
		// with it would silently take a real minimum away.
		if p.MinKw > 0 {
			sessions[i].MinKw = p.MinKw
		}
	}
}
