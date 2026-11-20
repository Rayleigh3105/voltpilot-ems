package messwerte

import (
	"math"
	"regexp"
	"strings"
)

// OCPP MeterValues reach the library from the core (the box's own CSMS), not
// from a poll: one sampled value becomes one sample of the catalog point its
// measurand, context, format, phase, location and unit name. The twin of
// ocppPointKey/decodeOcppSampledValue in measurement-driver.js.

// SampledValue is one OCPP 1.6 SampledValue as the core forwards it.
type SampledValue struct {
	Value     any    `json:"value"`
	Measurand string `json:"measurand"`
	Context   string `json:"context"`
	Format    string `json:"format"`
	Phase     string `json:"phase"`
	Location  string `json:"location"`
	Unit      string `json:"unit"`
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func ocppSlug(v string) string {
	if v == "" {
		v = "none"
	}
	s := slugRe.ReplaceAllString(strings.ToLower(v), "-")
	return strings.TrimSuffix(strings.TrimPrefix(s, "-"), "-")
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// OcppPointKey is the catalog key of a sampled value.
func OcppPointKey(v SampledValue) string {
	return "ocpp.1_6.metervalues." + strings.ToLower(orDefault(v.Measurand, "Energy.Active.Import.Register")) +
		".context[" + ocppSlug(orDefault(v.Context, "Sample.Periodic")) + "].format[" + ocppSlug(orDefault(v.Format, "Raw")) +
		"].phase[" + ocppSlug(orDefault(v.Phase, "none")) + "].location[" + ocppSlug(orDefault(v.Location, "Outlet")) +
		"].unit[" + ocppSlug(orDefault(v.Unit, "none")) + "]"
}

// DecodeOcppSampledValue is one sample, nil when the catalog has no such
// point or the value is not a decimal string (a number that lost its digits
// to float64 is no raw value). SignedData stays a signature, never a number.
func (k *Katalog) DecodeOcppSampledValue(v SampledValue) *Sample {
	key := OcppPointKey(v)
	if p, _ := k.ResolvePoint(key, nil, nil); p == nil {
		return nil
	}
	out := &Sample{PointKey: key, Quality: "good"}
	switch raw := v.Value.(type) {
	case string:
		out.Raw = raw
	case float64:
		if raw == math.Trunc(raw) && math.Abs(raw) > 9007199254740991 {
			return nil
		}
		out.Raw = raw
	default:
		return nil
	}
	if orDefault(v.Format, "Raw") == "SignedData" {
		out.SignedData, out.SignedDataFormat = jsString(out.Raw), "OCPP1.6/SignedData"
		return out
	}
	n := jsNumber(out.Raw)
	if !math.IsNaN(n) && !math.IsInf(n, 0) && (n != math.Trunc(n) || math.Abs(n) <= 9007199254740991) {
		out.Decoded, out.HatDecoded = n, true
	}
	return out
}
