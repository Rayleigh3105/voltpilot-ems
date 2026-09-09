package csms

import (
	"encoding/json"
	"os"
	"testing"
)

func TestProfileOwnershipVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/ocpp-profile-ownership-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Vectors []struct {
			Name, Action string
			Request      json.RawMessage
			Allowed      bool
		}
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			if err := validateProfileOwnership(v.Action, v.Request); (err == nil) != v.Allowed {
				t.Fatalf("allowed=%v: %v", v.Allowed, err)
			}
		})
	}
}
