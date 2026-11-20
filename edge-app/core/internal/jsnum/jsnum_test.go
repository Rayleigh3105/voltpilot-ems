package jsnum

import (
	"math"
	"testing"
)

// Wie Node (node -p 'Number(...)') es fuer diese Texte sagt.
func TestStringToNumber(t *testing.T) {
	for in, want := range map[string]float64{
		"": 0, "  ": 0, "12": 12, " 12 ": 12, "\u3000 7\ufeff": 7, "1e3": 1000, ".5": 0.5, "5.": 5, "+5": 5, "-5": -5,
		"0x1A": 26, "0X1a": 26, "0o17": 15, "0b101": 5, "0x10000000000000000": 18446744073709551616,
		"Infinity": math.Inf(1), "-Infinity": math.Inf(-1), "1e400": math.Inf(1),
	} {
		if got := StringToNumber(in); got != want {
			t.Errorf("Number(%q) = %v, erwartet %v", in, got, want)
		}
	}
	for _, in := range []string{"abc", "1_000", "0x", "-0x10", "0xg", "1,5", "inf", "NaN", "0x1p3", "12px"} {
		if got := StringToNumber(in); !math.IsNaN(got) {
			t.Errorf("Number(%q) = %v, erwartet NaN", in, got)
		}
	}
}
