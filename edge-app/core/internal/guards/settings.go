package guards

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// The despike gate is operator-configurable on the edge device: the customer
// decides, per channel, "ab wann ein Wert als sprunghaft gilt" (from what point
// a value counts as jumpy). The knobs are deliberately toddler-simple: a single
// global sensitivity preset (Aus / Locker / Normal / Streng) picks safe numbers
// for every channel, and an expert can still override the raw numbers per
// channel. Settings persist in the data dir (despike.json) and apply live -
// no container restart. See NewDespiker / Despiker.Reconfigure.

// Preset ids. "benutzerdefiniert" is not a real preset - it is the state the
// settings fall into once an expert edits the raw per-channel numbers.
const (
	PresetOff    = "aus"    // gate disabled on every channel (values pass through raw)
	PresetLoose  = "locker" // very generous - only gross garbage is caught
	PresetNormal = "normal" // the safe default: real dynamics pass, garbage is caught
	PresetStrict = "streng" // tight - catches smaller in-band excursions too
	PresetCustom = "benutzerdefiniert"
)

// DefaultPreset is what a fresh device (no despike.json) starts on: safe,
// conservative, chosen so real household/PV dynamics are NEVER eaten while the
// captain's transient in-band garbage is caught.
const DefaultPreset = PresetNormal

// ChannelSetting is the operator-facing tuning of ONE channel's spike gate.
//
// A reading is "suspect" (a candidate spike) when it jumps more than
// MaxRatePerSec*elapsed + Margin away from the last accepted value. A suspect
// jump is dropped (and the last good value is held in its place - see
// Despiker.Accept), unless it PERSISTS, in which case the new level is adopted
// (accept-after-confirmation). Expressing the threshold as a rate makes it
// physically intuitive and lets the same model serve every channel:
//
//   - SoC is integrative and cannot step fast -> a tight %-Punkte/s bound.
//   - Power channels CAN step fast (a cloud edge, a load switching on) -> a
//     generous kW/s bound, so genuine dynamics pass immediately and only larger,
//     reverting excursions are caught.
type ChannelSetting struct {
	Enabled       bool    `json:"enabled"`
	MaxRatePerSec float64 `json:"max_rate_per_sec"` // allowed change per second, channel's natural unit
	Margin        float64 `json:"margin"`           // base slack (noise/rounding), channel's natural unit
}

// DespikeSettings is the whole persisted configuration: the chosen preset plus
// the effective per-channel numbers (kept explicit so the API always shows the
// operator the actual values, even when a preset drives them).
type DespikeSettings struct {
	Preset   string                    `json:"preset"`
	Channels map[string]ChannelSetting `json:"channels"`
}

// DespikeStatus is the full settings surface the local web app renders: the
// current configuration, per-channel rejection counters (so the operator can
// see the filter working), and the channel/preset metadata that makes the form
// data-driven.
type DespikeStatus struct {
	Settings DespikeSettings `json:"settings"`
	Counters map[string]int  `json:"counters"`
	Channels []ChannelMeta   `json:"channels"`
	Presets  []string        `json:"presets"`
}

// ChannelMeta describes a gated channel for the settings UI (labels + units +
// plain-German help), so the front-end form is fully data-driven.
type ChannelMeta struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Unit     string `json:"unit"`      // the value's unit, e.g. "kW" or "%-Punkte"
	RateUnit string `json:"rate_unit"` // the rate unit, e.g. "kW/s"
	Help     string `json:"help"`
}

// GatedChannels is the fixed set of channels the despiker gates, in display
// order. grid_limit_kw is included but tuned loosely: a §14a envelope change is
// a legitimate (usually small) step that the margin lets through, while a gross
// garbage read is still caught.
var GatedChannels = []ChannelMeta{
	{Key: "soc_pct", Label: "Batterie-Ladestand", Unit: "%-Punkte", RateUnit: "%-Punkte/s",
		Help: "Der Ladestand kann sich physikalisch nur langsam ändern. Sprünge über die erlaubte Rate hinaus (z. B. von 94 % auf 2 % und zurück) werden als Ausreißer erkannt."},
	{Key: "power_kw", Label: "Netzleistung", Unit: "kW", RateUnit: "kW/s",
		Help: "Bezug bzw. Einspeisung am Netzanschluss. Darf schnell springen (z. B. wenn ein großer Verbraucher zuschaltet), daher großzügig eingestellt - nur grobe Ausreißer werden gefiltert."},
	{Key: "pv_power_kw", Label: "PV-Erzeugung", Unit: "kW", RateUnit: "kW/s",
		Help: "Solarleistung. Darf bei Wolkenlücken schnell springen; nur unrealistisch große, kurz aufblitzende Werte werden gefiltert."},
	{Key: "load_kw", Label: "Hausverbrauch", Unit: "kW", RateUnit: "kW/s",
		Help: "Verbrauch im Haus. Darf beim Zuschalten von Geräten schnell springen; nur grobe Ausreißer werden gefiltert."},
	{Key: "grid_limit_kw", Label: "Netz-Einspeiselimit (§14a)", Unit: "kW", RateUnit: "kW/s",
		Help: "Vom Netzbetreiber vorgegebene Leistungsgrenze. Echte, dauerhafte Änderungen werden übernommen; nur einzelne Ausreißer werden gefiltert."},
}

