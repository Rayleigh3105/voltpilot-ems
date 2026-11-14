// Package sonnenstand gives the box a reading the Go core could not make
// before (Steuerlogik-Konzept Stufe 1, report.md §9/§15.7: "Sonnenstand -
// Voraussetzung, heute nicht möglich... eine kleine Go-Funktion mit
// geteilten Vektoren"): the sun's elevation above the horizon for a
// location and instant. The rule language's future "sonne" input (Stufe 2)
// reads this; this stage only makes the value correct and tested.
//
// Line-for-line port of the zenith half of services/forecast/
// voltpilot_forecast/solar.py:49-93 (NOAA/Spencer approximation) - never
// re-derived from the formula's description, so the box and the forecast
// service agree to the bit. Azimuth is NOT ported: the report cites exactly
// solar.py:26-49, the SolarPosition type and the zenith computation: a
// single horizon angle is all "Sonnenstand" needs here.
package sonnenstand

import (
	"math"
	"time"
)

// Elevation returns the sun's elevation in degrees above the horizon
// (negative = below) for a WGS84 location (degrees; longitude
// east-positive) at the given instant. when is converted to UTC first, like
// the Python twin's ensure_utc.
func Elevation(latitudeDeg, longitudeDeg float64, when time.Time) float64 {
	when = when.UTC()
	dayOfYear := float64(when.YearDay())
	hour := float64(when.Hour()) + float64(when.Minute())/60.0 + float64(when.Second())/3600.0

	gamma := 2.0 * math.Pi / 365.0 * (dayOfYear - 1 + (hour-12.0)/24.0)

	eqtime := 229.18 * (0.000075 +
		0.001868*math.Cos(gamma) -
		0.032077*math.Sin(gamma) -
		0.014615*math.Cos(2*gamma) -
		0.040849*math.Sin(2*gamma))
	decl := 0.006918 -
		0.399912*math.Cos(gamma) +
		0.070257*math.Sin(gamma) -
		0.006758*math.Cos(2*gamma) +
		0.000907*math.Sin(2*gamma) -
		0.002697*math.Cos(3*gamma) +
		0.001480*math.Sin(3*gamma)

	timeOffset := eqtime + 4.0*longitudeDeg
	trueSolarTime := hour*60.0 + timeOffset
	hourAngle := trueSolarTime/4.0 - 180.0
	haRad := hourAngle * math.Pi / 180.0

	latRad := latitudeDeg * math.Pi / 180.0
	cosZenith := clamp(
		math.Sin(latRad)*math.Sin(decl)+math.Cos(latRad)*math.Cos(decl)*math.Cos(haRad),
		-1.0, 1.0)
	zenithDeg := math.Acos(cosZenith) * 180.0 / math.Pi
	return 90.0 - zenithDeg
}

func clamp(v, low, high float64) float64 {
	return math.Max(low, math.Min(high, v))
}
