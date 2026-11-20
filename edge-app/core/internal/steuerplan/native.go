package steuerplan

import "strings"

// The certificate side of the native self-regulation: the Go twin of
// edge-app/nodered/unplanned-load-native.js. The adapter knows the registers
// and always plans the hand-over; a certificate entry for the EXACT (brand,
// model, firmware) releases it, and only while the bytes it attests still
// match what the adapter plans.

// DeyeRemotePR978Firmware is the firmware condition of the Deye pilot: the
// device's own answer (the probed PR-978 layout), never an operator string.
const DeyeRemotePR978Firmware = "remote-pr978"

// nativeCapabilityForIntent maps an intent onto the capability word that
// releases it (K4b vocabulary).
var nativeCapabilityForIntent = map[string]string{
	"cover_load":       "native_charge_block_discharge_auto",
	"surplus_charge":   "native_surplus_charge",
	"self_consumption": "native_self_consumption",
}

// NativeIntents in the original's order (Object.keys).
var NativeIntents = []string{"cover_load", "surplus_charge", "self_consumption"}

// CapabilityForIntent is the word an intent needs ("" for an unknown intent).
func CapabilityForIntent(intent string) string { return nativeCapabilityForIntent[intent] }

// AddrValue is one recorded write or readback byte pair of a certificate.
type AddrValue struct {
	Addr  int `json:"addr"`
	Value int `json:"value"`
}

// AddrExpect is one recorded readback check.
type AddrExpect struct {
	Addr   int `json:"addr"`
	Expect int `json:"expect"`
}

// NativeCapability is one certificate entry.
type NativeCapability struct {
	SimulatorOnly         bool
	Brand, Model          string
	Firmware              string
	Capability            string
	Candidate             string
	Certified             bool
	Readback              bool
	Watchdog              bool
	InterlockLifted       string
	WindowLimits          bool
	Persistent            bool
	ChargeBlockWrites     []AddrValue
	ReadbackChecks        []AddrExpect
	ReleaseWrites         []AddrValue
	ReleaseReadbackChecks []AddrExpect
	WatchdogSpec          *struct{ TimeoutS int }
	BenchRecord           string
}

// CertifiedNativeCapabilities is the production catalog: exactly the Deye
// pilot's cover_load entry (captain decision 2026-08-26). The Deye charge
// side (K5) is not released - see DEYE-LADESEITE-PILOT.md.
var CertifiedNativeCapabilities = []NativeCapability{{
	Brand: "deye", Model: "sun-30k-sg01hp3", Firmware: DeyeRemotePR978Firmware,
	Capability: "native_charge_block_discharge_auto",
	Certified:  true, Readback: true, Watchdog: true,
	InterlockLifted:       "deye",
	ChargeBlockWrites:     []AddrValue{{0x044c, 0}},
	ReadbackChecks:        []AddrExpect{{0x044c, 0}},
	ReleaseWrites:         []AddrValue{{0x044c, 1}},
	ReleaseReadbackChecks: []AddrExpect{{0x044c, 1}},
	WatchdogSpec:          &struct{ TimeoutS int }{60},
	BenchRecord: "Pilot-Freigabe 2026-08-26 (Captain-Entscheid \"der Pilot ist der Prüfstand\"): " +
		"Live-Sonde 2026-07-27 SUN-30K-SG01HP3-EU, PR-978-Remote-Layout; " +
		"Beobachtungs-Checkliste in edge-app/nodered/UNPLANNED-LOAD-BENCH.md",
}}

// NativeKey is the (brand, model, firmware) triple a certificate is keyed on.
// Absent JS values are "".
type NativeKey struct{ Brand, Model, Firmware string }

// ExactCapability is the gate: an exact triple, the word, a complete entry,
// and for Deye the per-entry interlock lift with its evidence.
func ExactCapability(key NativeKey, catalog []NativeCapability, word string) *NativeCapability {
	if key.Brand == "" || key.Model == "" || key.Firmware == "" {
		return nil
	}
	deye := strings.ToLower(key.Brand) == "deye"
	for i := range catalog {
		c := &catalog[i]
		if c.Brand == key.Brand && c.Model == key.Model && c.Firmware == key.Firmware &&
			c.Capability == word && c.Certified && c.Readback && c.Watchdog &&
			c.ChargeBlockWrites != nil && c.ReadbackChecks != nil &&
			c.ReleaseWrites != nil && c.ReleaseReadbackChecks != nil && c.WatchdogSpec != nil &&
			(!deye || (c.InterlockLifted == "deye" && c.BenchRecord != "")) {
			return c
		}
	}
	return nil
}

