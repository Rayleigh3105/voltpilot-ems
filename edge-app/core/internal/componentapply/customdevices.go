package componentapply

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// The :8484 view of the devices the CUSTOMER defined themselves in the portal
// (Einheitsmodell Stufe 3/4). They are the one component class this applier
// deliberately does NOT turn into a source (see ParseDriver): their read plan
// travels as a generated flow over v2/flows, so they never appear in
// sources.json - and until this file they appeared NOWHERE on the box at all
// (scout vp-portal-box-spiegel-s2, L5: "der Kunde sieht sein eigenes Gerät nur
// im Portal").
//
// ⚠ This is a DISPLAY derivation and nothing else. It changes no plan, no file
// and no topic; Derive still skips these entities, the energy balance still
// ignores them (topology.IsSelfBuiltType), and the group the page renders from
// it is read-only - a self-built device is created, changed and deleted in the
// portal, exactly like every other component of a portal-managed plant.
//
// It lives HERE, not in package entities, for two reasons: this is the package
// that OWNS the "self-built" discriminator (CommunicationSelfBuild) and the
// decision to skip it, so the honest counterpart "…and here is what it is, for
// display" belongs next to it; and package entities cannot import this one
// (the dependency runs the other way).

// CustomDevice is one self-built device as the setup page shows it: the portal
// name, how and where the box would reach it, what it measures, and how fresh
// its readings are.
//
// Every field is best-effort out of the push and EMPTY when the push does not
// say - never invented. An address the descriptor does not carry is simply not
// shown; the page then says how the device is read, not where.
type CustomDevice struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	// Communication is the driver's communication word, carried verbatim
	// (today always CommunicationSelfBuild - the page translates it).
	Communication string `json:"communication,omitempty"`
	// Host/Port/UnitID are the Modbus transport of the definition. Host is ""
	// when the push carries none.
	Host   string `json:"host,omitempty"`
	Port   int    `json:"port,omitempty"`
	UnitID int    `json:"unit_id,omitempty"`
	// Channels are the CUSTOMER's own measure channels (their declared label
	// where the definition carries one, else the raw channel name). The
	// vocabulary is open by construction, so nothing here is translated.
	Channels []CustomChannel `json:"channels,omitempty"`
	// Switchable reports that the customer released this device for switching
	// (Einheitsmodell Stufe 4): it declares an actuate capability. The page
	// says so; it offers no switch - that lives in the portal.
	Switchable bool `json:"switchable,omitempty"`
	// Health is the freshness of the device's OWN per-entity telemetry, the
	// same "ok"|"stale"|"never" vocabulary the topology read-model uses. It is
	// what the generated flow actually delivered - so an empty/"never" value
	// means "read by a rule, nothing arrived here yet", never "broken".
	Health string `json:"health,omitempty"`
}

// CustomChannel is one measure channel of a self-built device.
type CustomChannel struct {
	Channel string `json:"channel"`
	Label   string `json:"label,omitempty"`
	Unit    string `json:"unit,omitempty"`
}

// selfBuildDefinition is the READ view of a self-built descriptor's
// driver.connection. The cloud stores the whole definition there
// (SelfBuildComponentService.definitionJsonRaw): a nested transport plus the
// channel list.
//
// ⚠ The nested `transport` is the real shape; the flat host/port/unit_id are
// read as a fallback because that is the shape a hand-written push (and any
// future flattening) carries. Reading both costs three lines and removes a
// whole class of "the address is silently missing" bug.
type selfBuildDefinition struct {
	Transport struct {
		Host   string          `json:"host"`
		Port   json.RawMessage `json:"port"`
		UnitID json.RawMessage `json:"unit_id"`
	} `json:"transport"`
	Host     string          `json:"host"`
	Port     json.RawMessage `json:"port"`
	UnitID   json.RawMessage `json:"unit_id"`
	Channels []struct {
		Slug  string `json:"slug"`
		Label string `json:"label"`
		Unit  string `json:"unit"`
	} `json:"channels"`
}

// IsSelfBuilt reports whether this descriptor is a device the customer defined
// themselves. The discriminator is the driver's COMMUNICATION, not the entity
// type: the type vocabulary is the cloud's and grows, the communication word is
// the one this box shares verbatim with the cloud (CommunicationSelfBuild) and
// the one ParseDriver already keys its skip on. Keeping both on the same word
// makes "skipped by the applier" and "listed as a self-built device" provably
// the same set.
func IsSelfBuilt(e entities.Entity) bool {
	if len(e.Driver) == 0 {
		return false
	}
	var d Driver
	if err := json.Unmarshal(e.Driver, &d); err != nil {
		return false
	}
	return d.Communication == CommunicationSelfBuild
}

// CustomDevices lists the self-built devices of a registry for the setup page,
// in a stable order (by label, then id - the page must not reshuffle on every
// poll). health maps entity id -> "ok"|"stale"|"never"; an id the map does not
// carry gets no claim at all.
//
// Pure: no clock, no I/O. A registry without a self-built device returns nil,
// so a plant that has none renders byte-for-byte as before.
func CustomDevices(reg entities.Registry, health map[string]string) []CustomDevice {
	var out []CustomDevice
	for _, e := range reg.Entities {
		if !IsSelfBuilt(e) {
			continue
		}
		out = append(out, customDevice(e, health[e.ID]))
	}
	sort.SliceStable(out, func(i, j int) bool {
		li, lj := strings.ToLower(out[i].Label), strings.ToLower(out[j].Label)
		if li != lj {
			return li < lj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func customDevice(e entities.Entity, health string) CustomDevice {
	cd := CustomDevice{
		ID:         e.ID,
		Label:      strings.TrimSpace(e.Label),
		Switchable: len(e.Capabilities.Actuate) > 0,
		Health:     health,
	}
	var d Driver
	if err := json.Unmarshal(e.Driver, &d); err == nil {
		cd.Communication = d.Communication
	}
	var def selfBuildDefinition
	if len(d.Connection) > 0 {
		_ = json.Unmarshal(d.Connection, &def)
	}
	cd.Host = strings.TrimSpace(firstNonEmpty(def.Transport.Host, def.Host))
	cd.Port = firstNumber(def.Transport.Port, def.Port)
	cd.UnitID = firstNumber(def.Transport.UnitID, def.UnitID)

	// The channel LIST is the entity's declared capabilities - that is what the
	// box really receives readings for. The definition only enriches them with
	// the customer's own label/unit where it has one; a definition channel the
	// capabilities do not declare is NOT shown (the capabilities are the
	// contract, the definition is context).
	labels := map[string]struct{ label, unit string }{}
	for _, c := range def.Channels {
		labels[c.Slug] = struct{ label, unit string }{strings.TrimSpace(c.Label), strings.TrimSpace(c.Unit)}
	}
	for _, m := range e.Capabilities.Measure {
		ch := CustomChannel{Channel: m.Channel, Unit: strings.TrimSpace(m.Unit)}
		if extra, ok := labels[m.Channel]; ok {
			ch.Label = extra.label
			if ch.Unit == "" {
				ch.Unit = extra.unit
			}
		}
		cd.Channels = append(cd.Channels, ch)
	}
	return cd
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// firstNumber reads the first raw JSON value that is a usable positive number.
// The transport fields are numbers in every shape we write, but a hand-made
// push may quote them - and a quoted port is still a port.
func firstNumber(vals ...json.RawMessage) int {
	for _, raw := range vals {
		if len(raw) == 0 {
			continue
		}
		var n int
		if err := json.Unmarshal(raw, &n); err == nil && n > 0 {
			return n
		}
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}
