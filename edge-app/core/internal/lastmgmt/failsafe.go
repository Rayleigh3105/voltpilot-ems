package lastmgmt

import "math"

// This file holds the AUSFALL-PROFIL arithmetic — the second of the two power
// figures the mockups insist on keeping apart (Mockups §2.7/§2.8, a product
// detail the w4 concept did not yet fix, so it is written down here where it
// can be tested rather than left to whoever writes the executor).
//
// The idea is the OCPP-native dead man's switch (Konzept §3.1): every station
// permanently stores a TxDefaultProfile. The box's live allocation rides a
// TxProfile with a short duration, refreshed every few seconds. If the box
// dies, the TxProfile expires and each station falls back to its stored
// default ON ITS OWN — nothing of ours has to work for that.
//
// Which makes the default a number with a HARD requirement: every connector on
// site may run it AT THE SAME TIME, on top of the worst building load ever
// seen, and the connection must still hold.
//
//	SafeDefaultKw = (GridLimitKw − MaxHouseLoadKw) ÷ Steckerzahl
//
// ⚠ This is why the Mindestleistung must NOT be reused here. The minimum is
// "below this a car does not charge at all" (tens of kW on a DC park); the
// default is "slower is fine, a blown fuse is not". Equating them makes the
// arithmetic impossible on any site whose stations together out-rate the
// connection — which is every site this product exists for.

// SafeDefault is the derived per-connector emergency limit, WITH the terms it
// was derived from, so a surface can show the customer the arithmetic instead
// of a bare number ("6 × 15 kW + 180 kW = 270 kW < 277 kW ✓").
type SafeDefault struct {
	// PerConnectorKw is what each station gets as its TxDefaultProfile.
	PerConnectorKw float64 `json:"per_connector_kw"`
	// Connectors is the number the division used.
	Connectors int `json:"connectors"`
	// GridLimitKw / MaxHouseLoadKw are the terms.
	GridLimitKw    float64 `json:"grid_limit_kw"`
	MaxHouseLoadKw float64 `json:"max_house_load_kw"`
	// WorstCaseKw is Connectors×PerConnectorKw + MaxHouseLoadKw — the number
	// that must stay under GridLimitKw.
	WorstCaseKw float64 `json:"worst_case_kw"`
	// Holds reports whether WorstCaseKw <= GridLimitKw.
	//
	// The derivation itself can never overshoot (see the floor rounding in
	// DeriveSafeDefault), so a false here on a COMPUTABLE result means one
	// thing only: the building's own worst load already exceeds the connection.
	// That is a site fact no charging default can repair, and saying "holds"
	// would be a comfortable lie about a customer's fuse.
	Holds bool `json:"holds"`
	// Computable is false when there is nothing to derive from — then
	// PerConnectorKw is 0 and Reason says why. A fabricated default is the one
	// thing that must never happen here: it would be a promise about a
	// customer's fuse.
	Computable bool   `json:"computable"`
	Reason     string `json:"reason,omitempty"`
}

// DeriveSafeDefault computes the emergency per-connector limit.
//
// A zero result is a legitimate, honest answer: on a site whose building alone
// can eat the connection there is no share left, and the correct emergency
// behaviour is "do not charge while the box is silent". It is never rounded up
// to something friendlier.
func DeriveSafeDefault(gridLimitKw, maxHouseLoadKw float64, connectors int) SafeDefault {
	out := SafeDefault{
		Connectors:     connectors,
		GridLimitKw:    round3(gridLimitKw),
		MaxHouseLoadKw: round3(maxHouseLoadKw),
	}
	switch {
	case connectors <= 0:
		out.Reason = "Es ist noch kein Stecker bekannt — das Sicherheitsprofil wird berechnet, sobald sich eine Ladesäule gemeldet hat."
		return out
	case gridLimitKw <= 0 || math.IsNaN(gridLimitKw) || math.IsInf(gridLimitKw, 0):
		out.Reason = "Ohne hinterlegte Anschlussgrenze lässt sich kein Sicherheitsprofil berechnen."
		return out
	case maxHouseLoadKw < 0 || math.IsNaN(maxHouseLoadKw) || math.IsInf(maxHouseLoadKw, 0):
		out.Reason = "Die höchste bekannte Gebäudelast ist nicht plausibel."
		return out
	}
	free := gridLimitKw - maxHouseLoadKw
	if free < 0 {
		free = 0
	}
	// ⚠ FLOOR, never round-to-nearest. Rounding UP would make
	// connectors × per exceed the free power by a hair — and this is the ONE
	// number that must hold by construction, on every site, for every
	// connector count. Found by the sweep test, not by reading the formula:
	// 277 kW over 6 connectors rounded to 16.167 kW, whose sixfold is 277.002.
	per := floor3(free / float64(connectors))
	out.Computable = true
	out.PerConnectorKw = per
	out.WorstCaseKw = round3(per*float64(connectors) + maxHouseLoadKw)
	// The invariant, asserted where it is produced rather than only in a test.
	if per > 0 && per*float64(connectors) > free+1e-9 {
		panic("lastmgmt: the safe default overshot the free power - the rounding must floor")
	}
	out.Holds = out.WorstCaseKw <= gridLimitKw+1e-6
	if per == 0 {
		out.Reason = "Die höchste bekannte Gebäudelast schöpft den Anschluss bereits aus — bei einem Ausfall der Box wird nicht geladen."
	}
	return out
}

// floor3 truncates toward zero at three decimals. Used where rounding UP would
// break a safety invariant.
func floor3(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Floor(v*1000) / 1000
}

func round3(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*1000) / 1000
}
