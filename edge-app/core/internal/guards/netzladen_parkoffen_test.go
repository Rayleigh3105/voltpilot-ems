package guards

// AP-15 Folge (one headroom given out once, import side): ParkOffen only
// ever lowers the battery's ceiling (V5) - never below 0, never above the
// ceiling without it, and while it holds never above the measured charge.

import (
	"math/rand"
	"testing"
)

func TestEigenschaftParkOffenSenktNur(t *testing.T) {
	rng := rand.New(rand.NewSource(1055))
	gehalten := 0
	for i := 0; i < 20000; i++ {
		in := Netzladen{Fuehrt: rng.Intn(4) > 0, Fresh: rng.Intn(4) > 0, Limit: rng.Intn(4) > 0,
			PlanableKw: rng.Float64() * 500, GridKw: rng.Float64()*600 - 100, BattChargeKw: rng.Float64() * 120,
			ReservedKw: rng.Float64() * 80, PvKw: rng.Float64() * 100}
		if rng.Intn(5) == 0 {
			in.PvKw = Unknown()
		}
		heute := NetzladenDeckelFuer(in)
		in.ParkOffen = true
		d := NetzladenDeckelFuer(in)
		if d.DeckelKw > heute.DeckelKw || d.DeckelKw < 0 || d.Regelt != heute.Regelt {
			t.Fatalf("%+v: ParkOffen %.3f against %.3f", in, d.DeckelKw, heute.DeckelKw)
		}
		if d.Regelt && d.DeckelKw > round3(in.BattChargeKw) {
			t.Fatalf("%+v: held %.3f above the measured charge", in, d.DeckelKw)
		}
		if d.DeckelKw < heute.DeckelKw {
			gehalten++
		}
	}
	if gehalten < 2000 {
		t.Fatalf("ParkOffen held in only %d evaluations", gehalten)
	}
}
