package inverter

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The register facts, live-verified at Anlage Herzogau on 17.08.2026 over the
// box's own Modbus mirror: raw 3300 in 0x00E7 -> 33,0 kW (scale 10).
func TestHybrid3pExportLimitDecodesTheHerzogauReading(t *testing.T) {
	reg, ok := ExportLimitRegisterFor(FamHybrid3p)
	if !ok {
		t.Fatal("hybrid_3p must expose its own feed-in-cap register")
	}
	if reg.Addr != 0x00e7 || reg.Scale != 10 {
		t.Fatalf("register facts drifted: %#v", reg)
	}
	if got := reg.DecodeExportLimitKw(3300); got != 33 {
		t.Fatalf("raw 3300 must decode to 33,0 kW, got %v", got)
	}
	// A 0 is a VALUE ("may not feed in at all"), never an absence - the caller
	// decides that, and it must be able to see the difference.
	if got := reg.DecodeExportLimitKw(0); got != 0 {
		t.Fatalf("raw 0 must decode to 0 kW, got %v", got)
	}
	// The register is a plain unsigned word - the full range must not overflow
	// into something absurd silently.
	if got := reg.DecodeExportLimitKw(65535); got != 655.35 {
		t.Fatalf("raw 65535 must decode to 655,35 kW, got %v", got)
	}
}

// THE honesty rule of the whole feature: a family whose feed-in-cap register is
// one WE write must report nothing at all, because reading it back would report
// our own command as "the limit the device itself holds".
func TestAFamilyWhoseRegisterWeWriteIsNeverRead(t *testing.T) {
	// hybrid_1p: exportLimit == maxSellPower (0x00F5), the register the ToU
	// discharge lever writes.
	if _, ok := ExportLimitRegisterFor(FamHybrid1p); ok {
		t.Fatal("hybrid_1p must NOT be read - its cap register is our own discharge lever")
	}
	for _, fam := range []string{
		FamString, FamMicro, FamSunSpec, FamSunSpecLive, FamFroniusSolarAPI,
		FamKostalPlenticore, FamGoeHTTP, FamShellyHTTP, "",
	} {
		if _, ok := ExportLimitRegisterFor(fam); ok {
			t.Fatalf("family %q has no trustworthy feed-in cap and must report none", fam)
		}
	}
}

// The CROSS-SIDE TWIN: the Node-RED router builds the read plan from its own
// table, this package decodes the word it brings back. A drifted address reads
// the wrong register; a drifted scale reports a 10x-wrong number to the
// customer. Both must fail here, not in the field.
func TestExportLimitRegisterMatchesTheNodeRedTable(t *testing.T) {
	const routing = "../../../nodered/inverter-routing.js"
	src, err := os.ReadFile(routing)
	if err != nil {
		t.Fatalf("read %s: %v", routing, err)
	}
	table := extractDeyeExportLimitTable(t, string(src))

	if len(table) != len(exportLimitRegisters) {
		t.Fatalf("the two tables cover different families: JS %v, Go %v", table, exportLimitRegisters)
	}
	for fam, want := range table {
		got, ok := ExportLimitRegisterFor(fam)
		if !ok {
			t.Fatalf("family %q is read in Node-RED but not decodable here", fam)
		}
		if got.Addr != want.addr || got.Scale != want.scale {
			t.Fatalf("family %q drifted: Go addr=%#x scale=%v, JS addr=%#x scale=%v",
				fam, got.Addr, got.Scale, want.addr, want.scale)
		}
		// The label the operator sees must name the address it came from -
		// a number without its origin is not evidence. (Compared on the VALUE,
		// so a "0x00e7" / "0xe7" spelling difference is not a failure.)
		labelAddr, err := strconv.ParseInt(strings.TrimPrefix(strings.ToLower(got.Label), "0x"), 16, 32)
		if err != nil || int(labelAddr) != want.addr {
			t.Fatalf("family %q label %q does not name its register %#x", fam, got.Label, want.addr)
		}
	}
}

type jsExportLimit struct {
	addr  int
	scale float64
}

// extractDeyeExportLimitTable pulls `DEYE_EXPORT_LIMIT` out of the routing
// module's source. A regexp is enough here (and beats shelling out to node):
// the table is a flat literal by construction - if it ever stops being one,
// this test fails loudly rather than silently comparing nothing.
func extractDeyeExportLimitTable(t *testing.T, src string) map[string]jsExportLimit {
	t.Helper()
	start := strings.Index(src, "const DEYE_EXPORT_LIMIT = {")
	if start < 0 {
		t.Fatal("DEYE_EXPORT_LIMIT not found in inverter-routing.js")
	}
	end := strings.Index(src[start:], "\n};")
	if end < 0 {
		t.Fatal("DEYE_EXPORT_LIMIT literal is not the flat table this test can read")
	}
	body := src[start : start+end]

	entry := regexp.MustCompile(`(?m)^\s*([a-z0-9_]+):\s*\{\s*addr:\s*(0x[0-9a-fA-F]+|\d+),\s*scale:\s*([0-9.]+)\s*\}`)
	out := map[string]jsExportLimit{}
	for _, m := range entry.FindAllStringSubmatch(body, -1) {
		addr, err := strconv.ParseInt(strings.TrimPrefix(strings.ToLower(m[2]), "0x"), 16, 32)
		if strings.HasPrefix(strings.ToLower(m[2]), "0x") {
			if err != nil {
				t.Fatalf("unparseable address %q", m[2])
			}
		} else {
			addr, err = strconv.ParseInt(m[2], 10, 32)
			if err != nil {
				t.Fatalf("unparseable address %q", m[2])
			}
		}
		scale, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			t.Fatalf("unparseable scale %q", m[3])
		}
		out[m[1]] = jsExportLimit{addr: int(addr), scale: scale}
	}
	if len(out) == 0 {
		t.Fatal("read no entries from DEYE_EXPORT_LIMIT - the twin check would be vacuous")
	}
	return out
}
