// vp-edge-industrie is Edge Industrie: the same program as Edge Light
// (internal/kernmain) on the WAGO PFC200 next to the PLC runtime, as its own
// device line - box type edge_industrie, update backend industrie, releases
// edge-industrie-JJJJ.MM.N. See edge-industrie/README.md.
package main

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/kernmain"
)

func main() {
	kernmain.Main("vp-edge-industrie", geraetesuche.BoxArtEdgeIndustrie)
}
