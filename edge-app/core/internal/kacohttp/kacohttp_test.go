package kacohttp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type ergebnis struct {
	Reading map[string]float64 `json:"reading"`
	BattKw  *float64           `json:"battKw"`
	Meta    map[string]any     `json:"meta"`
	Serial  string             `json:"serial,omitempty"`
}

type vektoren struct {
	Families    map[string]struct{ HasBattery bool } `json:"families"`
	DefaultPort int                                  `json:"default_port"`
	URLs        []struct {
		Scheme    string   `json:"scheme"`
		Host      string   `json:"host"`
		Port      int      `json:"port"`
		Serial    any      `json:"serial"`
		Inventory string   `json:"inventory"`
		Devdata   []string `json:"devdata"`
	} `json:"urls"`
	Inventories []struct {
		Raw       string      `json:"raw"`
		Inventory []Inventory `json:"inventory"`
	} `json:"inventories"`
	Decodes []struct {
		Name  string `json:"name"`
		Parts struct {
			Inverter, Meter, Battery *string
		} `json:"parts"`
		Opts struct {
			Family         string `json:"family"`
			InvertGridSign bool   `json:"invertGridSign"`
			InvertBattSign bool   `json:"invertBattSign"`
		} `json:"opts"`
		Decode *ergebnis `json:"decode"`
	} `json:"decodes"`
	Reads []struct {
		Name   string `json:"name"`
		Target struct {
			IP             string `json:"ip"`
			Port           int    `json:"port"`
			Family         string `json:"family"`
			Serial         string `json:"serial"`
			HasBattery     *bool  `json:"hasBattery"`
			InvertGridSign bool   `json:"invertGridSign"`
			InvertBattSign bool   `json:"invertBattSign"`
		} `json:"target"`
		Responses map[string]json.RawMessage `json:"responses"`
		Calls     []string                   `json:"calls"`
		Result    *ergebnis                  `json:"result"`
	} `json:"reads"`
}

func laden(t *testing.T) vektoren {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "kaco", "kaco-http-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func bytesOf(s *string) []byte {
	if s == nil {
		return nil
	}
	return []byte(*s)
}

// alsJSON compares through JSON like the vector file carries it.
func alsJSON(t *testing.T, r *Result) any {
	t.Helper()
	if r == nil {
		return nil
	}
	raw, _ := json.Marshal(ergebnis{Reading: r.Reading, BattKw: r.BattKw, Meta: r.Meta, Serial: r.Serial})
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

func jsonOf(t *testing.T, e *ergebnis) any {
	t.Helper()
	if e == nil {
		return nil
	}
	raw, _ := json.Marshal(e)
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

func TestSharedVectors(t *testing.T) {
	v := laden(t)
	if v.DefaultPort != DefaultPort || len(v.Families) != 2 || v.Families[FamilyString].HasBattery || !v.Families[FamilyHybrid].HasBattery {
		t.Fatalf("Familien/Port: %+v %d", v.Families, v.DefaultPort)
	}
	for _, u := range v.URLs {
		serial := ""
		switch s := u.Serial.(type) {
		case string:
			serial = s
		case float64:
			serial = strconv.FormatFloat(s, 'f', -1, 64)
		}
		if got := InventoryURL(u.Scheme, u.Host, u.Port); got != u.Inventory {
			t.Errorf("Inventar-URL %s statt %s", got, u.Inventory)
		}
		for i, d := range []int{DeviceInverter, DeviceMeter, DeviceBattery} {
			if got := DevDataURL(u.Scheme, u.Host, u.Port, d, serial); got != u.Devdata[i] {
				t.Errorf("URL %v: %s statt %s", u.Serial, got, u.Devdata[i])
			}
		}
	}
	for _, c := range v.Inventories {
		if got := ParseInventory([]byte(c.Raw)); !reflect.DeepEqual(got, c.Inventory) {
			t.Errorf("Inventar %q: %+v statt %+v", c.Raw, got, c.Inventory)
		}
	}
	if len(v.Decodes) < 30 {
		t.Fatalf("%d Decodierungen", len(v.Decodes))
	}
	for _, c := range v.Decodes {
		got := Decode(Parts{Inverter: bytesOf(c.Parts.Inverter), Meter: bytesOf(c.Parts.Meter), Battery: bytesOf(c.Parts.Battery)},
			Options{Family: c.Opts.Family, InvertGridSign: c.Opts.InvertGridSign, InvertBattSign: c.Opts.InvertBattSign})
		if g, w := alsJSON(t, got), jsonOf(t, c.Decode); !reflect.DeepEqual(g, w) {
			t.Errorf("%s %+v:\n Go %v\n JS %v", c.Name, c.Opts, g, w)
		}
	}
	for _, c := range v.Reads {
		var mu sync.Mutex
		var calls []string
		get := func(_ context.Context, url string) []byte {
			mu.Lock()
			calls = append(calls, url)
			mu.Unlock()
			var r struct {
				Status int    `json:"status"`
				Body   string `json:"body"`
			}
			if raw, ok := c.Responses[url]; !ok || json.Unmarshal(raw, &r) != nil || r.Status != 200 {
				return nil // keine Antwort, abgewiesen oder kein 200
			}
			return []byte(r.Body)
		}
		got := Read(context.Background(), get, Target{IP: c.Target.IP, Port: c.Target.Port, Family: c.Target.Family,
			Serial: c.Target.Serial, HasBattery: c.Target.HasBattery, InvertGridSign: c.Target.InvertGridSign,
			InvertBattSign: c.Target.InvertBattSign})
		// Das Inventar kommt allein und zuerst, die Messwert-Abrufe danach parallel.
		first := func(l []string) []string {
			if len(l) > 0 && strings.Contains(l[0], "/getdev.cgi") {
				return l[:1]
			}
			return nil
		}
		rest := func(l []string) []string {
			r := append([]string(nil), l[len(first(l)):]...)
			sort.Strings(r)
			return r
		}
		if !reflect.DeepEqual(first(calls), first(c.Calls)) || !reflect.DeepEqual(rest(calls), rest(c.Calls)) {
			t.Errorf("%s: Abrufe %v statt %v", c.Name, calls, c.Calls)
		}
		if g, w := alsJSON(t, got), jsonOf(t, c.Result); !reflect.DeepEqual(g, w) {
			t.Errorf("%s:\n Go %v\n JS %v", c.Name, g, w)
		}
	}
}
