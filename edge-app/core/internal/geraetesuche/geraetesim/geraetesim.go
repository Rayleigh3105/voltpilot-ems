// Package geraetesim simulates the devices the device search recognises - a
// Modbus TCP server with SunSpec, SMA, Huawei, eByte, Victron and WAGO
// pictures, and the HTTP faces of Shelly, go-e, Fronius, OpenDTU, KACO and a
// router - for the tests of internal/geraetesuche/suche and for
// cmd/vp-geraete-sim. The Solarman logger is solarmanv5/v5sim.
//
// Every simulator keeps a log of what it was asked: the tests prove from it
// that the search only READ (HTTP GET, Modbus function code 3). Simulator
// evidence is no hardware acceptance (package 5 on VoltPilotGATE).
package geraetesim

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
)

// ---------------------------------------------------------------- Modbus TCP

// Modbus is a Modbus TCP server with one register picture per unit. It
// answers function code 3 from the picture (exception 2 for an address not
// in it, exception 0x0B for a unit it does not have) and refuses every other
// function code with exception 1 - after writing it into Funktionen.
type Modbus struct {
	ln net.Listener

	mu         sync.Mutex
	units      map[byte]map[uint16]uint16
	funktionen []byte
	anfragen   int
}

// StartModbus listens on addr ("127.0.0.1:0" for a free port).
func StartModbus(addr string) (*Modbus, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	m := &Modbus{ln: ln, units: map[byte]map[uint16]uint16{}}
	go m.serve()
	return m, nil
}

func (m *Modbus) Addr() string { return m.ln.Addr().String() }

func (m *Modbus) Close() error { return m.ln.Close() }

// Funktionen lists every function code a client sent.
func (m *Modbus) Funktionen() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]byte(nil), m.funktionen...)
}

// Anfragen counts the requests answered.
func (m *Modbus) Anfragen() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.anfragen
}

// Setze puts register words at start of unit.
func (m *Modbus) Setze(unit byte, start uint16, regs ...uint16) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.units[unit] == nil {
		m.units[unit] = map[uint16]uint16{}
	}
	for i, r := range regs {
		m.units[unit][start+uint16(i)] = r
	}
}

// SetzeText puts an ASCII text of n registers (NUL padded).
func (m *Modbus) SetzeText(unit byte, start uint16, n int, text string) {
	m.Setze(unit, start, Text(text, n)...)
}

// Text packs ASCII into n register words, NUL padded.
func Text(text string, n int) []uint16 {
	b := make([]byte, 2*n)
	copy(b, text)
	regs := make([]uint16, n)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(b[2*i:])
	}
	return regs
}

// SunSpec puts "SunS" and Common Model 1 (L = 66) at basis of unit.
func (m *Modbus) SunSpec(unit byte, basis uint16, hersteller, modell, version, seriennummer string) {
	m.Setze(unit, basis, 0x5375, 0x6E53, 1, 66)
	m.SetzeText(unit, basis+4, 16, hersteller)
	m.SetzeText(unit, basis+20, 16, modell)
	m.SetzeText(unit, basis+36, 8, "")
	m.SetzeText(unit, basis+44, 8, version)
	m.SetzeText(unit, basis+52, 16, seriennummer)
	m.Setze(unit, basis+68, 1, 0xFFFF)
}

func (m *Modbus) serve() {
	for {
		c, err := m.ln.Accept()
		if err != nil {
			return
		}
		go m.handle(c)
	}
}

func (m *Modbus) handle(c net.Conn) {
	defer c.Close()
	for {
		kopf := make([]byte, 7)
		if _, err := io.ReadFull(c, kopf); err != nil {
			return
		}
		n := int(binary.BigEndian.Uint16(kopf[4:]))
		if n < 2 || n > 254 {
			return
		}
		pdu := make([]byte, n-1)
		if _, err := io.ReadFull(c, pdu); err != nil {
			return
		}
		antwort := m.antwort(kopf[6], pdu)
		out := make([]byte, 7+len(antwort))
		copy(out, kopf[:4])
		binary.BigEndian.PutUint16(out[4:], uint16(len(antwort)+1))
		out[6] = kopf[6]
		copy(out[7:], antwort)
		if _, err := c.Write(out); err != nil {
			return
		}
	}
}

func (m *Modbus) antwort(unit byte, pdu []byte) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.funktionen = append(m.funktionen, pdu[0])
	m.anfragen++
	if pdu[0] != 0x03 || len(pdu) < 5 {
		return []byte{pdu[0] | 0x80, 0x01}
	}
	bild, ok := m.units[unit]
	if !ok {
		return []byte{0x83, 0x0B}
	}
	start, anzahl := binary.BigEndian.Uint16(pdu[1:]), binary.BigEndian.Uint16(pdu[3:])
	if anzahl == 0 || anzahl > 125 {
		return []byte{0x83, 0x03}
	}
	out := []byte{0x03, byte(2 * anzahl)}
	for i := uint16(0); i < anzahl; i++ {
		v, ok := bild[start+i]
		if !ok {
			return []byte{0x83, 0x02}
		}
		out = binary.BigEndian.AppendUint16(out, v)
	}
	return out
}

// ---------------------------------------------------------------- HTTP

// Protokoll records every HTTP request a simulator saw ("GET /shelly").
type Protokoll struct {
	mu        sync.Mutex
	eintraege []string
}

