// vp-luox-sim is a staged luox: a test tool that polls a
// vp-direktvermarkter-server exactly the way luox's own documents describe
// (vp-direktvermarktung-konzept d2 §2.3/§2.4) - it reads the five values on
// an interval and writes the partner set-point and the watchdog, using only
// the catalog's own register map (catalog/direktvermarkter). Dev/test tool
// for PS-D23 ("ein gestellter luox liest und schreibt im Container"); never
// a real connection to luox.
package main

import (
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

const (
	setpointMeaning = "vermarkter_vorgabe_pct"
	watchdogMeaning = "lebenszeichen"
)

type antwort struct {
	Angenommen bool `json:"angenommen"`
	Ausnahme   *int `json:"ausnahme,omitempty"`
}

type status struct {
	Gelesen              map[string]float64 `json:"gelesen"`
	GelesenUm            string             `json:"gelesen_um"`
	LesefehlerAusnahme   *int               `json:"lesefehler_ausnahme,omitempty"`
	VorgabeSoll          int                `json:"vorgabe_soll"`
	VorgabeAntwort       antwort            `json:"vorgabe_antwort"`
	LebenszeichenAktiv   bool               `json:"lebenszeichen_aktiv"`
	LebenszeichenZaehler uint32             `json:"lebenszeichen_zaehler"`
	LebenszeichenAntwort antwort            `json:"lebenszeichen_antwort"`
}

type luoxSim struct {
	profile    direktvermarkter.Profile
	serverAddr string

	mu   sync.Mutex
	conn net.Conn
	tid  uint16
	st   status
}

func newLuoxSim(profile direktvermarkter.Profile, serverAddr string) *luoxSim {
	return &luoxSim{profile: profile, serverAddr: serverAddr, st: status{VorgabeSoll: 100, LebenszeichenAktiv: true}}
}

func (l *luoxSim) ensureConn() (net.Conn, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn != nil {
		return l.conn, nil
	}
	conn, err := net.DialTimeout("tcp", l.serverAddr, 2*time.Second)
	if err != nil {
		return nil, err
	}
	l.conn = conn
	return conn, nil
}

func (l *luoxSim) dropConn() {
	l.mu.Lock()
	if l.conn != nil {
		_ = l.conn.Close()
		l.conn = nil
	}
	l.mu.Unlock()
}

func (l *luoxSim) nextTID() uint16 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.tid++
	return l.tid
}

func (l *luoxSim) exchange(req []byte) ([]byte, error) {
	conn, err := l.ensureConn()
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write(req); err != nil {
		l.dropConn()
		return nil, err
	}
	head := make([]byte, 7)
	if _, err := ioReadFull(conn, head); err != nil {
		l.dropConn()
		return nil, err
	}
	length := int(binary.BigEndian.Uint16(head[4:6]))
	body := make([]byte, length-1)
	if _, err := ioReadFull(conn, body); err != nil {
		l.dropConn()
		return nil, err
	}
	return append(head, body...), nil
}

func ioReadFull(conn net.Conn, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := conn.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

func fc4Request(tid, addr, count uint16) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint16(b[0:2], tid)
	binary.BigEndian.PutUint16(b[4:6], 6)
	b[6] = 1
	b[7] = 4
	binary.BigEndian.PutUint16(b[8:10], addr)
	binary.BigEndian.PutUint16(b[10:12], count)
	return b
}

func fc16Request(tid, addr uint16, values []uint16) []byte {
	b := make([]byte, 13+2*len(values))
	binary.BigEndian.PutUint16(b[0:2], tid)
	binary.BigEndian.PutUint16(b[4:6], uint16(7+2*len(values)))
	b[6] = 1
	b[7] = 16
	binary.BigEndian.PutUint16(b[8:10], addr)
	binary.BigEndian.PutUint16(b[10:12], uint16(len(values)))
	b[12] = byte(2 * len(values))
	for i, v := range values {
		binary.BigEndian.PutUint16(b[13+2*i:], v)
	}
	return b
}

// isException reports whether an MBAP response frame is a Modbus exception,
// and its code.
func isException(resp []byte) (bool, int) {
	if len(resp) < 9 {
		return false, 0
	}
	if resp[7]&0x80 == 0 {
		return false, 0
	}
	return true, int(resp[8])
}

