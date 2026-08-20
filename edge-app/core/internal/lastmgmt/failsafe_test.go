package lastmgmt

import "testing"

// TestSafeDefaultIsTheMockupsArithmetic: the Ausfall-Schutz number the
// customer is shown must be the one the box actually deposits, and it must
// hold when EVERY connector runs it at the same time on top of the worst
// building load (Mockups §2.7: "6 × 15 kW + 180 kW = 270 < 277 ✓").
func TestSafeDefaultIsTheMockupsArithmetic(t *testing.T) {
	got := DeriveSafeDefault(277, 180, 6)
	if !got.Computable {
		t.Fatalf("not computable: %+v", got)
	}
	near(t, "per connector", got.PerConnectorKw, 16.166) // floor((277-180)/6)
	near(t, "worst case", got.WorstCaseKw, 276.996)
	if !got.Holds {
		t.Fatalf("the derivation must hold by construction: %+v", got)
	}
	if got.WorstCaseKw > got.GridLimitKw+1e-6 {
		t.Fatalf("worst case %v exceeds the connection limit %v", got.WorstCaseKw, got.GridLimitKw)
	}
}

// TestSafeDefaultHoldsForEveryPlausibleSite: the invariant, swept - the
// emergency default can never, for any input, add up beyond the connection.
func TestSafeDefaultHoldsForEveryPlausibleSite(t *testing.T) {
	for _, limit := range []float64{11, 22, 63, 100, 277, 400, 1000} {
		for _, house := range []float64{0, 5, 50, 180, 399, 1200} {
			for _, n := range []int{1, 2, 6, 12, 48} {
				got := DeriveSafeDefault(limit, house, n)
				if !got.Computable {
					t.Fatalf("limit=%v house=%v n=%d: not computable", limit, house, n)
				}
				// The invariant: the emergency defaults of ALL connectors
				// together never claim more than what the building leaves.
				// (On an over-subscribed site - the building alone above the
				// limit - that free power is 0, and so is the default.)
				free := limit - house
				if free < 0 {
					free = 0
				}
				if got.PerConnectorKw*float64(n) > free+1e-9 {
					t.Fatalf("limit=%v house=%v n=%d: %d × %v kW exceeds the free %v kW",
						limit, house, n, n, got.PerConnectorKw, free)
				}
				if got.PerConnectorKw < 0 {
					t.Fatalf("limit=%v house=%v n=%d: negative default %v", limit, house, n, got.PerConnectorKw)
				}
			}
		}
	}
}

// TestSafeDefaultRefusesToInventANumber: a fabricated emergency limit would be
// a promise about a customer's fuse.
func TestSafeDefaultRefusesToInventANumber(t *testing.T) {
	for _, tc := range []struct {
		name         string
		limit, house float64
		connectors   int
	}{
		{"no connector known yet", 277, 180, 0},
		{"no connection limit configured", 0, 180, 6},
		{"an implausible house load", 277, -1, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := DeriveSafeDefault(tc.limit, tc.house, tc.connectors)
			if got.Computable {
				t.Fatalf("claimed computable: %+v", got)
			}
			if got.PerConnectorKw != 0 {
				t.Fatalf("invented %v kW", got.PerConnectorKw)
			}
			if got.Reason == "" {
				t.Fatal("refused without saying why")
			}
		})
	}
}

// TestASiteWhoseBuildingEatsTheConnectionGetsZero: 0 kW is the honest answer -
// while the box is silent nothing charges. It is never rounded up to something
// friendlier, and it says why.
func TestASiteWhoseBuildingEatsTheConnectionGetsZero(t *testing.T) {
	got := DeriveSafeDefault(100, 120, 4)
	if !got.Computable {
		t.Fatalf("this IS computable - the answer is just 0: %+v", got)
	}
	near(t, "per connector", got.PerConnectorKw, 0)
	if got.Reason == "" {
		t.Fatal("a zero emergency default without an explanation is a riddle")
	}
	// Holds is FALSE here, and honestly so: the building alone is over the
	// connection. No charging default can repair that, and claiming "holds"
	// would be a comfortable lie about a customer's fuse.
	if got.Holds {
		t.Fatalf("an over-subscribed connection must not report Holds: %+v", got)
	}
}

// TestMindestleistungAndAusfallProfilAreDifferentNumbers is the guard for the
// mockups' §2.8 warning: equating them makes the fallback arithmetic
// impossible on exactly the sites this product exists for.
func TestMindestleistungAndAusfallProfilAreDifferentNumbers(t *testing.T) {
	set := site(167) // 277 kW connection, 30 kW Mindestleistung, 180 kW house
	fs := DeriveSafeDefault(set.GridLimitKw, set.MaxHouseLoadKw, 6)
	if fs.PerConnectorKw >= set.MinPowerKw {
		t.Fatalf("on this site the emergency default (%v kW) is not BELOW the Mindestleistung (%v kW) - "+
			"if they were the same number, 6 × 30 + 180 = 360 kW would blow a 277 kW connection",
			fs.PerConnectorKw, set.MinPowerKw)
	}
	// And the proof of the counterfactual: using the Mindestleistung as the
	// emergency default really does overshoot.
	if set.MinPowerKw*6+set.MaxHouseLoadKw <= set.GridLimitKw {
		t.Fatal("the counterfactual no longer bites - pick a site where it does")
	}
}
