package layer1

import (
	"encoding/json"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goeapi"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// TopicSourcesConfig is the retained list of additional measurement points
// (edge/sources/config) the Node-RED "Energiequellen (automatisch)" tab reads.
const TopicSourcesConfig = sources.TopicConfig

// sourcePlan is one source Edge Light reads - the Go twin of a plan the
// flow's "sources-store" node builds (build-flows.js). Only go-e today; every
// other transport is named in the log, never silently skipped.
type sourcePlan struct {
	ID   string
	Role string
	IP   string
	Port int
	URL  string
	Addr string // the lane key: one request at a time per device
}

// sourceNote is one line of the store node's log: warn = NICHT VERDRAHTET.
type sourceNote struct {
	warn bool
	text string
}

// The transports the flow can read as a source. Edge Light names the ones it
// does not read yet instead of calling them unknown.
var knownSourceComms = map[string]bool{
	"modbus_tcp": true, "fronius_sunspec": true, "sunspec_tcp": true, "kaco_http": true,
	"kaco_modbus": true, "goe_http_api": true, "solarman_v5": true, "fronius_solar_api": true,
}

// parseSourcesConfig is vp-sources-config (structural validation) followed by
// the sources-store planning. ok=false: the payload as a whole is unusable
// (bad JSON, wrong schema_version, no sources array) - the caller keeps the
// previous plans, like the node does. An empty payload is a cleared config.
func parseSourcesConfig(payload []byte) (plans []sourcePlan, notes []sourceNote, entries int, ok bool) {
	if len(payload) == 0 {
		return nil, nil, 0, true
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(payload, &obj); err != nil || obj == nil {
		return nil, nil, 0, false
	}
	var schema string
	if json.Unmarshal(obj["schema_version"], &schema) != nil || schema != sources.SchemaVersion {
		return nil, nil, 0, false
	}
	var list []json.RawMessage
	if json.Unmarshal(obj["sources"], &list) != nil || list == nil {
		return nil, nil, 0, false
	}
	for i, raw := range list {
		var s map[string]any
		label := "Eintrag #" + strconv.Itoa(i+1)
		if json.Unmarshal(raw, &s) != nil || s == nil {
			notes = append(notes, sourceNote{true, "Quelle verworfen - " + label + ": kein Objekt"})
			continue
		}
		id, _ := s["id"].(string)
		if strings.TrimSpace(id) != "" {
			label = strings.TrimSpace(id)
		}
		comm, _ := s["communication"].(string)
		family, _ := s["family"].(string)
		conn, _ := s["connection"].(map[string]any)
		ip, _ := conn["ip"].(string)
		switch {
		case strings.TrimSpace(id) == "":
			notes = append(notes, sourceNote{true, "Quelle verworfen - " + label + ": keine id"})
			continue
		case strings.TrimSpace(comm) == "":
			notes = append(notes, sourceNote{true, "Quelle verworfen - " + label + ": keine communication"})
			continue
		case strings.TrimSpace(family) == "":
			notes = append(notes, sourceNote{true, "Quelle verworfen - " + label + ": keine family"})
			continue
		case conn == nil || strings.TrimSpace(ip) == "":
			notes = append(notes, sourceNote{true, "Quelle verworfen - " + label + ": keine connection.ip"})
			continue
		}
		entries++
		// --- the store node (role, then the transport) ---
		role, _ := s["role"].(string)
		if role != sources.RoleErzeuger && role != sources.RoleNetz && role != sources.RoleConsumer {
			notes = append(notes, sourceNote{true, "Quelle " + id + " NICHT VERDRAHTET: unbekannte Rolle \"" + role + "\""})
			continue
		}
		ip = strings.TrimSpace(ip)
		switch {
		case comm == goeapi.Family:
			port := int(num(conn["port"], 80))
			plans = append(plans, sourcePlan{
				ID: id, Role: role, IP: ip, Port: port,
				// The store node always writes the port into the URL.
				URL:  "http://" + ip + ":" + strconv.Itoa(port) + goeapi.StatusPath + "?filter=" + goeapi.StatusFilter,
				Addr: ip + ":" + strconv.Itoa(port),
			})
			notes = append(notes, sourceNote{false, "Quelle " + id + " (" + role + "): goe_http_api " + ip + ":" + strconv.Itoa(port) + " -> Leseplan (go-e /api/status)"})
		case knownSourceComms[comm]:
			notes = append(notes, sourceNote{true, "Quelle " + id + " (" + role + "): Edge Light liest die Anbindung \"" + comm + "\" als Energiequelle noch nicht"})
		default:
			notes = append(notes, sourceNote{true, "Quelle " + id + " NICHT VERDRAHTET: unbekannte Kommunikation \"" + comm + "\""})
		}
	}
	return plans, notes, entries, true
}

// onSourcesConfig takes the retained source list. The log names what is read
// and what is not (once per change), so a configured but silent source is
// visible in one device log - the core shows it as "keine aktuellen Daten".
func (r *Runtime) onSourcesConfig(_ string, payload []byte) {
	plans, notes, entries, ok := parseSourcesConfig(payload)
	if !ok {
		r.log.Warn("edge/sources/config: unbrauchbare Quellen-Konfiguration verworfen (JSON/Schema-Version/sources fehlt)")
		return
	}
	sig := strconv.Itoa(entries)
	for _, n := range notes {
		sig += "\n" + n.text
	}
	r.srcMu.Lock()
	r.srcPlans = plans
	r.srcRR = 0
	changed := sig != r.srcSig
	r.srcSig = sig
	r.srcMu.Unlock()
	if !changed {
		return
	}
	r.log.Info("Quellen-Konfiguration: " + strconv.Itoa(entries) + " Eintrag/Eintraege -> " + strconv.Itoa(len(plans)) + " Leseplan/-plaene")
	for _, n := range notes {
		if n.warn {
			r.log.Warn(n.text)
		} else {
			r.log.Info(n.text)
		}
	}
}
