package lastmgmt

import (
	"strings"
	"testing"
	"time"
)

// obs feeds ONE paired measurement (grid, charging, battery charge).
func obs(tr *BudgetTracker, ts time.Time, grid, charging, batt float64) {
	tr.ObserveM(ts, Measurement{
		GridKw: grid, ChargingKw: charging,
		BatteryChargeKw: batt, HaveBattery: true, Complete: true,
	})
}

// TestFastChargingHasNoSourceCapAtAll is the byte-for-byte promise of the
// customer who did not ask for surplus charging.
func TestFastChargingHasNoSourceCapAtAll(t *testing.T) {
	tr := NewBudgetTracker()
	obs(tr, t0, -40, 0, 0)
	v := tr.Surplus(t0, PolicyFast, StorageBeforeCars)
	if v.Active {
		t.Fatal("„Schnell laden\" must not cap the source at all")
	}
	if v.Mode != SurplusOff {
		t.Fatalf("mode = %q, want %q", v.Mode, SurplusOff)
	}
	if !strings.Contains(v.Reason, "Anschlussgrenze") {
		t.Fatalf("the sentence must still name the limit that DOES hold: %q", v.Reason)
	}
}

// TestTheSurplusIsWhatTheSiteWouldOtherwiseExport pins the whole derivation:
// it is the budget tracker's own `rest`, negated.
func TestTheSurplusIsWhatTheSiteWouldOtherwiseExport(t *testing.T) {
	tr := NewBudgetTracker()
	// PV covers the building and 40 kW of charging, and 25 kW still leave the
	// site: grid = -25, charging = 40 -> rest = -65 -> surplus 65 kW.
	obs(tr, t0, -25, 40, 0)
	v := tr.Surplus(t0, PolicySolarOnly, StorageBeforeCars)
	if !v.Active || v.Mode != SurplusMeasured {
		t.Fatalf("mode = %q active=%v", v.Mode, v.Active)
	}
	near(t, "surplus", v.Kw, 65)
	if v.Blind {
		t.Fatal("a fresh measurement is not blind")
	}
	if !strings.Contains(v.Reason, "65,0") {
		t.Fatalf("the sentence must carry the number: %q", v.Reason)
	}
}

// TestImportingSiteOffersNoSurplus - a site that draws from the grid has none,
// and the sentence says so instead of quoting a zero.
func TestImportingSiteOffersNoSurplus(t *testing.T) {
	tr := NewBudgetTracker()
	obs(tr, t0, 30, 10, 0)
	v := tr.Surplus(t0, PolicySolarOnly, StorageBeforeCars)
	if !v.Active || v.Kw != 0 {
		t.Fatalf("surplus = %v, want 0", v.Kw)
	}
	if !strings.Contains(v.Reason, "kein Sonnenüberschuss") {
		t.Fatalf("reason = %q", v.Reason)
	}
}

// TestTheStoragePriorityIsOneSubtractionOfOneMeasuredQuantity is the
// arbitration: S is the WHOLE surplus, and the choice decides who takes it.
func TestTheStoragePriorityIsOneSubtractionOfOneMeasuredQuantity(t *testing.T) {
	tr := NewBudgetTracker()
	// PV 60, building 10, battery charging 20, cars 0 -> grid = 10+20-60 = -30.
	obs(tr, t0, -30, 0, 20)

	storage := tr.Surplus(t0, PolicySolarOnly, StorageBeforeCars)
	near(t, "storage-first cars", storage.Kw, 30) // what is left after the battery
	cars := tr.Surplus(t0, PolicySolarOnly, CarsBeforeStorage)
	near(t, "cars-first cars", cars.Kw, 50) // the battery's share handed over

	if storage.TotalKw == nil || *storage.TotalKw != 50 {
		t.Fatalf("S must be independent of the split: %v", storage.TotalKw)
	}
	if cars.BatteryKw == nil || *cars.BatteryKw != 20 {
		t.Fatalf("the measured battery charge must travel: %v", cars.BatteryKw)
	}
	if !strings.Contains(cars.Reason, "vor dem Speicher") {
		t.Fatalf("the cars-first sentence must name the customer's choice: %q", cars.Reason)
	}
	if !strings.Contains(storage.Reason, "Ihre Priorität") {
		t.Fatalf("every sentence names the priority it acted on: %q", storage.Reason)
	}
}

// TestBlindFailsInOppositeDirectionsPerPolicy is the honesty rule of the file.
func TestBlindFailsInOppositeDirectionsPerPolicy(t *testing.T) {
	tr := NewBudgetTracker()
	obs(tr, t0, -40, 0, 0)
	late := t0.Add(BudgetFreshWindow + time.Second)

	strict := tr.Surplus(late, PolicySolarOnly, StorageBeforeCars)
	if !strict.Active || strict.Kw != 0 || !strict.Blind {
		t.Fatalf("„Nur Sonnenstrom\" must pause when it cannot prove a surplus: %+v", strict)
	}
	if !strings.Contains(strict.Reason, "nicht geladen") {
		t.Fatalf("reason = %q", strict.Reason)
	}

	soft := tr.Surplus(late, PolicySolarFirst, StorageBeforeCars)
	if soft.Active {
		t.Fatal("„Sonne zuerst\" must not throttle a fleet on a meter hiccup")
	}
	if !soft.Blind || !strings.Contains(soft.Reason, "Anschlussgrenze") {
		t.Fatalf("reason = %q", soft.Reason)
	}
}

