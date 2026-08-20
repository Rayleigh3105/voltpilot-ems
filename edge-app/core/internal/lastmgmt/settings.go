package lastmgmt

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// SettingsStore persists the site's load-management settings on the box
// (data-dir/lastmgmt.json), mirroring inverter.json / sources.json /
// despike.json: atomic tmp+rename, defaults on a missing file, an honest
// error on a corrupt one.

// ValidationError carries a customer-facing German message; the web layer maps
// it to HTTP 400 (the inverter/sources/csms discipline: every setup surface
// refuses the same way).
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// Bounds. Generous on purpose: a 400 kW DC park and a 11 kW farm yard are both
// real, and a bound that refuses a real site is worse than none.
const (
	maxGridLimitKw    = 5000
	maxRotationMinute = 240
)

// SettingsRequest is what the setup surface posts. Every field is a POINTER so
// an absent field KEEPS the stored value — the PATCH semantics the house uses
// everywhere, which is what lets a form save one knob without resetting the rest.
type SettingsRequest struct {
	GridLimitKw     *float64 `json:"grid_limit_kw,omitempty"`
	HouseReserveKw  *float64 `json:"house_reserve_kw,omitempty"`
	MarginPct       *float64 `json:"margin_pct,omitempty"`
	MinPowerKw      *float64 `json:"min_power_kw,omitempty"`
	RotationMinutes *int     `json:"rotation_minutes,omitempty"`
	MaxHouseLoadKw  *float64 `json:"max_house_load_kw,omitempty"`
	// StaticBudget switches the dynamic (measured) budget off for this site —
	// see Settings.StaticBudget.
	StaticBudget *bool `json:"static_budget,omitempty"`
	// SurplusPolicy / StoragePriority are the Stufe-4 source choice (see
	// surplus.go). Pointers like every other field: an absent one KEEPS what
	// is stored.
	SurplusPolicy   *string `json:"surplus_policy,omitempty"`
	StoragePriority *string `json:"storage_priority,omitempty"`
}

// storedSettings is the on-disk shape. RotationPeriod is persisted in minutes
// because that is what an operator types and reads.
type storedSettings struct {
	SchemaVersion   string  `json:"schema_version"`
	GridLimitKw     float64 `json:"grid_limit_kw"`
	HouseReserveKw  float64 `json:"house_reserve_kw"`
	MarginPct       float64 `json:"margin_pct"`
	MinPowerKw      float64 `json:"min_power_kw"`
	RotationMinutes int     `json:"rotation_minutes"`
	MaxHouseLoadKw  float64 `json:"max_house_load_kw"`
	// StaticBudget is written only when it is set: an absent field is the
	// intended default (use the measurement when there is one), so an older
	// file and a fresh box read the same way.
	StaticBudget bool `json:"static_budget,omitempty"`
	// Stufe 4. Both are omitted while they hold their default, so an older
	// file and a fresh box read identically.
	SurplusPolicy   string `json:"surplus_policy,omitempty"`
	StoragePriority string `json:"storage_priority,omitempty"`
}

// SchemaVersion of lastmgmt.json.
const SchemaVersion = "1.0"

func (s Settings) stored() storedSettings {
	return storedSettings{
		SchemaVersion:   SchemaVersion,
		GridLimitKw:     s.GridLimitKw,
		HouseReserveKw:  s.HouseReserveKw,
		MarginPct:       s.MarginPct,
		MinPowerKw:      s.MinPowerKw,
		RotationMinutes: int(s.RotationPeriod / time.Minute),
		MaxHouseLoadKw:  s.MaxHouseLoadKw,
		StaticBudget:    s.StaticBudget,
		SurplusPolicy:   string(s.SurplusPolicy),
		StoragePriority: string(s.StoragePriority),
	}
}

func (st storedSettings) settings() Settings {
	return Settings{
		GridLimitKw:     st.GridLimitKw,
		HouseReserveKw:  st.HouseReserveKw,
		MarginPct:       st.MarginPct,
		MinPowerKw:      st.MinPowerKw,
		RotationPeriod:  time.Duration(st.RotationMinutes) * time.Minute,
		MaxHouseLoadKw:  st.MaxHouseLoadKw,
		StaticBudget:    st.StaticBudget,
		SurplusPolicy:   SurplusPolicy(st.SurplusPolicy),
		StoragePriority: StoragePriority(st.StoragePriority),
	}.WithDefaults()
}

