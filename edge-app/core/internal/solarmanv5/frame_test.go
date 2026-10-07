package solarmanv5

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// vectorsPath locates the shared vectors next to the JS source of truth, BY
// PATH - moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "deye", "solarman-v5-vectors.json")
}

type vectors struct {
	CRC16 []struct {
		Bytes string `json:"bytes"`
		CRC   uint16 `json:"crc"`
	} `json:"crc16"`
	LoggerSerial []struct {
		Input any     `json:"input"`
		Value *uint32 `json:"value"`
		Error bool    `json:"error"`
	} `json:"logger_serial"`
	ReadRequests []struct {
		Serial uint32 `json:"serial"`
		Seq    uint16 `json:"seq"`
		Slave  byte   `json:"slave"`
		Start  uint16 `json:"start"`
		Count  uint16 `json:"count"`
		Frame  string `json:"frame"`
	} `json:"read_requests"`
	WriteSingle []struct {
		Serial uint32 `json:"serial"`
		Seq    uint16 `json:"seq"`
		Slave  byte   `json:"slave"`
		Reg    uint16 `json:"reg"`
		Value  uint16 `json:"value"`
		Frame  string `json:"frame"`
	} `json:"write_single_requests"`
	WriteMultiple []struct {
		Serial uint32   `json:"serial"`
		Seq    uint16   `json:"seq"`
		Slave  byte     `json:"slave"`
		Start  uint16   `json:"start"`
		Values []uint16 `json:"values"`
		Frame  string   `json:"frame"`
	} `json:"write_multiple_requests"`
	Responses []struct {
		Name  string `json:"name"`
		Frame string `json:"frame"`
		Opts  struct {
			ExpectLoggerSerial *uint32 `json:"expectLoggerSerial"`
			ExpectSequence     *uint16 `json:"expectSequence"`
		} `json:"opts"`
		Expect struct {
			Regs  []uint16 `json:"regs"`
			Error bool     `json:"error"`
		} `json:"expect"`
	} `json:"responses"`
	WriteResponses []struct {
		Name   string `json:"name"`
		Modbus string `json:"modbus"`
		Opts   struct {
			ExpectFn byte `json:"expectFn"`
		} `json:"opts"`
		Expect struct {
			Error    bool   `json:"error"`
			Fn       byte   `json:"fn"`
			Reg      uint16 `json:"reg"`
			Value    uint16 `json:"value"`
			StartReg uint16 `json:"startReg"`
			Count    uint16 `json:"count"`
		} `json:"expect"`
	} `json:"write_responses"`
	FrameLength []struct {
		Name   string `json:"name"`
		Prefix string `json:"prefix"`
		Expect struct {
			Incomplete bool `json:"incomplete"`
			Length     int  `json:"length"`
			Error      bool `json:"error"`
		} `json:"expect"`
	} `json:"frame_length"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("gemeinsame Vektoren nicht lesbar: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren kaputt: %v", err)
	}
	return v
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSharedVectorsCRC16(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.CRC16 {
		if got := CRC16(mustHex(t, c.Bytes)); got != c.CRC {
			t.Errorf("CRC16(%s) = 0x%04x, JS sagt 0x%04x", c.Bytes, got, c.CRC)
		}
	}
}

func TestSharedVectorsLoggerSerial(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.LoggerSerial {
		got, err := NormLoggerSerial(c.Input)
		if c.Error {
			if err == nil {
				t.Errorf("Seriennummer %#v: JS lehnt ab, Go nimmt %d an", c.Input, got)
			}
			continue
		}
		if err != nil || c.Value == nil || got != *c.Value {
			t.Errorf("Seriennummer %#v: Go %d (%v), JS %v", c.Input, got, err, c.Value)
		}
	}
}

func TestSharedVectorsRequestFrames(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.ReadRequests {
		got := BuildReadRequest(c.Serial, c.Seq, c.Slave, c.Start, c.Count)
		if want := mustHex(t, c.Frame); !bytes.Equal(got, want) {
			t.Errorf("Leseanfrage %+v:\n Go %X\n JS %X", c, got, want)
		}
	}
	for _, c := range v.WriteSingle {
		got := BuildWriteSingleRequest(c.Serial, c.Seq, c.Slave, c.Reg, c.Value)
		if want := mustHex(t, c.Frame); !bytes.Equal(got, want) {
			t.Errorf("Schreibanfrage fn06 %+v:\n Go %X\n JS %X", c, got, want)
		}
	}
	for _, c := range v.WriteMultiple {
		got, err := BuildWriteMultipleRequest(c.Serial, c.Seq, c.Slave, c.Start, c.Values)
		if err != nil {
			t.Fatal(err)
		}
		if want := mustHex(t, c.Frame); !bytes.Equal(got, want) {
			t.Errorf("Schreibanfrage fn10 %+v:\n Go %X\n JS %X", c, got, want)
		}
	}
}

func TestSharedVectorsResponses(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Responses {
		opts := ParseOpts{ExpectSerial: c.Opts.ExpectLoggerSerial, ExpectSequence: c.Opts.ExpectSequence}
		regs, err := ReadRegistersFromResponse(mustHex(t, c.Frame), opts)
		if c.Expect.Error {
			if err == nil {
				t.Errorf("%s: JS lehnt ab, Go nimmt %v an", c.Name, regs)
			} else if !IsProtocolError(err) {
				t.Errorf("%s: Ablehnung ist kein ProtocolError: %v", c.Name, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: JS nimmt an, Go lehnt ab: %v", c.Name, err)
			continue
		}
		if len(regs) != len(c.Expect.Regs) {
			t.Errorf("%s: %v, JS %v", c.Name, regs, c.Expect.Regs)
			continue
		}
		for i := range regs {
			if regs[i] != c.Expect.Regs[i] {
				t.Errorf("%s: %v, JS %v", c.Name, regs, c.Expect.Regs)
				break
			}
		}
	}
}

func TestSharedVectorsWriteResponses(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.WriteResponses {
		ack, err := ParseWriteResponse(mustHex(t, c.Modbus), c.Opts.ExpectFn)
		if c.Expect.Error {
			if err == nil {
				t.Errorf("%s: JS lehnt ab, Go nimmt %+v an", c.Name, ack)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if ack.Fn != c.Expect.Fn || ack.Reg != c.Expect.Reg || ack.Value != c.Expect.Value ||
			ack.StartReg != c.Expect.StartReg || ack.Count != c.Expect.Count {
			t.Errorf("%s: Go %+v, JS %+v", c.Name, ack, c.Expect)
		}
	}
}

func TestSharedVectorsFrameLength(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.FrameLength {
		n, ok, err := ExpectedFrameLength(mustHex(t, c.Prefix))
		switch {
		case c.Expect.Error:
			if err == nil {
				t.Errorf("%s: JS Fehler, Go n=%d ok=%v", c.Name, n, ok)
			}
		case c.Expect.Incomplete:
			if err != nil || ok {
				t.Errorf("%s: JS unvollstaendig, Go n=%d ok=%v err=%v", c.Name, n, ok, err)
			}
		default:
			if err != nil || !ok || n != c.Expect.Length {
				t.Errorf("%s: JS %d, Go n=%d ok=%v err=%v", c.Name, c.Expect.Length, n, ok, err)
			}
		}
	}
}