// readValues performs one FC4 read of every "input" address the profile
// defines and decodes each bedeutung with the catalog's own word order.
func (l *luoxSim) readValues() (map[string]float64, error) {
	maxEnd := uint16(0)
	for _, r := range l.profile.Register {
		if r.Table == "input" && uint16(r.End()) > maxEnd {
			maxEnd = uint16(r.End())
		}
	}
	resp, err := l.exchange(fc4Request(l.nextTID(), 0, maxEnd))
	if err != nil {
		return nil, err
	}
	if ok, code := isException(resp); ok {
		return nil, fmt.Errorf("Modbus-Ausnahme 0x%02x", code)
	}
	byteCount := int(resp[8])
	raw := resp[9 : 9+byteCount]
	regs := make([]uint16, byteCount/2)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(raw[2*i:])
	}
	out := map[string]float64{}
	for _, r := range l.profile.Register {
		if r.Table != "input" {
			continue
		}
		words := regs[r.Address : r.Address+uint16(r.Words())]
		if v, ok := direktvermarkter.Decode(words, r.Type, l.profile.Modbus.WordOrder); ok {
			out[r.Meaning] = v
		}
	}
	return out, nil
}

func (l *luoxSim) writeRegister(meaning string, value float64) antwort {
	r, ok := l.profile.ByMeaning(meaning)
	if !ok {
		return antwort{Angenommen: false}
	}
	words, ok := direktvermarkter.Encode(value, r.Type, l.profile.Modbus.WordOrder)
	if !ok {
		return antwort{Angenommen: false}
	}
	resp, err := l.exchange(fc16Request(l.nextTID(), r.Address, words))
	if err != nil {
		return antwort{Angenommen: false}
	}
	if ok, code := isException(resp); ok {
		c := code
		return antwort{Angenommen: false, Ausnahme: &c}
	}
	return antwort{Angenommen: true}
}

func (l *luoxSim) tick() {
	values, err := l.readValues()
	l.mu.Lock()
	if err != nil {
		code := -1
		l.st.LesefehlerAusnahme = &code
	} else {
		l.st.Gelesen = values
		l.st.GelesenUm = time.Now().Format(time.RFC3339)
		l.st.LesefehlerAusnahme = nil
	}
	setpoint := l.st.VorgabeSoll
	watchdogActive := l.st.LebenszeichenAktiv
	l.mu.Unlock()

	// The watchdog is written FIRST: the interface treats it as a gate on
	// the set-point, not just a timer, so a set-point write before the
	// watchdog has ever been renewed would be refused.
	if watchdogActive {
		l.mu.Lock()
		l.st.LebenszeichenZaehler++
		counter := l.st.LebenszeichenZaehler
		l.mu.Unlock()
		lebenszeichenAntwort := l.writeRegister(watchdogMeaning, float64(counter))
		l.mu.Lock()
		l.st.LebenszeichenAntwort = lebenszeichenAntwort
		l.mu.Unlock()
	}

	vorgabeAntwort := l.writeRegister(setpointMeaning, float64(setpoint))
	l.mu.Lock()
	l.st.VorgabeAntwort = vorgabeAntwort
	l.mu.Unlock()
}

func (l *luoxSim) status() status {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.st
}

func (l *luoxSim) setVorgabe(pct int) {
	l.mu.Lock()
	l.st.VorgabeSoll = pct
	l.mu.Unlock()
}

func (l *luoxSim) setLebenszeichenAktiv(aktiv bool) {
	l.mu.Lock()
	l.st.LebenszeichenAktiv = aktiv
	l.mu.Unlock()
}

func main() {
	partner := flag.String("partner", "luox", "Partner-ID aus dem Direktvermarkter-Katalog")
	server := flag.String("server", "127.0.0.1:1502", "Adresse der direktvermarkter-Schnittstelle")
	interval := flag.Duration("interval", 5*time.Second, "Abfrageintervall (Lesen + Vorgabe + Lebenszeichen)")
	httpAddr := flag.String("http", ":8081", "Listen-Adresse der Steuer-API (nur für diesen Testaufbau)")
	flag.Parse()

	profile, ok := direktvermarkter.For(*partner)
	if !ok {
		log.Fatalf("vp-luox-sim: unbekannter Partner %q", *partner)
	}
	sim := newLuoxSim(profile, *server)

	go func() {
		ticker := time.NewTicker(*interval)
		defer ticker.Stop()
		for range ticker.C {
			sim.tick()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(sim.status())
	})
	mux.HandleFunc("/vorgabe", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST erwartet", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Pct int `json:"pct"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sim.setVorgabe(req.Pct)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/lebenszeichen", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST erwartet", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Aktiv bool `json:"aktiv"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sim.setLebenszeichenAktiv(req.Aktiv)
		w.WriteHeader(http.StatusNoContent)
	})

	log.Printf("vp-luox-sim: Partner %s, Ziel %s, Intervall %s, Steuer-API auf %s", profile.ID, *server, *interval, *httpAddr)
	log.Fatal(http.ListenAndServe(*httpAddr, mux))
}