// ExactCapabilities is every complete entry for the triple and word, in
// catalog order.
func ExactCapabilities(key NativeKey, catalog []NativeCapability, word string) []*NativeCapability {
	var out []*NativeCapability
	for i := range catalog {
		if c := ExactCapability(key, catalog[i:i+1], word); c != nil {
			out = append(out, c)
		}
	}
	return out
}

// CertificateMatchesPlan is the drift check: the recorded bytes equal the
// planned writes and readbacks, in order.
func CertificateMatchesPlan(c *NativeCapability, planned []WriteOp, readbacks []ReadOp) bool {
	if c == nil || len(c.ChargeBlockWrites) != len(planned) || len(c.ReadbackChecks) != len(readbacks) {
		return false
	}
	for i, w := range c.ChargeBlockWrites {
		if w.Addr != planned[i].Addr || w.Value != planned[i].Value {
			return false
		}
	}
	for i, r := range c.ReadbackChecks {
		if r.Addr != readbacks[i].Addr || readbacks[i].Expect == nil || r.Expect != *readbacks[i].Expect {
			return false
		}
	}
	return true
}

// NativeLevers is the native_capabilities report block.
type NativeLevers struct {
	Intents    []string `json:"intents"`
	Window     bool     `json:"window"`
	Persistent bool     `json:"persistent"`
}

// plannedFor returns the adapter's bytes for an intent and entry (ok=false:
// the tier has no primitive for it).
type plannedFor func(intent string, entry *NativeCapability) (planned []WriteOp, readbacks []ReadOp, ok bool)

// nativeLeversFor: the intents with a certified lever whose bytes still match.
func nativeLeversFor(key NativeKey, catalog []NativeCapability, pf plannedFor) *NativeLevers {
	intents := []string{}
	window, persistent := true, false
	for _, intent := range NativeIntents {
		var hit *NativeCapability
		for _, c := range ExactCapabilities(key, catalog, CapabilityForIntent(intent)) {
			if p, r, ok := pf(intent, c); ok && CertificateMatchesPlan(c, p, r) {
				hit = c
				break
			}
		}
		if hit == nil {
			continue
		}
		intents = append(intents, intent)
		if !hit.WindowLimits {
			window = false
		}
		if hit.Persistent {
			persistent = true
		}
	}
	return &NativeLevers{Intents: intents, Window: len(intents) > 0 && window, Persistent: persistent}
}

// certificateObj is the `certificate` block of a hand-over plan.
func certificateObj(c *NativeCapability) Obj {
	return Obj{"brand": c.Brand, "model": c.Model, "firmware": c.Firmware,
		"simulator_only": c.SimulatorOnly, "bench_record": c.BenchRecord}
}

// deyeChargeSideBytes are the bytes the two charge-side candidates were built
// with (60-s watchdog); a release records exactly these.
var deyeChargeSideBytes = map[string][]AddrValue{
	"grid_zero":  {{0x044d, 60}, {0x0455, 0}, {0x0450, 2}, {0x045b, 999}, {0x044c, 1}},
	"own_config": {{0x044c, 0}},
}

// ReleaseDeyeChargeSide builds ONE Deye charge-side certificate for the pilot
// model (unplanned-load-native.js releaseDeyeChargeSide) - the one-line step
// in the catalog after a passed pilot window. ok=false for an unknown
// candidate, a non-charge intent or a missing bench record.
func ReleaseDeyeChargeSide(candidate, intent, benchRecord string) (NativeCapability, bool) {
	bytes, known := deyeChargeSideBytes[candidate]
	if !known || !chargeIntents[intent] || trimmed(benchRecord) == "" {
		return NativeCapability{}, false
	}
	checks := make([]AddrExpect, len(bytes))
	for i, b := range bytes {
		checks[i] = AddrExpect{b.Addr, b.Value}
	}
	return NativeCapability{
		Brand: "deye", Model: "sun-30k-sg01hp3", Firmware: DeyeRemotePR978Firmware,
		Capability: nativeCapabilityForIntent[intent], Candidate: candidate,
		Certified: true, Readback: true, Watchdog: true, InterlockLifted: "deye",
		ChargeBlockWrites:     append([]AddrValue{}, bytes...),
		ReadbackChecks:        checks,
		ReleaseWrites:         []AddrValue{{0x044c, 1}},
		ReleaseReadbackChecks: []AddrExpect{{0x044c, 1}},
		WatchdogSpec:          &struct{ TimeoutS int }{60},
		BenchRecord:           benchRecord,
	}, true
}
