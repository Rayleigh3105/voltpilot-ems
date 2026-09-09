package ocppcontrol

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedPolicyVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/ocpp-control-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Vectors []struct {
			Name   string
			Valid  bool
			Policy json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, v := range fixture.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var p Policy
			err := json.Unmarshal(v.Policy, &p)
			if err == nil {
				err = p.Validate()
			}
			if (err == nil) != v.Valid {
				t.Fatalf("valid=%v error=%v", v.Valid, err)
			}
		})
	}
}
