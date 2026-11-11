// Package sunspeclive is the Go twin of the Docker box's SunSpec live read
// path: edge-app/nodered/sunspec/sunspec-live.js (makeSunspecReader, the
// measurement decode) on top of model-discovery.js (discover, the model walk).
// Edge Light reads a SunSpec inverter with it - the KACO-own line (Powador TL3,
// blueplanet TL1/TL3) under `sunspec_tcp` and a Fronius Eco under the persisted
// `fronius_sunspec`; both ids are ONE way (inverter.IsSunSpecTCP).
//
// One read is ONE TCP session: the walk looks for "SunS" at 40000, 50000 and 0
// (in that order), follows the model list from the first base that carries it
// and reads every model body in FC3 chunks of at most 125 registers - exactly
// the requests of the JS reader (the shared vectors pin the sequence). The
// decode then works on the collected image: the inverter model (int+SF
// 101/102/103 or float 111/112/113, the first in the list) gives the PV, a float
// meter model (211/212/213) the signed grid power. Field ADDRESSES are the
// discovered model body + the fixed SunSpec offset, never an absolute table.
//
// READ-ONLY: FC3 only, never a write. Every channel is optional - a value is
// present only when it was read and is finite; on a hybrid (model 124 present)
// the PV comes from DC power, never from AC W.
//
// Shared vectors: edge-app/nodered/sunspec/sunspec-live-vectors.json (generated
// from the JS reader by sunspec-live-vectors.gen.js; three cases are raw reads
// of real KACO Powador TL3).
package sunspeclive

import (
	"context"
	"errors"
	"math"
	"net"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
)

// Protocol constants (model-discovery.js / sunspec-live.js).
const (
	SID           = 0x53756e53 // "SunS"
	EndModelID    = 0xffff     // the linked-list terminator
	DefaultPort   = 502
	DefaultUnitID = 1
	MaxModels     = 256  // runaway guard (a real device has ~10)
	MaxSpan       = 8192 // registers; the discovery's upper bound for the list
	MaxBodyChunk  = 125  // FC3 maximum per request

	int16NotImplemented = -32768
)

// CommonBases are the SunSpec base addresses in probe order.
var CommonBases = []int{40000, 50000, 0}

// Model ids and the classification of the measurement models.
var (
	InverterIntSF = map[int]string{101: "single", 102: "split", 103: "three"}
	InverterFloat = map[int]string{111: "single", 112: "split", 113: "three"}
	MeterFloat    = map[int]string{211: "single", 212: "split", 213: "three"}
)

const modelStorage = 124

// Body-relative offsets of the inverter models (sunspec-live.js INV_INT /
// INV_FLOAT) and of the float meter (MET_FLOAT).
var (
	invInt   = struct{ W, WSF, Hz, HzSF, DCW, DCWSF, St, Evt1 int }{12, 13, 14, 15, 29, 30, 36, 38}
	invFloat = struct{ W, Hz, DCW, St, Evt1 int }{20, 22, 36, 46, 48}
	metFloat = struct{ W int }{26}
)

// InvState is the SunSpec operating-state enum (St of the 10X/11X models).
var InvState = map[int]string{1: "OFF", 2: "SLEEPING", 3: "STARTING", 4: "MPPT", 5: "THROTTLED",
	6: "SHUTTING_DOWN", 7: "FAULT", 8: "STANDBY"}

// ----------------------------------------------------------------- the image

// Image is the register image one walk collected: absolute address -> word.
type Image map[int]uint16

// Block is the JS readBlock over the image: the words from addr on, stopping
// at the first address the walk did not read.
func (im Image) Block(addr, count int) []uint16 {
	out := make([]uint16, 0, count)
	for i := 0; i < count; i++ {
		w, ok := im[addr+i]
		if !ok {
			break
		}
		out = append(out, w)
	}
	return out
}

