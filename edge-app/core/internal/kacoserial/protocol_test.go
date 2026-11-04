package kacoserial

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "kaco", "kaco-serial-vectors.json")
}

type jsParsed struct {
	Address          int     `json:"address"`
	Status           float64 `json:"status"`
	DcVoltageV       float64 `json:"dcVoltageV"`
	DcCurrentA       float64 `json:"dcCurrentA"`
	DcPowerW         float64 `json:"dcPowerW"`
	AcVoltageV       float64 `json:"acVoltageV"`
	AcCurrentA       float64 `json:"acCurrentA"`
	AcPowerW         float64 `json:"acPowerW"`
	TemperatureC     float64 `json:"temperatureC"`
	DailyYieldWh     float64 `json:"dailyYieldWh"`
	InverterType     string  `json:"inverterType"`
	ChecksumOk       bool    `json:"checksumOk"`
	ChecksumExpected byte    `json:"checksumExpected"`
	ChecksumActual   byte    `json:"checksumActual"`
	Error            bool    `json:"error"`
}

type jsDecode struct {
	Reading map[string]float64 `json:"reading"`
	Meta    struct {
		Status         float64 `json:"status"`
		DcVoltageV     float64 `json:"dc_voltage_v"`
		DcCurrentA     float64 `json:"dc_current_a"`
		AcVoltageV     float64 `json:"ac_voltage_v"`
		AcCurrentA     float64 `json:"ac_current_a"`
		TempC          float64 `json:"temp_c"`
		EnergyTodayKwh float64 `json:"energy_today_kwh"`
		ChecksumOk     bool    `json:"checksum_ok"`
		InverterType   string  `json:"inverter_type"`
		AcKw           float64 `json:"ac_kw"`
		DcKw           float64 `json:"dc_kw"`
	} `json:"meta"`
	Address    int  `json:"address"`
	ChecksumOk bool `json:"checksumOk"`
}