// presetTable holds the concrete per-channel numbers each preset applies. SoC
// "normal" reproduces the values shipped before this feature; the power
// channels get conservative in-band defaults that never eat real dynamics.
var presetTable = map[string]map[string]ChannelSetting{
	PresetOff: {
		"soc_pct":       {Enabled: false, MaxRatePerSec: 1.0, Margin: 5.0},
		"power_kw":      {Enabled: false, MaxRatePerSec: 15.0, Margin: 15.0},
		"pv_power_kw":   {Enabled: false, MaxRatePerSec: 15.0, Margin: 15.0},
		"load_kw":       {Enabled: false, MaxRatePerSec: 15.0, Margin: 15.0},
		"grid_limit_kw": {Enabled: false, MaxRatePerSec: 10.0, Margin: 15.0},
	},
	PresetLoose: {
		"soc_pct":       {Enabled: true, MaxRatePerSec: 2.0, Margin: 10.0},
		"power_kw":      {Enabled: true, MaxRatePerSec: 30.0, Margin: 30.0},
		"pv_power_kw":   {Enabled: true, MaxRatePerSec: 30.0, Margin: 30.0},
		"load_kw":       {Enabled: true, MaxRatePerSec: 30.0, Margin: 30.0},
		"grid_limit_kw": {Enabled: true, MaxRatePerSec: 20.0, Margin: 30.0},
	},
	PresetNormal: {
		"soc_pct":       {Enabled: true, MaxRatePerSec: 1.0, Margin: 5.0},
		"power_kw":      {Enabled: true, MaxRatePerSec: 15.0, Margin: 15.0},
		"pv_power_kw":   {Enabled: true, MaxRatePerSec: 15.0, Margin: 15.0},
		"load_kw":       {Enabled: true, MaxRatePerSec: 15.0, Margin: 15.0},
		"grid_limit_kw": {Enabled: true, MaxRatePerSec: 10.0, Margin: 15.0},
	},
	// Streng is the tight opt-in. Its power numbers are sized so a genuine ~10 s
	// sample cadence still catches a tens-of-kW single-sample step: allowed change
	// = margin + rate*elapsed = 5 + 1*10 = 15 kW at 10 s, so the captain's ~4 kW ->
	// ~26 kW spike (a 22 kW jump) is caught. accept-after-confirmation still lets a
	// genuinely sustained step converge (it is adopted after confirmCount samples),
	// so real dynamics are delayed at most, never lost. (The rate term scales with
	// the real gap, so at a faster cadence the bound is proportionally tighter.)
	PresetStrict: {
		"soc_pct":       {Enabled: true, MaxRatePerSec: 0.5, Margin: 3.0},
		"power_kw":      {Enabled: true, MaxRatePerSec: 1.0, Margin: 5.0},
		"pv_power_kw":   {Enabled: true, MaxRatePerSec: 1.0, Margin: 5.0},
		"load_kw":       {Enabled: true, MaxRatePerSec: 1.0, Margin: 5.0},
		"grid_limit_kw": {Enabled: true, MaxRatePerSec: 1.0, Margin: 5.0},
	},
}

// PresetNames lists the real presets (excluding "benutzerdefiniert"), in the
// order the UI shows them.
var PresetNames = []string{PresetOff, PresetLoose, PresetNormal, PresetStrict}

// PresetSettings returns the settings for a named preset. An unknown name
// falls back to the default preset.
func PresetSettings(preset string) DespikeSettings {
	tbl, ok := presetTable[preset]
	if !ok {
		preset = DefaultPreset
		tbl = presetTable[preset]
	}
	channels := make(map[string]ChannelSetting, len(tbl))
	for k, v := range tbl {
		channels[k] = v
	}
	return DespikeSettings{Preset: preset, Channels: channels}
}

// DefaultSettings is the built-in configuration (the default preset).
func DefaultSettings() DespikeSettings { return PresetSettings(DefaultPreset) }

// SettingsValidationError carries a customer-facing German message; the web
// layer maps it to HTTP 400.
type SettingsValidationError struct{ Msg string }

func (e *SettingsValidationError) Error() string { return e.Msg }