// words is readWords/safeRead: exactly count words or nil.
func (im Image) words(addr, count int) []uint16 {
	b := im.Block(addr, count)
	if len(b) < count {
		return nil
	}
	return b
}

// ------------------------------------------------------------------ the walk

// Holder is the one session a walk talks over (modbustcp.Client).
type Holder interface {
	ReadHolding(addr, count uint16) ([]uint16, error)
}

// Rejected reports whether err is the device's answer (a Modbus exception or a
// malformed/foreign frame) rather than a transport failure. A rejection only
// ends this part of the walk - the JS reader's rej(); a transport failure ends
// the read without a value - its done(null).
func Rejected(err error) bool {
	return modbustcp.IsException(err) || strings.HasPrefix(err.Error(), "modbus:")
}

// WalkResult is what one walk collected.
type WalkResult struct {
	Image    Image
	Found    bool // a base carried "SunS"
	Requests int  // FC3 requests sent
	// Stopped names the refused read that ended the walk early ("" = the walk
	// reached the end marker or MaxModels): the address and the device's
	// answer, e.g. "40070: modbus exception fc=0x03 code=6".
	Stopped string
}

// Walk is makeSunspecReader's socket walk: for each base the SID; from the
// first base that carries "SunS" every model header and body (chunks of at most
// MaxBodyChunk) until the end marker, MaxModels or the first refused read.
// Found=false: no base carried the marker. err != nil is a transport failure:
// nothing of the image is usable then.
func Walk(h Holder, bases []int) (WalkResult, error) {
	img, found, n, stopped, err := walk(h, bases)
	return WalkResult{Image: img, Found: found, Requests: n, Stopped: stopped}, err
}

func walk(h Holder, bases []int) (img Image, found bool, requests int, stopped string, err error) {
	img = Image{}
	read := func(addr, count int) ([]uint16, error) {
		requests++
		return h.ReadHolding(uint16(addr&0xffff), uint16(count))
	}
	stop := func(addr int, err error) string { return strconv.Itoa(addr) + ": " + err.Error() }
	for _, base := range bases {
		sid, err := read(base, 2)
		if err != nil {
			if !Rejected(err) {
				return nil, false, requests, "", err
			}
			continue
		}
		if len(sid) < 2 || u32(sid[0], sid[1]) != SID {
			continue
		}
		img[base], img[base+1] = sid[0], sid[1]
		addr := base + 2
		for i := 0; i < MaxModels; i++ {
			hdr, err := read(addr, 2)
			if err != nil {
				if !Rejected(err) {
					return nil, false, requests, "", err
				}
				stopped = stop(addr, err)
				break // truncated / end of the readable image - keep what we have
			}
			id, ln := int(hdr[0]), int(hdr[1])
			img[addr], img[addr+1] = hdr[0], hdr[1]
			if id == EndModelID {
				break
			}
			if ln > 0 && ln <= MaxSpan {
				body, err := readBody(read, addr+2, ln)
				if err != nil {
					if !Rejected(err) {
						return nil, false, requests, "", err
					}
					stopped = stop(addr+2, err)
					break
				}
				for j, w := range body {
					img[addr+2+j] = w
				}
			}
			addr += 2 + ln
		}
		return img, true, requests, stopped, nil
	}
	return img, false, requests, "", nil
}

func readBody(read func(addr, count int) ([]uint16, error), addr, ln int) ([]uint16, error) {
	out := make([]uint16, 0, ln)
	for rest := ln; rest > 0; {
		n := rest
		if n > MaxBodyChunk {
			n = MaxBodyChunk
		}
		part, err := read(addr, n)
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
		addr += n
		rest -= n
	}
	return out, nil
}

// ------------------------------------------------------------- the discovery

// Model is one entry of the discovered model list.
type Model struct {
	ID, Len, HeaderAddr, BodyAddr int
}

// Inverter is the classified inverter measurement model.
type Inverter struct {
	ID     int
	Type   string // "int_sf" | "float"
	Phases string // "single" | "split" | "three" - the MODEL's, never the device's
}

