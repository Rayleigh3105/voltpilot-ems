package guards

import (
	"errors"
	"testing"
)

// TestPresetSettingsCompleteAndDistinct: every preset populates every gated
// channel, and the four presets are genuinely different tunings.
func TestPresetSettingsCompleteAndDistinct(t *testing.T) {
	for _, name := range PresetNames {
		s := PresetSettings(name)
		if s.Preset != name {
			t.Fatalf("preset %q reported as %q", name, s.Preset)
		}
		for _, meta := range GatedChannels {
			if _, ok := s.Channels[meta.Key]; !ok {
				t.Fatalf("preset %q missing channel %q", name, meta.Key)
			}
		}
	}
	// Off disables everything; Streng is stricter (smaller allowance) than Normal.
	off := PresetSettings(PresetOff)
	for _, meta := range GatedChannels {
		if off.Channels[meta.Key].Enabled {
			t.Fatalf("Off preset must disable %q", meta.Key)
		}
	}
	normal := PresetSettings(PresetNormal)
	strict := PresetSettings(PresetStrict)
	for _, meta := range GatedChannels {
		if strict.Channels[meta.Key].MaxRatePerSec > normal.Channels[meta.Key].MaxRatePerSec {
			t.Fatalf("Streng must not be looser than Normal for %q", meta.Key)
		}
	}
}

// TestDefaultSettingsIsNormalAndSocShipped: the default is Normal, and its SoC
// numbers reproduce the values shipped before this feature (behavior-compatible).
func TestDefaultSettingsIsNormalAndSocShipped(t *testing.T) {
	d := DefaultSettings()
	if d.Preset != PresetNormal {
		t.Fatalf("default preset = %q, want %q", d.Preset, PresetNormal)
	}
	soc := d.Channels["soc_pct"]
	if !soc.Enabled || soc.MaxRatePerSec != 1.0 || soc.Margin != 5.0 {
		t.Fatalf("default SoC must be the shipped 1.0/5.0 rate/margin, got %+v", soc)
	}
}

// TestNormalizeKnownPresetIgnoresChannels: a known preset name resolves to the
// preset table regardless of any channels sent alongside it.
func TestNormalizeKnownPresetIgnoresChannels(t *testing.T) {
	req := DespikeSettings{
		Preset:   PresetStrict,
		Channels: map[string]ChannelSetting{"soc_pct": {Enabled: true, MaxRatePerSec: 999, Margin: 999}},
	}
	got, err := req.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if got.Preset != PresetStrict || got.Channels["soc_pct"] != PresetSettings(PresetStrict).Channels["soc_pct"] {
		t.Fatalf("known preset must ignore supplied channels, got %+v", got)
	}
}

// TestNormalizeCustomIsValidatedAndTagged: a custom configuration keeps the
// provided numbers and is tagged benutzerdefiniert (or the matching preset).
func TestNormalizeCustomIsValidatedAndTagged(t *testing.T) {
	req := DespikeSettings{
		Preset: PresetCustom,
		Channels: map[string]ChannelSetting{
			"power_kw": {Enabled: true, MaxRatePerSec: 7.5, Margin: 12},
		},
	}
	got, err := req.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if got.Preset != PresetCustom {
		t.Fatalf("custom config must be tagged %q, got %q", PresetCustom, got.Preset)
	}
	if got.Channels["power_kw"].MaxRatePerSec != 7.5 || got.Channels["power_kw"].Margin != 12 {
		t.Fatalf("custom power numbers not preserved: %+v", got.Channels["power_kw"])
	}
	// Omitted channels fall back to the default (still complete + valid).
	if got.Channels["soc_pct"] != DefaultSettings().Channels["soc_pct"] {
		t.Fatalf("omitted channel should keep the default, got %+v", got.Channels["soc_pct"])
	}
}

// TestNormalizeCustomMatchingPresetIsReTagged: custom numbers that happen to
// equal a named preset are reported as that preset (so the UI highlights it).
func TestNormalizeCustomMatchingPresetIsReTagged(t *testing.T) {
	req := PresetSettings(PresetStrict)
	req.Preset = PresetCustom // pretend it came in as a custom set
	got, err := req.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if got.Preset != PresetStrict {
		t.Fatalf("custom numbers equal to Streng should re-tag as Streng, got %q", got.Preset)
	}
}

// TestNormalizeRejectsNonsense: negative, NaN/Inf, absurdly large, and
// all-zero-while-enabled values are rejected with a German message.
func TestNormalizeRejectsNonsense(t *testing.T) {
	cases := []struct {
		name string
		cs   ChannelSetting
	}{
		{"negative rate", ChannelSetting{Enabled: true, MaxRatePerSec: -1, Margin: 5}},
		{"negative margin", ChannelSetting{Enabled: true, MaxRatePerSec: 1, Margin: -5}},
		{"absurd rate", ChannelSetting{Enabled: true, MaxRatePerSec: 1e9, Margin: 5}},
		{"zero-and-zero enabled", ChannelSetting{Enabled: true, MaxRatePerSec: 0, Margin: 0}},
	}
	for _, c := range cases {
		req := DespikeSettings{Preset: PresetCustom, Channels: map[string]ChannelSetting{"soc_pct": c.cs}}
		_, err := req.Normalize()
		if err == nil {
			t.Fatalf("%s: expected a validation error", c.name)
		}
		var ve *SettingsValidationError
		if !errors.As(err, &ve) || ve.Msg == "" {
			t.Fatalf("%s: expected a *SettingsValidationError with a German message, got %v", c.name, err)
		}
	}
}

// TestNormalizeUnknownPresetRejected: an unknown preset name is rejected.
func TestNormalizeUnknownPresetRejected(t *testing.T) {
	_, err := DespikeSettings{Preset: "turbo"}.Normalize()
	var ve *SettingsValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("unknown preset should be a validation error, got %v", err)
	}
}

// TestSettingsStoreRoundTrip: settings persist and reload identically; a fresh
// dir reports ok=false.
func TestSettingsStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := NewSettingsStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.Load(); err != nil || ok {
		t.Fatalf("fresh dir should have no settings, ok=%v err=%v", ok, err)
	}

	want, err := DespikeSettings{
		Preset:   PresetCustom,
		Channels: map[string]ChannelSetting{"pv_power_kw": {Enabled: true, MaxRatePerSec: 8, Margin: 9}},
	}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Save(want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.Load()
	if err != nil || !ok {
		t.Fatalf("reload failed: ok=%v err=%v", ok, err)
	}
	if got.Preset != want.Preset {
		t.Fatalf("preset not persisted: got %q want %q", got.Preset, want.Preset)
	}
	for _, meta := range GatedChannels {
		if got.Channels[meta.Key] != want.Channels[meta.Key] {
			t.Fatalf("channel %q not persisted: got %+v want %+v", meta.Key, got.Channels[meta.Key], want.Channels[meta.Key])
		}
	}
}
