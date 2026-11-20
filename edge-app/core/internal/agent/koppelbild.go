package agent

import (
	"encoding/json"
)

// TopicKoppelStatus is Layer 1's retained Koppelbild status (layer1/koppel.go).
const TopicKoppelStatus = "edge/koppelbild/status"

// onKoppelStatus keeps the controllers' Koppelbild status for the heartbeat
// block koppel (koppelbild.md §15). It is display: the cloud never feeds it
// back into the desired state, and the core judges nothing in it. An empty
// list (no controller with an Erzeuger plan) drops the block.
func (a *Agent) onKoppelStatus(_ string, payload []byte) {
	var liste []json.RawMessage
	if len(payload) > 0 && json.Unmarshal(payload, &liste) != nil {
		return
	}
	a.koppelMu.Lock()
	defer a.koppelMu.Unlock()
	if len(liste) == 0 {
		a.koppelStand = nil
		return
	}
	a.koppelStand = append(json.RawMessage(nil), payload...)
}

// koppelSummary is the heartbeat block koppel, nil without one.
func (a *Agent) koppelSummary() json.RawMessage {
	a.koppelMu.Lock()
	defer a.koppelMu.Unlock()
	return a.koppelStand
}