// Discovery is discover()'s result as far as the measurement decode needs it.
type Discovery struct {
	OK        bool
	Base      int
	Reason    string
	Truncated bool
	Models    []Model
	Inverter  *Inverter
	Storage   bool // model 124 present: a hybrid, the PV comes from DC power
	byID      map[int]Model
}

// Discover is model-discovery.js discover() over an image: the first of bases
// with a "SunS" marker wins; without one the first base's reason comes back.
func Discover(img Image, bases []int) Discovery {
	var first *Discovery
	for _, base := range bases {
		d := discoverAt(img, base)
		if d.OK {
			return d
		}
		if first == nil {
			first = &d
		}
	}
	if first != nil {
		return *first
	}
	return Discovery{Base: 40000, Reason: "keine Basis"}
}

func discoverAt(img Image, base int) Discovery {
	sid := img.words(base, 2)
	if sid == nil {
		return Discovery{Base: base, Reason: "SID nicht lesbar"}
	}
	if u32(sid[0], sid[1]) != SID {
		return Discovery{Base: base, Reason: "kein SunS-Marker"}
	}
	var models []Model
	addr := base + 2
	truncated := false
	for i := 0; i < MaxModels; i++ {
		if addr-base > MaxSpan {
			truncated = true
			break
		}
		hdr := img.words(addr, 2)
		if hdr == nil {
			truncated = true
			break
		}
		id, ln := int(hdr[0]), int(hdr[1])
		if id == EndModelID {
			break
		}
		if ln > MaxSpan {
			truncated = true
			break
		}
		models = append(models, Model{ID: id, Len: ln, HeaderAddr: addr, BodyAddr: addr + 2})
		addr += 2 + ln
	}
	d := Discovery{OK: true, Base: base, Truncated: truncated, Models: models, byID: map[int]Model{}}
	for _, m := range models {
		if _, seen := d.byID[m.ID]; !seen {
			d.byID[m.ID] = m // first occurrence wins
		}
	}
	for _, m := range models {
		if ph, ok := InverterIntSF[m.ID]; ok {
			d.Inverter = &Inverter{ID: m.ID, Type: "int_sf", Phases: ph}
			break
		}
		if ph, ok := InverterFloat[m.ID]; ok {
			d.Inverter = &Inverter{ID: m.ID, Type: "float", Phases: ph}
			break
		}
	}
	_, d.Storage = d.byID[modelStorage]
	return d
}

// ---------------------------------------------------------------- the decode

// Target carries the selection's read options (the router's conn).
type Target struct {
	InvertGridSign bool
	// ModelType "float" or "int_sf" overrides the discovered layout; anything
	// else ("auto", "") keeps it.
	ModelType string
}

// InverterReading is decodeInverter's result.
type InverterReading struct {
	PvPowerKw float64
	PvSource  string // "ac" (string inverter) | "dc" (hybrid, DCW)
	Hybrid    bool
	WKw       float64
	Hz        *float64 // nil = not finite (JS null)
	St        int
	StLabel   string // "" = unknown state (JS null)
	Evt1      uint32
}

// Meta is decodeMeasurements' meta.
type Meta struct {
	Base          int
	Inverter      *InverterReading // nil: no decodable inverter model
	InverterModel int
	InverterType  string
	Meter         bool
}

// Result is decodeMeasurements' {reading, meta}.
type Result struct {
	Reading map[string]float64 // pv_power_kw and/or power_kw
	Meta    Meta
}

