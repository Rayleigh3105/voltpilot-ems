package lastmgmt

import (
	"testing"
	"time"
)

func ptrF(v float64) *float64 { return &v }
func ptrI(v int) *int         { return &v }

// TestApplyKeepsWhatItIsNotToldAbout: PATCH semantics - a form that saves one
// knob must not reset the rest (the house rule on every settings surface).
func TestApplyKeepsWhatItIsNotToldAbout(t *testing.T) {
	start := site(167)
	got, err := start.Apply(SettingsRequest{MinPowerKw: ptrF(11)})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	near(t, "min", got.MinPowerKw, 11)
	near(t, "grid limit kept", got.GridLimitKw, 277)
	near(t, "house reserve kept", got.HouseReserveKw, 167)
	near(t, "margin kept", got.MarginPct, 10)
	near(t, "max house load kept", got.MaxHouseLoadKw, 180)
	if got.RotationPeriod != 15*time.Minute {
		t.Fatalf("rotation kept = %v", got.RotationPeriod)
	}
	// The receiver is untouched.
	near(t, "receiver untouched", start.MinPowerKw, 30)
}

// TestApplyRefusalsNameTheFieldAndTheLimit: an installer reads these at a
// customer's site with a phone in one hand - "ungültig" is not an answer.
func TestApplyRefusalsNameTheFieldAndTheLimit(t *testing.T) {
	cases := []struct {
		name string
		req  SettingsRequest
	}{
		{"negative connection limit", SettingsRequest{GridLimitKw: ptrF(-1)}},
		{"absurd connection limit", SettingsRequest{GridLimitKw: ptrF(1e9)}},
		{"negative house reserve", SettingsRequest{HouseReserveKw: ptrF(-5)}},
		{"margin at 100 percent", SettingsRequest{MarginPct: ptrF(100)}},
		{"negative margin", SettingsRequest{MarginPct: ptrF(-1)}},
		{"negative minimum", SettingsRequest{MinPowerKw: ptrF(-1)}},
		{"rotation below a minute", SettingsRequest{RotationMinutes: ptrI(0)}},
		{"rotation beyond four hours", SettingsRequest{RotationMinutes: ptrI(1000)}},
		{"negative house load", SettingsRequest{MaxHouseLoadKw: ptrF(-2)}},
		{"the building reserved beyond the connection", SettingsRequest{HouseReserveKw: ptrF(400)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := site(167)
			_, err := before.Apply(tc.req)
			if err == nil {
				t.Fatal("accepted")
			}
			ve, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("want a German ValidationError, got %T", err)
			}
			if len(ve.Msg) < 20 {
				t.Fatalf("refusal too terse to act on: %q", ve.Msg)
			}
		})
	}
}

// TestSettingsRoundTrip: the settings survive a restart, and a box nobody
// configured reports the honest state (no budget -> nothing charges).
func TestSettingsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := NewStore(dir)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	got, ok, err := st.Load()
	if err != nil || ok {
		t.Fatalf("fresh store: ok=%v err=%v", ok, err)
	}
	near(t, "unconfigured budget", got.BudgetKw(), 0)
	if got.RotationPeriod != DefaultRotationPeriod || got.MarginPct != DefaultMarginPct {
		t.Fatalf("defaults not applied: %+v", got)
	}

	if err := st.Save(site(167)); err != nil {
		t.Fatalf("save: %v", err)
	}
	st2, _ := NewStore(dir)
	back, ok2, err := st2.Load()
	if err != nil || !ok2 {
		t.Fatalf("reload: ok=%v err=%v", ok2, err)
	}
	near(t, "grid limit", back.GridLimitKw, 277)
	near(t, "house reserve", back.HouseReserveKw, 167)
	near(t, "margin", back.MarginPct, 10)
	near(t, "min power", back.MinPowerKw, 30)
	near(t, "max house load", back.MaxHouseLoadKw, 180)
	if back.RotationPeriod != 15*time.Minute {
		t.Fatalf("rotation = %v", back.RotationPeriod)
	}
	near(t, "budget survives", back.BudgetKw(), 82.3)
}
