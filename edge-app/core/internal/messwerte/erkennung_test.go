package messwerte

import (
	"context"
	"errors"
	"testing"
)

// The expectations come from vp-measurements.js itself (shapeShellyStatus,
// inverterJSONEndpoint), run on the same inputs.
func TestShellyStatusAndEndpointLikeThePalette(t *testing.T) {
	st, err := ParseJSON([]byte(`{"switch:0":{"output":true,"id":9,"apower":1.5},"cover:1":{"x":1},"switch:x":{"a":1},"switch:2":5,"sys":{"t":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ selector, want string }{
		{"Switch.GetStatus?id=*#apower", `[{"id":9,"output":true,"apower":1.5}]`},
		{"Sys.GetStatus#t", `[{"t":1}]`},
		{"Shelly.GetDeviceInfo#id", `[{"switch:0":{"output":true,"id":9,"apower":1.5},"cover:1":{"x":1},"switch:x":{"a":1},"switch:2":5,"sys":{"t":1}}]`},
	} {
		if got := Stringify(ShellyStatus([]*Punkt{{Selector: c.selector}}, st)); got != c.want {
			t.Errorf("%s:\n Go   %s\n soll %s", c.selector, got, c.want)
		}
	}
	got, err := JSONPfad([]*Punkt{{SourceKind: "rest_json", Selector: "/getdevdata.cgi?device=2&sn={serial}#ipv[*]"}}, "", "AB 12/3")
	if err != nil || got != "/getdevdata.cgi?device=2&sn=AB%2012%2F3" {
		t.Fatalf("Endpunkt %q %v", got, err)
	}
	if _, err := JSONPfad([]*Punkt{{SourceKind: "rest_json", Selector: "/x?sn={serial}#a"}}, "", ""); err == nil {
		t.Fatal("ohne Seriennummer keine Anfrage")
	}
	if got, _ := JSONPfad([]*Punkt{{SourceKind: "http_api_key"}}, "acp,nrg", ""); got != "/api/status?filter=acp%2Cnrg" {
		t.Fatalf("go-e-Filter %q", got)
	}
}

func TestErkenneWalksTheModelChain(t *testing.T) {
	bild := map[int]uint16{50000: 0x5375, 50001: 0x6e53, 50002: 1, 50003: 4, 50008: 160, 50009: 50, 50018: 2, 50060: 0xffff}
	lies := func(_ context.Context, start, count int) ([]uint16, error) {
		if start == 40000 {
			return nil, errors.New("keine Antwort")
		}
		out := make([]uint16, count)
		for i := range out {
			out[i] = bild[start+i]
		}
		return out, nil
	}
	d, err := Erkenne(context.Background(), lies)
	if err != nil {
		t.Fatal(err)
	}
	if d.Models[1].Base != 50004 || d.Models[160].Base != 50010 || d.Models[160].ModuleCount != 2 || len(d.Models) != 2 {
		t.Fatalf("Modelle %+v", d.Models)
	}
}
