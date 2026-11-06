package sunspeclive

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "sunspec", "sunspec-live-vectors.json")
}

type vecCase struct {
	Name   string `json:"name"`
	Target struct {
		UnitID         *float64 `json:"unitId"`
		InvertGridSign bool     `json:"invertGridSign"`
		ModelType      string   `json:"modelType"`
	} `json:"target"`
	Registers [][2]json.RawMessage `json:"registers"`
	Requests  [][3]int             `json:"requests"`
	Read      any                  `json:"read"`
}

type vectors struct {
	Constants struct {
		CommonBases []int `json:"common_bases"`
		SID         int   `json:"sid"`
		EndModelID  int   `json:"end_model_id"`
		InvInt      map[string]int
		InvFloat    map[string]int
	} `json:"constants"`
	Cases []vecCase `json:"cases"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("Vektoren nicht lesbar: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren kaputt: %v", err)
	}
	if len(v.Cases) < 25 {
		t.Fatalf("zu wenige Faelle: %d", len(v.Cases))
	}
	return v
}

// registerMap turns the vector's [addr, words] segments into the device map.
func registerMap(t *testing.T, segs [][2]json.RawMessage) map[int]uint16 {
	t.Helper()
	m := map[int]uint16{}
	for _, s := range segs {
		var addr int
		var words []int
		if json.Unmarshal(s[0], &addr) != nil || json.Unmarshal(s[1], &words) != nil {
			t.Fatalf("Segment unlesbar: %s", s[0])
		}
		for i, w := range words {
			m[addr+i] = uint16(w & 0xffff)
		}
	}
	return m
}

// fakeDevice is the generator's fake socket as a Modbus TCP server: FC3 with
// every word known is answered, anything else is exception 0x02. Every request
// is logged as [unit, addr, count].
type fakeDevice struct {
	regs   map[int]uint16
	silent bool // never answers (a sleeping inverter)
	mu     sync.Mutex
	log    [][3]int
}

func (f *fakeDevice) serve(c net.Conn) {
	defer c.Close()
	for {
		req := make([]byte, 12)
		if _, err := io.ReadFull(c, req); err != nil {
			return
		}
		unit, fn := req[6], req[7]
		addr, count := int(binary.BigEndian.Uint16(req[8:])), int(binary.BigEndian.Uint16(req[10:]))
		f.mu.Lock()
		f.log = append(f.log, [3]int{int(unit), addr, count})
		f.mu.Unlock()
		if f.silent {
			continue
		}
		words := make([]uint16, 0, count)
		for i := 0; i < count; i++ {
			w, ok := f.regs[addr+i]
			if !ok {
				break
			}
			words = append(words, w)
		}
		var pdu []byte
		if fn != 3 || len(words) != count {
			pdu = []byte{fn | 0x80, 0x02}
		} else {
			pdu = make([]byte, 2+2*count)
			pdu[0], pdu[1] = 3, byte(2*count)
			for i, w := range words {
				binary.BigEndian.PutUint16(pdu[2+2*i:], w)
			}
		}
		adu := make([]byte, 7+len(pdu))
		copy(adu[0:2], req[0:2])
		binary.BigEndian.PutUint16(adu[4:], uint16(len(pdu)+1))
		adu[6] = unit
		copy(adu[7:], pdu)
		if _, err := c.Write(adu); err != nil {
			return
		}
	}
}

func (f *fakeDevice) dialer() func(ctx context.Context, address string) (net.Conn, error) {
	return func(ctx context.Context, address string) (net.Conn, error) {
		a, b := net.Pipe()
		go f.serve(b)
		return a, nil
	}
}

// jsShape renders a Result exactly like the JS reader's {reading, meta}.
func jsShape(r *Result) any {
	if r == nil {
		return nil
	}
	meta := map[string]any{"base": float64(r.Meta.Base)}
	if inv := r.Meta.Inverter; inv != nil {
		meta["inverterModel"] = float64(r.Meta.InverterModel)
		meta["inverterType"] = r.Meta.InverterType
		meta["pvSource"] = inv.PvSource
		meta["hybrid"] = inv.Hybrid
		meta["w_kw"] = inv.WKw
		meta["hz"] = nil
		if inv.Hz != nil {
			meta["hz"] = *inv.Hz
		}
		meta["st"] = float64(inv.St)
		meta["stLabel"] = nil
		if inv.StLabel != "" {
			meta["stLabel"] = inv.StLabel
		}
		meta["evt1"] = float64(inv.Evt1)
	}
	if r.Meta.Meter {
		meta["meter"] = true
	}
	reading := map[string]any{}
	for k, v := range r.Reading {
		reading[k] = v
	}
	return map[string]any{"reading": reading, "meta": meta}
}

func unitOf(c vecCase) byte {
	// makeSunspecReader: Number(unitId) > 0 ? unitId : 1.
	if c.Target.UnitID != nil && *c.Target.UnitID > 0 {
		return byte(int(*c.Target.UnitID) & 0xff)
	}
	return DefaultUnitID
}

// TestVectorsReader runs the Go reader against every vector's register map and
// demands the JS reader's requests (in order) and its result.
func TestVectorsReader(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			dev := &fakeDevice{regs: registerMap(t, c.Registers)}
			l, err := Read(context.Background(), dev.dialer(), "192.0.2.10:502", unitOf(c), time.Second, time.Second,
				Target{InvertGridSign: c.Target.InvertGridSign, ModelType: c.Target.ModelType})
			if err != nil {
				t.Fatalf("Lesen: %v", err)
			}
			dev.mu.Lock()
			got := dev.log
			dev.mu.Unlock()
			if len(c.Requests) == 0 {
				c.Requests = [][3]int{}
			}
			if got == nil {
				got = [][3]int{}
			}
			if !reflect.DeepEqual(got, c.Requests) {
				t.Fatalf("Anfragen:\n go %v\n js %v", got, c.Requests)
			}
			if l.Requests != len(c.Requests) {
				t.Fatalf("gezaehlte Anfragen %d, erwartet %d", l.Requests, len(c.Requests))
			}
			var res *Result
			if l.Found {
				res = l.Result
			}
			gotJS, _ := json.Marshal(jsShape(res))
			var gotAny any
			_ = json.Unmarshal(gotJS, &gotAny)
			if !reflect.DeepEqual(gotAny, c.Read) {
				want, _ := json.Marshal(c.Read)
				t.Fatalf("Ergebnis:\n go %s\n js %s", gotJS, want)
			}
		})
	}
}

func TestVectorsConstants(t *testing.T) {
	v := loadVectors(t)
	if !reflect.DeepEqual(v.Constants.CommonBases, CommonBases) {
		t.Fatalf("Basen: js %v, go %v", v.Constants.CommonBases, CommonBases)
	}
	if v.Constants.SID != SID || v.Constants.EndModelID != EndModelID {
		t.Fatalf("SID/Ende weichen ab")
	}
}

// The three Schramm cases are real reads: the identity of model 1 comes out
// readable (serial anonymised in the vectors).
func TestSchrammCommonModel(t *testing.T) {
	v := loadVectors(t)
	seen := 0
	for _, c := range v.Cases {
		if len(c.Name) < 9 || c.Name[:9] != "Schramm: " {
			continue
		}
		seen++
		dev := &fakeDevice{regs: registerMap(t, c.Registers)}
		l, err := Read(context.Background(), dev.dialer(), "192.0.2.10:502", 1, time.Second, time.Second, Target{})
		if err != nil || !l.Found {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if l.Common.Hersteller != "KACO new energy" || l.Common.Version != "V2.30" || l.Common.Modell == "" || l.Common.Seriennummer == "" {
			t.Fatalf("%s: Common %+v", c.Name, l.Common)
		}
	}
	if seen != 3 {
		t.Fatalf("Schramm-Faelle: %d", seen)
	}
}

func TestTransportFailures(t *testing.T) {
	refused := func(ctx context.Context, address string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	}
	if _, err := Read(context.Background(), refused, "192.0.2.10:502", 1, time.Second, time.Second, Target{}); err == nil || !IsDialError(err) {
		t.Fatalf("Verbindung abgewiesen: %v", err)
	}
	// A device that accepts the connection but never answers (an inverter
	// asleep at night): the read ends with a timeout, never with a value.
	silent := &fakeDevice{silent: true}
	start := time.Now()
	_, err := Read(context.Background(), silent.dialer(), "192.0.2.10:502", 1, time.Second, 150*time.Millisecond, Target{})
	var ne net.Error
	if err == nil || !errors.As(err, &ne) || !ne.Timeout() {
		t.Fatalf("stilles Geraet: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("Timeout zu spaet")
	}
	// The caller's context ends a hanging read too.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := Read(ctx, silent.dialer(), "192.0.2.10:502", 1, time.Second, 10*time.Second, Target{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Kontext: %v", err)
	}
}

// A device that refuses one read in the middle of the list (seen live on a
// Powador 14.0 TL3: the header of model 103 refused once in 18 reads) ends
// the walk with what was read - and names where it stopped.
func TestARefusedHeaderEndsTheWalkAndIsNamed(t *testing.T) {
	v := loadVectors(t)
	regs := registerMap(t, v.Cases[0].Registers)
	delete(regs, 40070) // the 103 header now answers with an exception
	dev := &fakeDevice{regs: regs}
	l, err := Read(context.Background(), dev.dialer(), "192.0.2.10:502", 1, time.Second, time.Second, Target{})
	if err != nil || !l.Found || l.Result != nil {
		t.Fatalf("Lesung: %+v %v", l, err)
	}
	if l.Requests != 4 || l.Stopped != "40070: modbus exception fc=0x03 code=2" {
		t.Fatalf("Abbruch: %d Anfragen, %q", l.Requests, l.Stopped)
	}
}
