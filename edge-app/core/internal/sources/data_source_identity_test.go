package sources

import (
	"bytes"
	"testing"
)

func TestStatusIdentityIsMetadataAndNeverRemintsLocalIdentity(t *testing.T) {
	source := Source{ID: "src-existing", Role: RoleErzeuger}
	before := DeterministicID(source)
	source.DataSourceID = "DQ-4"
	if DeterministicID(source) != before || source.ID != "src-existing" {
		t.Fatal("status identity changed the local source")
	}
	if !bytes.Contains(BusConfig([]Source{source}), []byte(`"data_source_id":"DQ-4"`)) {
		t.Fatal("identity missing from local config")
	}
}
