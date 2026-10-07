// vp-edge-core is the VoltPilot edge core agent: the reliability layer of
// the customer-side edge app. It owns identity/enrollment, the single mTLS
// cloud link, telemetry store-and-forward, schedule caching + guarded
// execution, the embedded local MQTT bus for Layer 1 (Node-RED), and the
// local device web app.
//
// The process body is shared with vp-edge-light (internal/edgemain); this
// binary adds nothing to it - Layer 1 is Node-RED, a separate container.
package main

import "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/edgemain"

func main() {
	edgemain.Main(edgemain.Options{Name: "vp-edge-core"})
}
