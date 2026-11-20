// vp-edge-light is Edge Light: the whole VoltPilot box as ONE binary, without
// Docker and without Node-RED - built to run from RAM on small routers
// (OpenWrt, MIPS) as well as on any Linux. See edge-light/README.md. The code
// is internal/kernmain, shared with vp-edge-industrie (Edge Industrie on the
// WAGO PFC200).
package main

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kernmain"
)

func main() {
	kernmain.Main("vp-edge-light", geraetesuche.BoxArtEdgeLight)
}
