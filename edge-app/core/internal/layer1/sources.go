package layer1

import (
	"encoding/json"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// TopicSourcesConfig is the retained list of additional measurement points
// (edge/sources/config) the Node-RED "Energiequellen (automatisch)" tab reads.
const TopicSourcesConfig = sources.TopicConfig

// onSourcesConfig: reading additional sources is NOT ported yet (parity
// matrix, step "Quellen"). Saying so in the log is the honest minimum - the
// core already shows every configured but silent source as "keine aktuellen
// Daten", so nothing on any surface claims a value that is not read.
func (r *Runtime) onSourcesConfig(_ string, payload []byte) {
	if len(payload) == 0 {
		return
	}
	var list []json.RawMessage
	if err := json.Unmarshal(payload, &list); err != nil {
		var wrapped struct {
			Sources []json.RawMessage `json:"sources"`
		}
		if json.Unmarshal(payload, &wrapped) != nil {
			return
		}
		list = wrapped.Sources
	}
	if len(list) > 0 {
		r.log.Warn("weitere Energiequellen konfiguriert - Edge Light liest sie noch nicht", "anzahl", len(list))
	}
}