// DecodeInverter decodes the classified inverter model, nil when there is none,
// its body is unreadable or W is not finite.
func DecodeInverter(d Discovery, img Image, modelType string) *InverterReading {
	if !d.OK || d.Inverter == nil {
		return nil
	}
	m, ok := d.byID[d.Inverter.ID]
	if !ok {
		return nil
	}
	typ := d.Inverter.Type
	if modelType == "float" || modelType == "int_sf" {
		typ = modelType
	}
	evt1 := invFloat.Evt1
	if typ == "int_sf" {
		evt1 = invInt.Evt1
	}
	need := evt1 + 2
	if m.Len > need {
		need = m.Len
	}
	regs := img.words(m.BodyAddr, need)
	if regs == nil {
		return nil
	}
	var w, hz float64
	var st int
	var ev uint32
	if typ == "int_sf" {
		w = float64(s16(regs[invInt.W])) * pow10(s16(regs[invInt.WSF]))
		hz = float64(s16(regs[invInt.Hz])) * pow10(s16(regs[invInt.HzSF]))
		st = int(regs[invInt.St])
		ev = u32(regs[invInt.Evt1], regs[invInt.Evt1+1])
	} else {
		w = f32(regs[invFloat.W], regs[invFloat.W+1])
		hz = f32(regs[invFloat.Hz], regs[invFloat.Hz+1])
		st = int(regs[invFloat.St])
		ev = u32(regs[invFloat.Evt1], regs[invFloat.Evt1+1])
	}
	if !finite(w) {
		return nil
	}
	out := &InverterReading{WKw: round3(w / 1000), St: st, StLabel: InvState[st], Evt1: ev, Hybrid: d.Storage}
	if finite(hz) {
		h := round1(hz)
		out.Hz = &h
	}
	pv := math.Max(0, w)
	out.PvSource = "ac"
	if d.Storage {
		dc, ok := dcWatts(regs, typ)
		if !ok {
			return nil
		}
		pv, out.PvSource = dc, "dc"
	}
	out.PvPowerKw = round3(pv / 1000)
	return out
}

// dcWatts is readDcWatts: DC power, absent when not implemented.
func dcWatts(regs []uint16, typ string) (float64, bool) {
	if typ == "int_sf" {
		if len(regs) <= invInt.DCWSF {
			return 0, false
		}
		raw, sf := s16(regs[invInt.DCW]), s16(regs[invInt.DCWSF])
		if raw == int16NotImplemented || sf == int16NotImplemented {
			return 0, false
		}
		v := float64(raw) * pow10(sf)
		return v, finite(v)
	}
	if len(regs) <= invFloat.DCW+1 {
		return 0, false
	}
	v := f32(regs[invFloat.DCW], regs[invFloat.DCW+1])
	return v, finite(v)
}

// DecodeMeter decodes the first float meter model (211/212/213): the signed
// grid power, with the device's sign unless invertGridSign.
func DecodeMeter(d Discovery, img Image, invertGridSign bool) (float64, bool) {
	if !d.OK {
		return 0, false
	}
	for _, m := range d.Models {
		if _, ok := MeterFloat[m.ID]; !ok {
			continue
		}
		need := metFloat.W + 2
		if m.Len > need {
			need = m.Len
		}
		regs := img.words(m.BodyAddr, need)
		if regs == nil {
			return 0, false
		}
		w := f32(regs[metFloat.W], regs[metFloat.W+1])
		if !finite(w) {
			return 0, false
		}
		sign := 1.0
		if invertGridSign {
			sign = -1
		}
		return round3(sign * w / 1000), true
	}
	return 0, false
}

// DecodeMeasurements is decodeMeasurements: nil when nothing was decodable.
func DecodeMeasurements(d Discovery, img Image, t Target) *Result {
	if !d.OK {
		return nil
	}
	res := &Result{Reading: map[string]float64{}, Meta: Meta{Base: d.Base}}
	if inv := DecodeInverter(d, img, t.ModelType); inv != nil {
		res.Reading["pv_power_kw"] = inv.PvPowerKw
		res.Meta.Inverter = inv
		if d.Inverter != nil {
			res.Meta.InverterModel, res.Meta.InverterType = d.Inverter.ID, d.Inverter.Type
		}
	}
	if p, ok := DecodeMeter(d, img, t.InvertGridSign); ok {
		res.Reading["power_kw"] = p
		res.Meta.Meter = true
	}
	if len(res.Reading) == 0 {
		return nil
	}
	return res
}

