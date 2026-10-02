package plan

// MiSpeL MP-14: the Förderweg (funding route) of the feed-in point travels in
// the plan to the box and replaces the bare net-charge bit as the reason for
// the EEG clamp. The five values and what each means for charging from the
// grid are the contract's (docs/contracts/v2/mispel-foerderweg.md § 1,
// column "Netzladen"; mqtt-schedule.schema.json "foerderweg"):
//
//   - einspeiseverguetung, marktpraemie_ausschliesslichkeit: grid charging is
//     excluded - a storage plant is only funded in the Ausschließlichkeitsoption
//     (§ 19 Abs. 3a EEG), so the box keeps the FK3 clamp (charge <= measured
//     PV) whatever grid_charge_allowed says; the strict reading on top stays
//     the operator's switch (strict_exclusivity, MP-45).
//   - marktpraemie_abgrenzung, marktpraemie_pauschal, ungefoerdert: grid
//     charging is the customer's setting (Festlegung MiSpeL, Tenor Ziff. 1-4,
//     Anlage 1 and 2), carried as grid_charge_allowed; it stays inside the
//     export, § 14a and negative-price guards, which this field never touches.
//
// Fail-safe: no plan, an absent field (old cloud, old retained plan) or a
// value the box does not know keeps the clamp - the box then "lädt
// sicherheitshalber nur mit Sonnenstrom" (BK-14, Variante A).
const (
	FoerderwegEinspeiseverguetung = "einspeiseverguetung"
	FoerderwegAusschliesslichkeit = "marktpraemie_ausschliesslichkeit"
	FoerderwegAbgrenzung          = "marktpraemie_abgrenzung"
	FoerderwegPauschal            = "marktpraemie_pauschal"
	FoerderwegUngefoerdert        = "ungefoerdert"
)

// FoerderwegBekannt reports whether v is one of the contract's five values.
func FoerderwegBekannt(v string) bool {
	switch v {
	case FoerderwegEinspeiseverguetung, FoerderwegAusschliesslichkeit,
		FoerderwegAbgrenzung, FoerderwegPauschal, FoerderwegUngefoerdert:
		return true
	}
	return false
}

// NetzladenZulaessig reports whether the Förderweg leaves grid charging to the
// customer's setting (contract § 1: "Einstellung des Kunden"). Every other
// value - the two EEG routes, an unknown value and the empty string of an
// absent field - excludes it.
func NetzladenZulaessig(foerderweg string) bool {
	switch foerderweg {
	case FoerderwegAbgrenzung, FoerderwegPauschal, FoerderwegUngefoerdert:
		return true
	}
	return false
}

// FoerderwegView is what the box makes of the plan's Förderweg for charging,
// for the row "Förderweg" of the local plan card (BK-14, Variante A) and its
// technical detail: the value as carried, the plan fields behind the decision
// and the decision itself. The page only words it - it never re-derives the
// clamp. Read-only; it never influences execution.
type FoerderwegView struct {
	// Foerderweg is the value as carried; "" = the field is absent.
	Foerderweg string `json:"foerderweg,omitempty"`
	// Bekannt is true for one of the contract's five values.
	Bekannt bool `json:"bekannt"`
	// SolarOnly is the clamp decision (Plan.SolarOnlyCharge): true = the box
	// charges only from the measured PV production.
	SolarOnly bool `json:"solar_only"`
	// The plan fields behind it, echoed for the technical mode.
	GridChargeAllowed  *bool    `json:"grid_charge_allowed,omitempty"`
	StrictExclusivity  bool     `json:"strict_exclusivity"`
	StrictToleranceKwh *float64 `json:"strict_exclusivity_tolerance_kwh,omitempty"`
	GridExportLimitKw  *float64 `json:"grid_export_limit_kw,omitempty"`
}

// FoerderwegView projects the plan's Förderweg and the resulting clamp.
func (p *Plan) FoerderwegView() FoerderwegView {
	v := FoerderwegView{SolarOnly: p.SolarOnlyCharge()}
	if p == nil {
		return v
	}
	v.Foerderweg = p.Foerderweg
	v.Bekannt = FoerderwegBekannt(p.Foerderweg)
	v.GridChargeAllowed = p.GridChargeAllowed
	v.StrictExclusivity = p.StrictExclusivityCharge()
	if v.StrictExclusivity {
		v.StrictToleranceKwh = p.StrictExclusivityToleranceKwh
	}
	v.GridExportLimitKw = p.GridExportLimitKw
	return v
}