// TestNeverMeasuredBehavesLikeBlind - a site with no meter at all is the same
// question, and the answers must not differ.
func TestNeverMeasuredBehavesLikeBlind(t *testing.T) {
	tr := NewBudgetTracker()
	if v := tr.Surplus(t0, PolicySolarOnly, StorageBeforeCars); !v.Active || v.Kw != 0 {
		t.Fatalf("strict without a meter: %+v", v)
	}
	if v := tr.Surplus(t0, PolicySolarFirst, StorageBeforeCars); v.Active {
		t.Fatal("soft without a meter must not cap")
	}
}

// TestSonneZuerstAllowsTheMinimum is what distinguishes the two active
// policies without a plan.
func TestSonneZuerstAllowsTheMinimum(t *testing.T) {
	tr := NewBudgetTracker()
	obs(tr, t0, -5, 0, 0)
	if v := tr.Surplus(t0, PolicySolarFirst, StorageBeforeCars); !v.AllowMinimum {
		t.Fatal("„Sonne zuerst\" keeps a running vehicle alive")
	}
	if v := tr.Surplus(t0, PolicySolarOnly, StorageBeforeCars); v.AllowMinimum {
		t.Fatal("„Nur Sonnenstrom\" never buys grid power")
	}
}

// TestTheUntouchedDefaultIsNoSourceLaneAtAll is the compatibility promise of
// the whole Stufe: a customer who never opened the card sees no change, and an
// unreadable word invents neither a restriction nor a promise.
func TestTheUntouchedDefaultIsNoSourceLaneAtAll(t *testing.T) {
	if got := NormalizePolicy(""); got != PolicyFast {
		t.Fatalf("an untouched site must have no source cap, got %q", got)
	}
	if got := NormalizePolicy("hoffentlich"); got != PolicyFast {
		t.Fatalf("policy = %q", got)
	}
	if got := NormalizeStorage("irgendwas"); got != StorageBeforeCars {
		t.Fatalf("storage = %q", got)
	}
	tr := NewBudgetTracker()
	obs(tr, t0, -40, 0, 0)
	if v := tr.Surplus(t0, "", StorageBeforeCars); v.Active {
		t.Fatalf("an untouched site must not be capped by a lane it never chose: %+v", v)
	}
}

// TestTheSmoothingIsConservativeForTheSurplusToo - the trailing MAXIMUM of the
// rest is the MINIMUM of the surplus, so one window serves both jobs.
func TestTheSmoothingIsConservativeForTheSurplusToo(t *testing.T) {
	tr := NewBudgetTracker()
	obs(tr, t0, -10, 0, 0)                     // 10 kW surplus
	obs(tr, t0.Add(10*time.Second), -60, 0, 0) // a sunny burst: 60 kW
	v := tr.Surplus(t0.Add(10*time.Second), PolicySolarOnly, StorageBeforeCars)
	near(t, "surplus", v.Kw, 10) // the smaller one is what we promise
}

// TestStorageChargeCapIsTheOtherHalfOfCarsFirst - without it the choice would
// be a wish rather than a rule.
func TestStorageChargeCapIsTheOtherHalfOfCarsFirst(t *testing.T) {
	tr := NewBudgetTracker()
	// S = 50 kW (see above), cars are measured drawing 30.
	obs(tr, t0, -30, 0, 20)

	kw, ok := tr.StorageChargeCap(t0, PolicySolarOnly, CarsBeforeStorage, 30)
	if !ok {
		t.Fatal("cars-first with a measured surplus must cap the battery")
	}
	near(t, "battery cap", kw, 20)

	if _, ok := tr.StorageChargeCap(t0, PolicySolarOnly, StorageBeforeCars, 30); ok {
		t.Fatal("storage-first must never touch the battery")
	}
	if _, ok := tr.StorageChargeCap(t0, PolicyFast, CarsBeforeStorage, 30); ok {
		t.Fatal("„Schnell laden\" makes no statement about the source, so none about the battery")
	}
	if _, ok := tr.StorageChargeCap(t0, PolicySolarOnly, CarsBeforeStorage, 0); ok {
		t.Fatal("no vehicle drawing = nothing to take from the battery")
	}
	late := t0.Add(BudgetFreshWindow + time.Second)
	if _, ok := tr.StorageChargeCap(late, PolicySolarOnly, CarsBeforeStorage, 30); ok {
		t.Fatal("a blind cap would be a guess about a customer's storage")
	}
}

// TestABatterylessSiteIsUnaffected - the third channel is optional, and
// without it the two priorities collapse into the measured status quo.
func TestABatterylessSiteIsUnaffected(t *testing.T) {
	tr := NewBudgetTracker()
	tr.Observe(t0, -30, 0, true) // the Stufe-2 signature, no battery
	storage := tr.Surplus(t0, PolicySolarOnly, StorageBeforeCars)
	cars := tr.Surplus(t0, PolicySolarOnly, CarsBeforeStorage)
	near(t, "storage-first", storage.Kw, 30)
	near(t, "cars-first", cars.Kw, 30)
	if storage.BatteryKw != nil {
		t.Fatal("a site that reported no battery must not carry one")
	}
}