// bounds for a sane, non-nonsensical configuration (per channel).
const (
	maxConfigRatePerSec = 100000.0 // 100 MW/s or 100000 %/s - anything above is nonsense
	maxConfigMargin     = 1000000.0
)

// Normalize resolves a settings request into a validated, fully-populated
// configuration. A known preset (aus/locker/normal/streng) ignores any supplied
// channels and uses the preset table. Otherwise the request is treated as a
// custom configuration: every gated channel's numbers are validated, and the
// preset is recorded as "benutzerdefiniert". A bad value is a
// *SettingsValidationError with a German message.
func (req DespikeSettings) Normalize() (DespikeSettings, error) {
	preset := strings.TrimSpace(req.Preset)
	if _, ok := presetTable[preset]; ok {
		return PresetSettings(preset), nil
	}
	if preset != "" && preset != PresetCustom {
		return DespikeSettings{}, &SettingsValidationError{Msg: "Unbekannte Empfindlichkeitsstufe."}
	}
	// Custom: start from the default so a partial request stays complete, then
	// overlay and validate the provided channels.
	out := DefaultSettings()
	out.Preset = PresetCustom
	for _, meta := range GatedChannels {
		cs, ok := req.Channels[meta.Key]
		if !ok {
			continue // keep the default for a channel the request omitted
		}
		if err := validateChannel(meta, cs); err != nil {
			return DespikeSettings{}, err
		}
		out.Channels[meta.Key] = cs
	}
	// If the custom numbers happen to equal a named preset exactly, report that
	// preset instead of "benutzerdefiniert" so the UI highlights the right button.
	if name, ok := matchPreset(out.Channels); ok {
		out.Preset = name
	}
	return out, nil
}

func validateChannel(meta ChannelMeta, cs ChannelSetting) error {
	bad := func(format string, a ...any) error {
		return &SettingsValidationError{Msg: fmt.Sprintf(format, a...)}
	}
	if math.IsNaN(cs.MaxRatePerSec) || math.IsInf(cs.MaxRatePerSec, 0) ||
		math.IsNaN(cs.Margin) || math.IsInf(cs.Margin, 0) {
		return bad("Ungültiger Zahlenwert bei „%s“.", meta.Label)
	}
	if cs.MaxRatePerSec < 0 {
		return bad("Die maximale Änderung pro Sekunde bei „%s“ darf nicht negativ sein.", meta.Label)
	}
	if cs.Margin < 0 {
		return bad("Der Toleranzwert bei „%s“ darf nicht negativ sein.", meta.Label)
	}
	if cs.MaxRatePerSec > maxConfigRatePerSec {
		return bad("Die maximale Änderung pro Sekunde bei „%s“ ist unrealistisch hoch.", meta.Label)
	}
	if cs.Margin > maxConfigMargin {
		return bad("Der Toleranzwert bei „%s“ ist unrealistisch hoch.", meta.Label)
	}
	if cs.Enabled && cs.MaxRatePerSec == 0 && cs.Margin == 0 {
		return bad("Bei „%s“ würde mit Rate 0 und Toleranz 0 jeder Messwert gefiltert. Bitte einen Wert > 0 setzen oder den Filter für diesen Kanal ausschalten.", meta.Label)
	}
	return nil
}

// matchPreset reports the named preset whose channels equal the given ones, so
// the UI can highlight it instead of "benutzerdefiniert".
func matchPreset(channels map[string]ChannelSetting) (string, bool) {
	for _, name := range PresetNames {
		if channelsEqual(presetTable[name], channels) {
			return name, true
		}
	}
	return "", false
}

func channelsEqual(a, b map[string]ChannelSetting) bool {
	for _, meta := range GatedChannels {
		if a[meta.Key] != b[meta.Key] {
			return false
		}
	}
	return true
}

// SettingsStore persists the despike configuration across restarts under
// data_dir/despike.json, mirroring inverter.Store's atomic write.
type SettingsStore struct{ path string }

// NewSettingsStore stores the configuration under dir (created if needed).
func NewSettingsStore(dir string) (*SettingsStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &SettingsStore{path: filepath.Join(dir, "despike.json")}, nil
}

// Save writes the settings atomically.
func (s *SettingsStore) Save(cfg DespikeSettings) error {
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted settings, ok=false if none exists yet. A stored
// file is re-normalized so an out-of-date/partial file still yields a complete,
// valid configuration.
func (s *SettingsStore) Load() (DespikeSettings, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return DespikeSettings{}, false, nil
	}
	if err != nil {
		return DespikeSettings{}, false, err
	}
	var cfg DespikeSettings
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return DespikeSettings{}, false, fmt.Errorf("gespeicherte Filter-Einstellungen beschädigt: %w", err)
	}
	norm, err := cfg.Normalize()
	if err != nil {
		return DespikeSettings{}, false, err
	}
	return norm, true, nil
}