type vectorFile struct {
	Constants struct {
		MinAddress     int            `json:"min_address"`
		MaxAddress     int            `json:"max_address"`
		DefaultPort    int            `json:"default_port"`
		DefaultAddress int            `json:"default_address"`
		CmdMeasure     string         `json:"cmd_measure"`
		Cmd0MinLen     int            `json:"cmd0_min_len"`
		Families       []string       `json:"families"`
		Offsets        map[string]any `json:"offsets"`
		SerialParams   map[string]any `json:"serial_params"`
	} `json:"constants"`
	BuildRequest []struct {
		Address int    `json:"address"`
		Command string `json:"command"`
		Hex     string `json:"hex"`
		Error   bool   `json:"error"`
	} `json:"build_request"`
	Checksum []struct {
		Hex string `json:"hex"`
		Sum byte   `json:"sum"`
	} `json:"checksum"`
	Cases []struct {
		Name             string  `json:"name"`
		Hex              string  `json:"hex"`
		Trim             string  `json:"trim"`
		Complete         bool    `json:"complete"`
		ReplyCommandByte *string `json:"reply_command_byte"`
		ProtocolMismatch bool    `json:"protocol_mismatch"`
		VerifyChecksum   struct {
			OK       bool `json:"ok"`
			Expected byte `json:"expected"`
			Actual   byte `json:"actual"`
		} `json:"verify_checksum"`
		Parse                 jsParsed  `json:"parse"`
		Decode                *jsDecode `json:"decode"`
		DecodeRequireChecksum *jsDecode `json:"decode_require_checksum"`
	} `json:"cases"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("gemeinsame Vektoren nicht lesbar: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren kaputt: %v", err)
	}
	if len(v.Cases) < 50 {
		t.Fatalf("zu wenige Faelle: %d", len(v.Cases))
	}
	return v
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

func TestConstantsMatchTheJSModule(t *testing.T) {
	c := loadVectors(t).Constants
	if c.MinAddress != MinAddress || c.MaxAddress != MaxAddress || c.DefaultPort != DefaultPort || c.DefaultAddress != DefaultAddress {
		t.Fatalf("Adress-/Port-Konstanten weichen ab: %+v", c)
	}
	if c.CmdMeasure != string(CmdMeasure) || c.Cmd0MinLen != Cmd0MinLen {
		t.Fatalf("Kommando/Mindestlaenge weichen ab: %+v", c)
	}
	if len(c.Families) != 1 || c.Families[0] != Family {
		t.Fatalf("Familien weichen ab: %v", c.Families)
	}
	offs := map[string]span{"status": offStatus, "dcVoltage": offDcVoltage, "dcCurrent": offDcCurrent, "dcPower": offDcPower,
		"acVoltage": offAcVoltage, "acCurrent": offAcCurrent, "acPower": offAcPower, "temperature": offTemperature, "dailyYieldWh": offDailyYieldWh}
	for name, s := range offs {
		want, _ := c.Offsets[name].([]any)
		if len(want) != 2 || int(want[0].(float64)) != s.from || int(want[1].(float64)) != s.to {
			t.Errorf("Offset %s: Go %v, JS %v", name, s, c.Offsets[name])
		}
	}
	if int(c.Offsets["checksumSpace"].(float64)) != offChecksumSp || int(c.Offsets["checksum"].(float64)) != offChecksum {
		t.Errorf("Pruefsummen-Offsets: JS %v", c.Offsets)
	}
}

func TestBuildRequestMatchesTheJSModule(t *testing.T) {
	for _, r := range loadVectors(t).BuildRequest {
		if len(r.Command) != 1 {
			// Go takes one byte by type; the JS RangeError for '' / '00' is a form check the type system does here.
			if !r.Error {
				t.Errorf("command %q: JS akzeptiert, Go kann nicht", r.Command)
			}
			continue
		}
		got, err := BuildRequest(r.Address, r.Command[0])
		if r.Error {
			if err == nil {
				t.Errorf("buildRequest(%d, %q) muss scheitern, Go %x", r.Address, r.Command, got)
			}
			continue
		}
		if err != nil || hex.EncodeToString(got) != r.Hex {
			t.Errorf("buildRequest(%d, %q) = %x %v, JS %s", r.Address, r.Command, got, err, r.Hex)
		}
	}
}

func TestChecksumMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Checksum {
		if got := Checksum(unhex(t, c.Hex)); got != c.Sum {
			t.Errorf("kacoChecksum(%s) = %d, JS %d", c.Hex, got, c.Sum)
		}
	}
}

func TestFramingAndDecodeMatchTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			raw := unhex(t, c.Hex)
			if got := hex.EncodeToString(TrimLeadingJunk(raw)); got != c.Trim {
				t.Errorf("trimLeadingJunk: Go %s, JS %s", got, c.Trim)
			}
			if got := IsCmd0Complete(raw); got != c.Complete {
				t.Errorf("isCmd0Complete: Go %v, JS %v", got, c.Complete)
			}
			cmd, ok := ReplyCommandByte(raw)
			if ok != (c.ReplyCommandByte != nil) || (ok && string(cmd) != *c.ReplyCommandByte) {
				t.Errorf("replyCommandByte: Go %q/%v, JS %v", cmd, ok, c.ReplyCommandByte)
			}
			if got := ProtocolMismatch(raw); got != c.ProtocolMismatch {
				t.Errorf("protocolMismatch: Go %v, JS %v", got, c.ProtocolMismatch)
			}
			v := VerifyCmd0Checksum(raw)
			if v.OK != c.VerifyChecksum.OK || v.Expected != c.VerifyChecksum.Expected || v.Actual != c.VerifyChecksum.Actual {
				t.Errorf("verifyCmd0Checksum: Go %+v, JS %+v", v, c.VerifyChecksum)
			}

			p, err := ParseCmd0(raw)
			if c.Parse.Error {
				var pe *ParseError
				if err == nil || !errors.As(err, &pe) {
					t.Fatalf("parseCmd0: JS ParseError, Go %+v %v", p, err)
				}
			} else {
				if err != nil {
					t.Fatalf("parseCmd0: JS %+v, Go Fehler %v", c.Parse, err)
				}
				want := c.Parse
				got := jsParsed{Address: p.Address, Status: p.Status, DcVoltageV: p.DcVoltageV, DcCurrentA: p.DcCurrentA, DcPowerW: p.DcPowerW,
					AcVoltageV: p.AcVoltageV, AcCurrentA: p.AcCurrentA, AcPowerW: p.AcPowerW, TemperatureC: p.TemperatureC, DailyYieldWh: p.DailyYieldWh,
					InverterType: p.InverterType, ChecksumOk: p.ChecksumOk, ChecksumExpected: p.ChecksumExpected, ChecksumActual: p.ChecksumActual}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("parseCmd0:\n Go %+v\n JS %+v", got, want)
				}
			}

			checkDecode(t, "decode", Decode(raw, false), c.Decode)
			checkDecode(t, "decode(requireChecksum)", Decode(raw, true), c.DecodeRequireChecksum)
		})
	}
}

func checkDecode(t *testing.T, what string, got *Result, want *jsDecode) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Errorf("%s: JS null, Go %+v", what, got)
		}
		return
	}
	if got == nil {
		t.Fatalf("%s: JS %+v, Go nil", what, want)
	}
	if !reflect.DeepEqual(got.Reading, want.Reading) || got.Address != want.Address || got.ChecksumOk != want.ChecksumOk {
		t.Errorf("%s: Go reading %v addr %d ok %v, JS %v %d %v", what, got.Reading, got.Address, got.ChecksumOk, want.Reading, want.Address, want.ChecksumOk)
	}
	m, w := got.Meta, want.Meta
	if m.Status != w.Status || m.DcVoltageV != w.DcVoltageV || m.DcCurrentA != w.DcCurrentA || m.AcVoltageV != w.AcVoltageV ||
		m.AcCurrentA != w.AcCurrentA || m.TempC != w.TempC || m.EnergyTodayKwh != w.EnergyTodayKwh || m.ChecksumOk != w.ChecksumOk ||
		m.InverterType != w.InverterType || m.AcKw != w.AcKw || m.DcKw != w.DcKw {
		t.Errorf("%s meta:\n Go %+v\n JS %+v", what, m, w)
	}
}

func TestJSNumberEdges(t *testing.T) {
	for s, want := range map[string]float64{"": 0, "7": 7, "-0": 0, "1e3": 1000, "0x1F": 31, ".5": 0.5, "5.": 5, "+3": 3, "0b101": 5, "0o17": 15} {
		if got := jsNumber(s); got != want {
			t.Errorf("Number(%q) = %v, want %v", s, got, want)
		}
	}
	for _, s := range []string{"1x", "1,5", "1_000", "NaN", "Inf", "0x", "0x1p3", "++1", "1e", "--"} {
		if got := jsNumber(s); got == got { // not NaN
			t.Errorf("Number(%q) = %v, want NaN", s, got)
		}
	}
}
