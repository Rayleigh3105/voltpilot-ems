package entities

// „Ruhe bis zum Start" (UEMS AP-01 IP-4, rule R0): the Go twin of
// services/api uems/RuheRegel, pinned by the SAME file,
// docs/contracts/v2/override-vectors.json. The Java twin reads every block;
// the box reads the three that concern it:
//
//	push     every registry push the cloud composes, parsed like a real push
//	box      this box: automation_paused_until_revoked rests until revoked
//	box_alt  a box BEFORE this change - it never had the field, so its struct
//	         is ours with PausedUntilRevoked zeroed

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type ruheVectors struct {
	Konstanten struct {
		EndeFuerAeltereBoxS int `json:"ende_fuer_aeltere_box_s"`
		ErneuernNachS       int `json:"erneuern_nach_s"`
		TaktS               int `json:"takt_s"`
	} `json:"konstanten"`
	Push []struct {
		Name  string `json:"name"`
		Input struct {
			Pause *struct {
				Herkunft *string `json:"herkunft"`
			} `json:"pause"`
			Jetzt time.Time `json:"jetzt"`
		} `json:"input"`
		Expected struct {
			Felder map[string]any `json:"felder"`
		} `json:"expected"`
	} `json:"push"`
	Box    []ruheBoxCase `json:"box"`
	BoxAlt []ruheBoxCase `json:"box_alt"`
}

type ruheBoxCase struct {
	Name  string `json:"name"`
	Input struct {
		Felder map[string]any `json:"felder"`
		Jetzt  time.Time      `json:"jetzt"`
	} `json:"input"`
	Expected struct {
		Ruht bool `json:"ruht"`
	} `json:"expected"`
}

func loadRuheVectors(t *testing.T) ruheVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"override-vectors.json"))
	if err != nil {
		t.Fatalf("override vectors: %v", err)
	}
	var v ruheVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("override vectors unreadable: %v", err)
	}
	if len(v.Push) == 0 || len(v.Box) == 0 || len(v.BoxAlt) == 0 {
		t.Fatal("override vectors: a block is empty - a silently vacuous twin")
	}
	return v
}

// ruhePush is a valid, empty registry push with the vector's pause fields.
func ruhePush(t *testing.T, felder map[string]any) Registry {
	t.Helper()
	push := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      pushIdentity.TenantID,
		"site_id":        pushIdentity.SiteID,
		"device_id":      pushIdentity.DeviceID,
		"revision":       "ruhe",
		"published_at":   "2026-12-01T08:00:00Z",
		"entities":       []any{},
	}
	for k, val := range felder {
		push[k] = val
	}
	raw, err := json.Marshal(push)
	if err != nil {
		t.Fatal(err)
	}
	reg, skipped, err := ParseRegistryPush(raw, pushIdentity)
	if err != nil || len(skipped) != 0 {
		t.Fatalf("registry push with %v: skipped=%v err=%v", felder, skipped, err)
	}
	return reg
}

func TestRuheVectorsTheBoxRestsUntilRevoked(t *testing.T) {
	for _, c := range loadRuheVectors(t).Box {
		t.Run(c.Name, func(t *testing.T) {
			reg := ruhePush(t, c.Input.Felder)
			if got := reg.Paused(c.Input.Jetzt); got != c.Expected.Ruht {
				t.Fatalf("Paused(%s) = %v, want %v (felder %v)", c.Input.Jetzt, got,
					c.Expected.Ruht, c.Input.Felder)
			}
		})
	}
}

func TestRuheVectorsAnOlderBoxOnlyKnowsTheEnd(t *testing.T) {
	for _, c := range loadRuheVectors(t).BoxAlt {
		t.Run(c.Name, func(t *testing.T) {
			reg := ruhePush(t, c.Input.Felder)
			reg.PausedUntilRevoked = false // the field an older binary never had
			if got := reg.Paused(c.Input.Jetzt); got != c.Expected.Ruht {
				t.Fatalf("older box Paused(%s) = %v, want %v", c.Input.Jetzt, got, c.Expected.Ruht)
			}
		})
	}
}

// Every push the cloud composes parses on the box and means what it says: no
// pause without a field, a manual pause until its end, the Ruhe until revoked
// - also long after the rolling end an older box reads has passed.
func TestRuheVectorsEveryComposedPushParsesAndRests(t *testing.T) {
	for _, c := range loadRuheVectors(t).Push {
		t.Run(c.Name, func(t *testing.T) {
			reg := ruhePush(t, c.Expected.Felder)
			ruhe := c.Input.Pause != nil && c.Input.Pause.Herkunft != nil &&
				*c.Input.Pause.Herkunft == "funktion"
			if reg.PausedUntilRevoked != ruhe {
				t.Fatalf("PausedUntilRevoked = %v, want %v", reg.PausedUntilRevoked, ruhe)
			}
			if got := reg.Paused(c.Input.Jetzt); got != (c.Input.Pause != nil) {
				t.Fatalf("Paused(push time) = %v, want %v", got, c.Input.Pause != nil)
			}
			if later := c.Input.Jetzt.Add(30 * 24 * time.Hour); reg.Paused(later) != ruhe {
				t.Fatalf("Paused(+30 days) = %v, want %v - only the Ruhe outlives every clock",
					reg.Paused(later), ruhe)
			}
		})
	}
}

// The rolling end must outlast one missed renewal tick, or an older box would
// wake between two pushes while the cloud is perfectly healthy.
func TestRuheVectorsTheRollingEndOutlastsTheRenewal(t *testing.T) {
	k := loadRuheVectors(t).Konstanten
	if k.EndeFuerAeltereBoxS <= k.ErneuernNachS+k.TaktS {
		t.Fatalf("rolling end %ds must exceed renewal %ds + tick %ds",
			k.EndeFuerAeltereBoxS, k.ErneuernNachS, k.TaktS)
	}
}

// A box that reboots offline keeps resting: the flag survives the persisted
// registry exactly like the end does.
func TestRuheSurvivesThePersistedRegistry(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	past := time.Date(2026, 12, 1, 12, 0, 0, 0, time.UTC)
	if err := store.Save(Registry{Revision: "ruhe", PausedUntil: past,
		PausedUntilRevoked: true}); err != nil {
		t.Fatal(err)
	}
	reg, ok, err := store.Load()
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if !reg.PausedUntilRevoked || !reg.Paused(past.Add(72*time.Hour)) {
		t.Fatalf("persisted Ruhe lost across a reboot: %+v", reg)
	}
}