func (p *Protokoll) merke(r *http.Request) {
	p.mu.Lock()
	p.eintraege = append(p.eintraege, r.Method+" "+r.URL.RequestURI())
	p.mu.Unlock()
}

// Eintraege lists the requests seen.
func (p *Protokoll) Eintraege() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.eintraege...)
}

// Geraet is one simulated HTTP device: fixed paths to fixed answers, 404 for
// the rest.
type Geraet struct {
	Protokoll *Protokoll
	Pfade     map[string]Antwort
}

// Antwort is a status and a body (JSON when it is not a string or []byte).
type Antwort struct {
	Status int
	Body   any
}

func (g Geraet) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g.Protokoll != nil {
		g.Protokoll.merke(r)
	}
	a, ok := g.Pfade[r.URL.RequestURI()]
	if !ok {
		http.NotFound(w, r)
		return
	}
	status := a.Status
	if status == 0 {
		status = http.StatusOK
	}
	var body []byte
	switch b := a.Body.(type) {
	case string:
		body = []byte(b)
		w.Header().Set("Content-Type", "text/html")
	case []byte:
		body = b
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		body = raw
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// ShellyGen2 is a Plus/Pro device: /shelly and Shelly.GetStatus with its
// switches (or em:0 for a meter).
func ShellyGen2(p *Protokoll, modell, version string, schalter int, zaehler, auth bool) Geraet {
	status := map[string]any{"sys": map[string]any{}}
	for i := 0; i < schalter; i++ {
		status[fmt.Sprintf("switch:%d", i)] = map[string]any{"id": i, "output": false}
	}
	if zaehler {
		status["em:0"] = map[string]any{"id": 0}
	}
	pfade := map[string]Antwort{
		"/shelly": {Body: map[string]any{"name": "Werkstatt-Licht von Anna", "id": "shellypro3-aabbccddeeff",
			"mac": "AABBCCDDEEFF", "model": modell, "gen": 2, "ver": version, "app": "Pro3", "auth_en": auth,
			"auth_domain": nil}},
	}
	if auth {
		pfade["/rpc/Shelly.GetStatus"] = Antwort{Status: 401, Body: map[string]any{"code": 401}}
	} else {
		pfade["/rpc/Shelly.GetStatus"] = Antwort{Body: status}
	}
	return Geraet{Protokoll: p, Pfade: pfade}
}

// ShellyGen1 is a classic device (/shelly with type and counts).
func ShellyGen1(p *Protokoll, typ string, ausgaenge, emeter int) Geraet {
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{
		"/shelly": {Body: map[string]any{"type": typ, "mac": "AABBCCDDEEFF", "auth": false,
			"fw": "20230913-114008/v1.14.0-gcb84623", "num_outputs": ausgaenge, "num_emeters": emeter}},
	}}
}

// Goe is a go-e charger with its local API v2 on.
func Goe(p *Protokoll, sse, typ, fwv string) Geraet {
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{
		"/api/status?filter=sse,typ,fwv": {Body: map[string]any{"sse": sse, "typ": typ, "fwv": fwv}},
	}}
}

// Fronius is a Datamanager with the Solar API.
func Fronius(p *Protokoll, seriennummer string) Geraet {
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{
		"/solar_api/GetAPIVersion.cgi": {Body: map[string]any{"APIVersion": 1, "BaseURL": "/solar_api/v1/",
			"CompatibilityRange": "1.8-1"}},
		"/solar_api/v1/GetInverterInfo.cgi": {Body: map[string]any{"Body": map[string]any{"Data": map[string]any{
			"1": map[string]any{"CustomName": "Dach Süd", "DT": 1, "UniqueID": seriennummer, "StatusCode": 7}}}}},
	}}
}

// OpenDTU answers its system status.
func OpenDTU(p *Protokoll) Geraet {
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{
		"/api/system/status": {Body: map[string]any{"hostname": "OpenDTU-Garage", "git_hash": "v24.6.10",
			"pioenv": "generic_esp32", "sdkversion": "v4.4.7"}},
	}}
}

// Kaco is the KACO/AISWEI stick on 8484.
func Kaco(p *Protokoll, isn string) Geraet {
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{
		"/getdev.cgi?device=2": {Body: map[string]any{"inv": []any{map[string]any{"isn": isn}}, "num": 1}},
	}}
}

// Router answers its start page with a title.
func Router(p *Protokoll, titel string) Geraet {
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{
		"/": {Body: "<html><head><title>" + titel + "</title></head><body>Anmeldung</body></html>"},
	}}
}

// FritzBeschreibung is the SSDP device description of an AVM device.
func FritzBeschreibung(p *Protokoll, pfad, modell string) Geraet {
	xml := `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>` +
		`<deviceType>urn:dslforum-org:device:InternetGatewayDevice:1</deviceType>` +
		`<friendlyName>Annas Repeater</friendlyName><manufacturer>AVM Berlin</manufacturer>` +
		`<modelName>` + modell + `</modelName></device></root>`
	return Geraet{Protokoll: p, Pfade: map[string]Antwort{pfad: {Body: []byte(xml)}}}
}

// ErrNichtDa is what a dial to an address without a device returns.
var ErrNichtDa = errors.New("geraetesim: no device")
