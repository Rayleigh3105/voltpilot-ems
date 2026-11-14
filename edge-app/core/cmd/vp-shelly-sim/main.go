// vp-shelly-sim is a switchable Shelly Pro 3 (Gen2 RPC, three outputs) for the
// probes that let the real box program switch - the Steuerlogik "scharf"
// probe (edge-light/test/steuerlogik-scharf-probe.sh). It keeps the state of
// its outputs, answers the reads the box's executor makes (Shelly.GetStatus,
// Shelly.GetConfig, Switch.GetStatus) and logs every switching request on
// stdout; GET /probe/zustand gives outputs and requests as JSON for the probe.
// The bodies follow the Pro 3 at the VoltPilotGATE (31.10.2026) and the Gen2
// docs. Dev/test tool - never part of a customer install; simulator evidence
// is no hardware acceptance.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type shelly struct {
	mu       sync.Mutex
	on       []bool
	initial  []string
	anfragen []anfrage
}

type anfrage struct {
	T  string `json:"t"`
	ID int    `json:"id"`
	On bool   `json:"on"`
}

func (s *shelly) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := r.URL.Query()
	switch r.URL.Path {
	case "/shelly":
		fmt.Fprint(w, `{"name":null,"id":"shellypro3-probe","mac":"34987A000000","slot":1,"model":"SPSW-003XE16EU",`+
			`"gen":2,"fw_id":"20241011-114451/1.4.4-g6d2a586","ver":"1.4.4","app":"Pro3","auth_en":false,"auth_domain":null}`)
	case "/rpc/Shelly.GetStatus":
		teile := []string{`"sys":{}`}
		for i, on := range s.on {
			teile = append(teile, fmt.Sprintf(`"switch:%d":{"id":%d,"source":"init","output":%t,"temperature":{"tC":33.6,"tF":92.4}}`, i, i, on))
		}
		fmt.Fprint(w, "{"+strings.Join(teile, ",")+"}")
	case "/rpc/Shelly.GetConfig":
		var teile []string
		for i := range s.on {
			teile = append(teile, fmt.Sprintf(`"switch:%d":{"id":%d,"name":null,"in_mode":"follow","initial_state":%q,"auto_on":false,"auto_off":false}`, i, i, s.initial[i]))
		}
		fmt.Fprint(w, "{"+strings.Join(teile, ",")+"}")
	case "/rpc/Switch.GetStatus":
		id, err := strconv.Atoi(q.Get("id"))
		if err != nil || id < 0 || id >= len(s.on) {
			fmt.Fprint(w, `{"code":-105,"message":"Argument 'id' not found!"}`)
			return
		}
		fmt.Fprintf(w, `{"id":%d,"source":"init","output":%t,"temperature":{"tC":33.6,"tF":92.4}}`, id, s.on[id])
	case "/rpc/Switch.Set":
		id, err := strconv.Atoi(q.Get("id"))
		if err != nil || id < 0 || id >= len(s.on) {
			fmt.Fprint(w, `{"code":-105,"message":"Argument 'id' not found!"}`)
			return
		}
		on := q.Get("on") == "true"
		was := s.on[id]
		s.on[id] = on
		s.anfragen = append(s.anfragen, anfrage{T: time.Now().UTC().Format(time.RFC3339), ID: id, On: on})
		log.Printf("vp-shelly-sim: schaltet id=%d on=%t (toggle_after=%s)", id, on, q.Get("toggle_after"))
		fmt.Fprintf(w, `{"was_on":%t}`, was)
	case "/rpc/Switch.SetConfig":
		id, err := strconv.Atoi(q.Get("id"))
		if err == nil && id >= 0 && id < len(s.on) {
			var c struct {
				InitialState string `json:"initial_state"`
			}
			_ = json.Unmarshal([]byte(q.Get("config")), &c)
			if c.InitialState != "" {
				s.initial[id] = c.InitialState
			}
		}
		fmt.Fprint(w, `{"restart_required":false}`)
	case "/probe/zustand":
		raw, _ := json.Marshal(map[string]any{"on": s.on, "anfragen": s.anfragen})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "Listen-Adresse (HTTP)")
	ausgaenge := flag.Int("ausgaenge", 3, "Zahl der Ausgänge")
	flag.Parse()
	s := &shelly{on: make([]bool, *ausgaenge), initial: make([]string, *ausgaenge)}
	for i := range s.initial {
		s.initial[i] = "off"
	}
	log.Printf("vp-shelly-sim: Shelly Pro %d auf %s", *ausgaenge, *addr)
	log.Fatal(http.ListenAndServe(*addr, s))
}
