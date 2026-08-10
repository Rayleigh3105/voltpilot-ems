package shelly

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStoreRoundTripAndDrop(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	key := Config{IP: "192.168.0.60"}.Key()
	if key != "192.168.0.60:80/0" {
		t.Fatalf("key shape changed: %s", key)
	}
	id := Identity{Gen: Gen2, Model: "SNSW-001P16EU", App: "Plus1PM", HasMetering: true,
		DetectedAt: time.Now().UTC().Truncate(time.Second)}
	if err := s.Put(key, id); err != nil {
		t.Fatal(err)
	}
	// A fresh store instance (= a reboot) reads the persisted identity back -
	// the "detected once" promise.
	s2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := s2.Get(key)
	if !ok || got.Gen != Gen2 || !got.HasMetering || got.Model != id.Model {
		t.Fatalf("persisted identity lost: %+v ok=%v", got, ok)
	}
	if err := s2.Drop(key); err != nil {
		t.Fatal(err)
	}
	if _, ok := s2.Get(key); ok {
		t.Fatal("dropped identity still present")
	}
	s3, _ := NewStore(dir)
	if _, ok := s3.Get(key); ok {
		t.Fatal("drop must persist")
	}
}

func TestStoreIgnoresForeignSchema(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, storeFile),
		[]byte(`{"schema_version":99,"devices":{"x:80/0":{"gen":7}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Get("x:80/0"); ok {
		t.Fatal("a future-schema file must be ignored wholesale (re-detect, never mis-read)")
	}
}