// Apply folds a request onto the current settings and validates the result.
// It never mutates the receiver.
//
// ⚠ Every refusal names the FIELD and the LIMIT in German, because this is a
// setup surface an installer reads at a customer's site with a phone in one
// hand — "ungültig" is not an answer there.
func (s Settings) Apply(req SettingsRequest) (Settings, error) {
	out := s
	if req.GridLimitKw != nil {
		v := *req.GridLimitKw
		if v < 0 || v > maxGridLimitKw || isBad(v) {
			return s, invalid("Die Anschlussgrenze muss zwischen 0 und %g kW liegen.", float64(maxGridLimitKw))
		}
		out.GridLimitKw = v
	}
	if req.HouseReserveKw != nil {
		v := *req.HouseReserveKw
		if v < 0 || v > maxGridLimitKw || isBad(v) {
			return s, invalid("Die für das Gebäude reservierte Leistung muss zwischen 0 und %g kW liegen.", float64(maxGridLimitKw))
		}
		out.HouseReserveKw = v
	}
	if req.MarginPct != nil {
		v := *req.MarginPct
		if v < 0 || v >= 100 || isBad(v) {
			return s, invalid("Der Sicherheitsabstand muss zwischen 0 und 99 Prozent liegen.")
		}
		out.MarginPct = v
	}
	if req.MinPowerKw != nil {
		v := *req.MinPowerKw
		if v < 0 || v > maxGridLimitKw || isBad(v) {
			return s, invalid("Die Mindestleistung muss zwischen 0 und %g kW liegen.", float64(maxGridLimitKw))
		}
		out.MinPowerKw = v
	}
	if req.RotationMinutes != nil {
		v := *req.RotationMinutes
		if v < 1 || v > maxRotationMinute {
			return s, invalid("Der Wechsel-Takt muss zwischen 1 und %d Minuten liegen.", maxRotationMinute)
		}
		out.RotationPeriod = time.Duration(v) * time.Minute
	}
	if req.MaxHouseLoadKw != nil {
		v := *req.MaxHouseLoadKw
		if v < 0 || v > maxGridLimitKw || isBad(v) {
			return s, invalid("Die höchste bekannte Gebäudelast muss zwischen 0 und %g kW liegen.", float64(maxGridLimitKw))
		}
		out.MaxHouseLoadKw = v
	}
	if req.StaticBudget != nil {
		out.StaticBudget = *req.StaticBudget
	}
	// ⚠ An unknown word is REFUSED here, not normalized: this is the operator
	// typing, and a silent fallback would leave them believing they set
	// something they did not. NormalizePolicy's tolerance is for the READ
	// path, where a corrupt file must never stop a fleet.
	if req.SurplusPolicy != nil {
		v := SurplusPolicy(*req.SurplusPolicy)
		if NormalizePolicy(v) != v {
			return s, invalid("Unbekannte Überschuss-Priorität %q. Erlaubt sind %q, %q und %q.",
				*req.SurplusPolicy, PolicySolarOnly, PolicySolarFirst, PolicyFast)
		}
		out.SurplusPolicy = v
	}
	if req.StoragePriority != nil {
		v := StoragePriority(*req.StoragePriority)
		if NormalizeStorage(v) != v {
			return s, invalid("Unbekannte Speicher-Priorität %q. Erlaubt sind %q und %q.",
				*req.StoragePriority, StorageBeforeCars, CarsBeforeStorage)
		}
		out.StoragePriority = v
	}
	out = out.WithDefaults()
	if out.HouseReserveKw > out.GridLimitKw && out.GridLimitKw > 0 {
		return s, invalid("Die für das Gebäude reservierte Leistung (%g kW) ist größer als die Anschlussgrenze (%g kW).",
			out.HouseReserveKw, out.GridLimitKw)
	}
	return out, nil
}

func isBad(v float64) bool { return v != v || v > 1e12 || v < -1e12 }

// Store persists the settings.
type Store struct{ path string }

// NewStore stores lastmgmt.json under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "lastmgmt.json")}, nil
}

// Path is the file the store writes (diagnostics).
func (s *Store) Path() string { return s.path }

// Load returns the persisted settings; ok=false when nothing was stored yet
// (then the defaults apply and, without a GridLimitKw, nothing charges — which
// is the honest state of a box nobody configured).
func (s *Store) Load() (Settings, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{}.WithDefaults(), false, nil
	}
	if err != nil {
		return Settings{}.WithDefaults(), false, err
	}
	var st storedSettings
	if err := json.Unmarshal(raw, &st); err != nil {
		return Settings{}.WithDefaults(), false, fmt.Errorf("gespeicherte Lastmanagement-Einstellungen beschädigt: %w", err)
	}
	return st.settings(), true, nil
}

// Save writes the settings atomically.
func (s *Store) Save(set Settings) error {
	raw, err := json.Marshal(set.WithDefaults().stored())
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