// ------------------------------------------------------------- one session

// Lesung is the outcome of one read.
type Lesung struct {
	Found    bool    // a base carried "SunS"
	Result   *Result // nil: nothing decodable
	Requests int
	Stopped  string // the refused read that ended the walk early (WalkResult.Stopped)
	Common   Common // model 1 as read (empty when absent)
}

// Read is one read of a SunSpec device over its own session: dial, walk,
// discover, decode. err != nil is a TRANSPORT failure (dial, timeout,
// connection lost) - no value then. A device without a marker is Found=false.
func Read(ctx context.Context, dial modbustcp.Dialer, addr string, unit byte, connectTimeout, ioTimeout time.Duration, t Target) (*Lesung, error) {
	c, err := modbustcp.Dial(ctx, dial, addr, unit, connectTimeout, ioTimeout)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	w, err := Walk(c, CommonBases)
	if err != nil {
		if ctx.Err() != nil {
			return &Lesung{Requests: w.Requests}, ctx.Err()
		}
		return &Lesung{Requests: w.Requests}, err
	}
	out := &Lesung{Found: w.Found, Requests: w.Requests, Stopped: w.Stopped}
	if !w.Found {
		return out, nil
	}
	d := Discover(w.Image, CommonBases)
	out.Result = DecodeMeasurements(d, w.Image, t)
	out.Common = DecodeCommon(d, w.Image)
	return out, nil
}

// IsDialError: the error came from the dial, not from an open session.
func IsDialError(err error) bool {
	var oe *net.OpError
	return errors.As(err, &oe) && oe.Op == "dial"
}

// ------------------------------------------------------------ common model 1

// Common is the identity of Common Model 1 (Mn, Md, Vr, SN).
type Common struct {
	Hersteller, Modell, Version, Seriennummer string
}

// DecodeCommon reads model 1 from the image (empty when absent or short).
func DecodeCommon(d Discovery, img Image) Common {
	if !d.OK {
		return Common{}
	}
	m, ok := d.byID[1]
	if !ok || m.Len < 64 {
		return Common{}
	}
	b := img.words(m.BodyAddr, 64)
	if b == nil {
		return Common{}
	}
	return Common{Hersteller: text(b[0:16]), Modell: text(b[16:32]), Version: text(b[40:48]), Seriennummer: text(b[48:64])}
}

func text(words []uint16) string {
	buf := make([]byte, 0, 2*len(words))
	for _, w := range words {
		buf = append(buf, byte(w>>8), byte(w))
	}
	if i := strings.IndexByte(string(buf), 0); i >= 0 {
		buf = buf[:i]
	}
	return strings.TrimSpace(strings.ToValidUTF8(string(buf), ""))
}

// ------------------------------------------------------------------ numerics

func s16(v uint16) int { return int(int16(v)) }

func u32(hi, lo uint16) uint32 { return uint32(hi)<<16 | uint32(lo) }

// f32 is IEEE-754 single from two big-endian words (high word first).
func f32(hi, lo uint16) float64 { return float64(math.Float32frombits(u32(hi, lo))) }

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// pow10 is Math.pow(10, sf) for a sunssf (-32768..32767).
func pow10(sf int) float64 { return math.Pow(10, float64(sf)) }

// jsRound is Math.round: half rounds toward +Infinity.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func round3(x float64) float64 { return noNegZero(jsRound(x*1000) / 1000) }
func round1(x float64) float64 { return noNegZero(jsRound(x*10) / 10) }

// noNegZero: JSON.stringify(-0) is "0"; the bus never carries a "-0".
func noNegZero(x float64) float64 {
	if x == 0 {
		return 0
	}
	return x
}
