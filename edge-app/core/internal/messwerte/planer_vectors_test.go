package messwerte

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func planerVektorenPfad() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "measurements", "measurement-planner-vectors.json")
}

type vektorOptionen struct {
	Discovery   *Discovery            `json:"discovery"`
	Discoveries map[string]*Discovery `json:"discoveries"`
	ByteOrder   string                `json:"byteOrder"`
	ByteOrders  map[string]string     `json:"byteOrders"`
	Binding     *struct {
		Entities map[string]struct {
			EntityID     string `json:"entity_id"`
			EntityType   string `json:"entity_type"`
			EdgeSourceID string `json:"edge_source_id"`
			DataSourceID string `json:"data_source_id"`
		} `json:"entities"`
		Sources map[string]struct {
			Communication string         `json:"communication"`
			Connection    map[string]any `json:"connection"`
		} `json:"sources"`
	} `json:"binding"`
	OcppCapability *struct {
		Supported           bool     `json:"supported"`
		Readonly            bool     `json:"readonly"`
		MaxLength           int      `json:"maxLength"`
		SupportedMeasurands []string `json:"supportedMeasurands"`
	} `json:"ocppCapability"`
}

func (v vektorOptionen) planOptionen() PlanOptionen {
	o := PlanOptionen{Discovery: v.Discovery, Discoveries: v.Discoveries, ByteOrder: v.ByteOrder, ByteOrders: v.ByteOrders,
		Bindung: Bindung{Entitaeten: map[string]Entitaet{}, Quellen: map[string]Geraet{}}}
	if v.Binding != nil {
		for id, e := range v.Binding.Entities {
			o.Bindung.Entitaeten[id] = Entitaet(e)
		}
		for id, q := range v.Binding.Sources {
			o.Bindung.Quellen[id] = Geraet(q)
		}
	}
	if f := v.OcppCapability; f != nil {
		o.Ocpp = &OcppFaehigkeit{Supported: f.Supported, Readonly: f.Readonly, MaxLength: f.MaxLength,
			SupportedMeasurands: f.SupportedMeasurands}
	}
	return o
}

// planAlsVektor is the plan in the vectors' shape.
func planAlsVektor(p Plan) map[string]any {
	out := map[string]any{"applied": p.Applied, "accepted": p.Accepted, "rejected": p.Rejected, "metrics": p.Metrics}
	if p.Rejected == nil {
		out["rejected"] = []Ablehnung{}
	}
	if !p.Applied {
		return out
	}
	kand := func(x Kandidat, prereq bool) map[string]any {
		m := map[string]any{"point_key": x.Point.PointKey, "cadence_s": x.CadenceS, "target": x.Target,
			"requested_key": x.RequestedKey}
		if prereq {
			m["trigger_key"] = x.TriggerKey
		} else if x.EntityID != "" {
			m["entity_id"] = x.EntityID
		}
		return m
	}
	sel, pre, blocks, http := []any{}, []any{}, []any{}, []any{}
	for _, x := range p.Selections {
		sel = append(sel, kand(x, false))
	}
	for _, x := range p.DecoderPrerequisites {
		pre = append(pre, kand(x, true))
	}
	for _, b := range p.Blocks {
		m := map[string]any{"key": b.Key, "start": b.Start, "count": b.Count, "cadence_s": b.CadenceS,
			"source_kind": b.SourceKind, "target": b.Target, "points": b.Points, "requestCostMs": b.RequestCostMs}
		if b.Funktionscode != 0 {
			m["funktionscode"] = b.Funktionscode
		}
		blocks = append(blocks, m)
	}
	for _, g := range p.HTTPGroups {
		http = append(http, map[string]any{"key": g.Key, "target": g.Target})
	}
	out["selections"], out["decoderPrerequisites"], out["blocks"], out["httpGroups"] = sel, pre, blocks, http
	out["registerbilder"] = p.Registerbilder
	if p.OcppConfiguration != nil { // JS: undefined when the OCPP points were refused
		out["ocppConfiguration"] = p.OcppConfiguration
	}
	return out
}

func TestBuildPlanVectors(t *testing.T) {
	raw, err := os.ReadFile(planerVektorenPfad())
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Faelle []struct {
			Name    string          `json:"name"`
			Config  Konfig          `json:"config"`
			Options vektorOptionen  `json:"options"`
			Result  json.RawMessage `json:"result"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Faelle) == 0 {
		t.Fatalf("Vektoren: %v", err)
	}
	k := katalogFuerTests(t)
	for _, c := range v.Faelle {
		p, err := k.BuildPlan(c.Config, c.Options.planOptionen())
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		var want any
		_ = json.Unmarshal(c.Result, &want)
		got := alsJSON(t, planAlsVektor(p))
		if !gleich(got, want) {
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(want)
			t.Errorf("%s:\n Go %s\n JS %s", c.Name, g, w)
		}
	}
}
