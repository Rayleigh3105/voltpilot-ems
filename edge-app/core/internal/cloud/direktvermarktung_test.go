package cloud

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/vermarktertunnel"
)

// The shared vectors pin the heartbeat block "direktvermarktung" across the
// three languages (docs/contracts/v2/direktvermarktung-zustellung.md §5): the
// Go summary type must read and write EXACTLY the vector blocks - a renamed
// or dropped field fails here before it silently drops a column in the cloud.
func TestDirektvermarktungSummaryMatchesSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/direktvermarktung-zustellung-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Lagen               []string `json:"lagen"`
		QuittungEreignisse  []string `json:"quittung_ereignisse"`
		Bloecke             []struct {
			Name  string          `json:"name"`
			Block json.RawMessage `json:"block"`
		} `json:"bloecke"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}

	// The Lage vocabulary is the one the tunnel manager derives (§5.4).
	wantLagen := []string{
		vermarktertunnel.LageOhneProfil, vermarktertunnel.LageOhneZugang, vermarktertunnel.LageZugangUngueltig,
		vermarktertunnel.LageBautAuf, vermarktertunnel.LageTunnelOben, vermarktertunnel.LageVerbunden,
		vermarktertunnel.LageVorgabeAktiv, vermarktertunnel.LageAbgelaufen, vermarktertunnel.LageTunnelUnten,
	}
	if !reflect.DeepEqual(vectors.Lagen, wantLagen) {
		t.Fatalf("lagen = %v, want %v", vectors.Lagen, wantLagen)
	}
	if !reflect.DeepEqual(vectors.QuittungEreignisse,
		[]string{direktvermarkter.QuittungZugestellt, direktvermarkter.QuittungGeloescht}) {
		t.Fatalf("quittung_ereignisse = %v", vectors.QuittungEreignisse)
	}

	for _, c := range vectors.Bloecke {
		var sum DirektvermarktungSummary
		dec := json.NewDecoder(bytes.NewReader(c.Block))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&sum); err != nil {
			t.Fatalf("%s: der Block traegt ein Feld, das die Box-Form nicht kennt: %v", c.Name, err)
		}
		out, err := json.Marshal(sum)
		if err != nil {
			t.Fatal(err)
		}
		var want, got any
		if err := json.Unmarshal(c.Block, &want); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: Rundreise weicht ab:\n got %s\nwant %s", c.Name, out, c.Block)
		}
	}
}

