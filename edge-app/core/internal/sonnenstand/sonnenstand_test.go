package sonnenstand

// Shared vectors against the Python twin (services/forecast/
// voltpilot_forecast/solar.py), generated with:
//
//	python3 -c "
//	from datetime import datetime, timezone
//	from voltpilot_forecast.domain import GeoLocation
//	from voltpilot_forecast.solar import solar_position
//	loc = GeoLocation(latitude=52.52, longitude=13.405)
//	print(solar_position(loc, datetime(2026,6,21,10,30,0,tzinfo=timezone.utc)).elevation_deg)
//	"
//
// run from services/forecast. A regression here that the Python twin does
// not share is a divergence, never an "improvement" to fix quietly.

import (
	"math"
	"testing"
	"time"
)

func TestElevationMatchesThePythonTwin(t *testing.T) {
	utc := func(y int, m time.Month, d, hh, mm, ss int) time.Time {
		return time.Date(y, m, d, hh, mm, ss, 0, time.UTC)
	}
	cases := []struct {
		name             string
		lat, lon         float64
		when             time.Time
		wantElevationDeg float64
	}{
		{"Berlin Sommersonnenwende 10:30 UTC", 52.52, 13.405, utc(2026, time.June, 21, 10, 30, 0), 60.055223982708014},
		{"Berlin Wintersonnenwende Mittag UTC", 52.52, 13.405, utc(2026, time.December, 21, 12, 0, 0), 13.08976985310855},
		{"Berlin Mitternacht UTC", 52.52, 13.405, utc(2026, time.June, 21, 0, 0, 0), -13.175857919900722},
		{"München Tagundnachtgleiche 11:00 UTC", 48.137, 11.576, utc(2026, time.March, 20, 11, 0, 0), 41.15399980957244},
		{"Sydney Sommersonnenwende Südhalbkugel", -33.87, 151.21, utc(2026, time.June, 21, 2, 0, 0), 32.675054104293466},
		{"Äquator Tagundnachtgleiche Mittag", 0.0, 0.0, utc(2026, time.March, 20, 12, 0, 0), 87.90757572643605},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Elevation(c.lat, c.lon, c.when)
			if math.Abs(got-c.wantElevationDeg) > 1e-9 {
				t.Fatalf("Elevation() = %v, want %v (Python twin)", got, c.wantElevationDeg)
			}
		})
	}
}

// A local time is converted to UTC first, exactly like the Python twin's
// ensure_utc - the same instant must answer the same elevation regardless
// of the zone it arrives in.
func TestElevationNormalizesToUTC(t *testing.T) {
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Skip("tzdata unavailable in this environment")
	}
	utcWhen := time.Date(2026, time.June, 21, 10, 30, 0, 0, time.UTC)
	localWhen := utcWhen.In(berlin)
	got := Elevation(52.52, 13.405, localWhen)
	want := Elevation(52.52, 13.405, utcWhen)
	if got != want {
		t.Fatalf("Elevation(local) = %v, Elevation(utc) = %v, want equal", got, want)
	}
}

// The sun stays within [-90, 90] everywhere - a clamp failure at the poles
// at midnight/noon on a solstice would show up as NaN or an out-of-range
// value, never silently.
func TestElevationStaysInRange(t *testing.T) {
	when := time.Date(2026, time.June, 21, 0, 0, 0, 0, time.UTC)
	for _, lat := range []float64{-90, -66.5, 0, 66.5, 90} {
		got := Elevation(lat, 0, when)
		if math.IsNaN(got) || got < -90 || got > 90 {
			t.Fatalf("Elevation(%v, 0, ...) = %v, out of [-90, 90]", lat, got)
		}
	}
}
