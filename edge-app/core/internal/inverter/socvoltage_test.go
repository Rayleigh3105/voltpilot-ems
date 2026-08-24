package inverter

import (
	"encoding/json"
	"strings"
	"testing"
)

// The pack's two ends survive a config round trip and reach the DECODER over
// the retained bus config - without that last hop the setting would be inert,
// because the SoC gate lives in deye-decode, not here.
func TestSocFromVoltageRoundTripsAndIsPublishedToTheDecoder(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg02hp3",
		Connection: Connection{
			IP: "192.168.0.28", Serial: "2985159064",
			AllowMissingSoc: true,
			SocFromVoltage:  &SocFromVoltage{VEmpty: 600, VFull: 700},
		},
	}, now)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if sel.Connection.SocFromVoltage == nil || sel.Connection.SocFromVoltage.VEmpty != 600 {
		t.Fatalf("bounds lost in Normalize: %+v", sel.Connection.SocFromVoltage)
	}
	var payload map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &payload); err != nil {
		t.Fatalf("BusPayload: %v", err)
	}
	conn, _ := payload["connection"].(map[string]any)
	got, ok := conn["soc_from_voltage"].(map[string]any)
	if !ok {
		t.Fatalf("soc_from_voltage never reaches the decoder: %v", conn)
	}
	if got["v_empty"] != 600.0 || got["v_full"] != 700.0 {
		t.Fatalf("published bounds wrong: %v", got)
	}

	// A selection WITHOUT bounds must publish no key at all - "absent" is what
	// the decoder reads as "estimate nothing", and an empty object would be a
	// setting the customer never made.
	plain, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg02hp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}, now)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	var plainPayload map[string]any
	if err := json.Unmarshal(plain.BusPayload(), &plainPayload); err != nil {
		t.Fatalf("BusPayload: %v", err)
	}
	pconn, _ := plainPayload["connection"].(map[string]any)
	if _, present := pconn["soc_from_voltage"]; present {
		t.Fatalf("an unset estimate must not be published: %v", pconn)
	}
}

// The estimate belongs to the Solarman read path and nowhere else: every other
// decoder omits an implausible SoC instead of dropping the read, so there is
// nothing for a voltage estimate to rescue. Cleared at the ONE place the
// AllowMissingSoc / Channel rules are cleared, so a transport added later
// cannot silently inherit it.
func TestSocFromVoltageIsClearedForEveryOtherTransport(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandGenericModbus, Model: FamSunSpec,
		Connection: Connection{
			IP:              "192.168.0.50",
			AllowMissingSoc: true,
			SocFromVoltage:  &SocFromVoltage{VEmpty: 48, VFull: 56},
		},
	}, now)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if sel.Connection.SocFromVoltage != nil {
		t.Fatalf("the estimate must not survive a non-Solarman transport: %+v",
			sel.Connection.SocFromVoltage)
	}
	if sel.Connection.AllowMissingSoc {
		t.Fatal("its companion opt-in must be cleared too (unchanged rule)")
	}
}

// The box judges the pair ITSELF - this connection arrives over the retained
// config, and a device that trusted whatever the cloud sent would show a
// percentage nobody could account for.
func TestANonsensicalVoltagePairIsRefusedWithAGermanReason(t *testing.T) {
	cat := DefaultCatalog()
	cases := []struct {
		name  string
		pair  SocFromVoltage
		wants string
	}{
		{"inverted", SocFromVoltage{VEmpty: 700, VFull: 600}, "über"},
		{"zero span", SocFromVoltage{VEmpty: 600, VFull: 600}, "über"},
		{"span too small to interpolate", SocFromVoltage{VEmpty: 600, VFull: 600.2}, "über"},
		{"millivolts (a unit mix-up)", SocFromVoltage{VEmpty: 48000, VFull: 56000}, "Volt"},
		{"a percentage, not a voltage", SocFromVoltage{VEmpty: 0, VFull: 100}, "Volt"},
		{"negative", SocFromVoltage{VEmpty: -5, VFull: 56}, "Volt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pair := tc.pair
			_, err := cat.Normalize(SelectionRequest{
				Brand: BrandDeye, Model: "sun-30k-sg02hp3",
				Connection: Connection{
					IP: "192.168.0.28", Serial: "2985159064",
					AllowMissingSoc: true, SocFromVoltage: &pair,
				},
			}, now)
			if err == nil {
				t.Fatal("a pair that cannot describe a battery must be refused")
			}
			if !strings.Contains(err.Error(), tc.wants) {
				t.Fatalf("the reason must name the problem, got %q", err)
			}
		})
	}
}

// Both real classes must pass the SAME rule: the api and the box know a pack's
// class no better than the customer typing it, so the band is deliberately wide.
func TestBothLvAndHvPacksPassTheSameBand(t *testing.T) {
	for _, pair := range []SocFromVoltage{
		{VEmpty: 48, VFull: 56},   // a 48-V-class LV pack
		{VEmpty: 600, VFull: 700}, // an HV string (Muehlfeldweg)
		{VEmpty: 40, VFull: 60},
		{VEmpty: 100, VFull: 1000},
	} {
		p := pair
		if err := p.validate(); err != nil {
			t.Fatalf("%+v must be accepted: %v", pair, err)
		}
	}
	var none *SocFromVoltage
	if err := none.validate(); err != nil {
		t.Fatalf("no estimate is the normal state of almost every plant: %v", err)
	}
}

// The wire shape the contract and the decoder agree on.
func TestSocFromVoltageWireShape(t *testing.T) {
	b, err := json.Marshal(Connection{SocFromVoltage: &SocFromVoltage{VEmpty: 48, VFull: 56}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"soc_from_voltage":{"v_empty":48,"v_full":56}`) {
		t.Fatalf("wire shape drifted: %s", b)
	}
	// An absent estimate must not appear at all (omitempty).
	b2, _ := json.Marshal(Connection{})
	if strings.Contains(string(b2), "soc_from_voltage") {
		t.Fatalf("an unset estimate must be absent, got %s", b2)
	}
}
