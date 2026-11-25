// Package kernmain is the main of the Go core with Layer 1 - the ONE program
// behind two device lines: vp-edge-light (Edge Light, the Mango) and
// vp-edge-industrie (Edge Industrie, the WAGO PFC200). Both cmd packages only
// pick the name and the box type; everything else is this code.
//
// It is vp-edge-core (the identical agent: enrollment, mTLS cloud link,
// store-and-forward, guards, plan execution, OCPP, local web app) PLUS the Go
// Layer 1 (internal/layer1), which talks to the core over the same local bus
// Node-RED uses on the Docker box. What the Go Layer 1 already covers is
// listed in edge-light/docs/paritaet.md; everything else answers honestly
// ("noch nicht unterstuetzt") instead of silently.
//
// The generated consumer rules (the cloud's flow artifacts with the
// vp-consumer-policy node, which the Docker box runs in Node-RED) run here in
// the Go twin internal/verbraucherregel, on its own local-bus client.
package kernmain

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/edgemain"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/verbraucherregel"
)

// Main runs the program under name (also the prefix of its local-bus clients)
// as boxArt (geraetesuche.BoxArtEdgeLight or BoxArtEdgeIndustrie).
func Main(name, boxArt string) {
	edgemain.Main(edgemain.Options{Name: name, BoxArt: boxArt, Extra: startLayer1(name, boxArt),
		SourceReads: layer1.ReadsAsSource})
}

// vermarkterPfad is the direct-marketer connection directory on Edge
// Industrie (vp-direktvermarktung-konzept d2, Stufe 4): <pfad>/partner names
// the partner, <pfad>/zugang holds the tunnel access for the root helper
// vp-vermarkter. A sibling of the flash data dir (/home/voltpilot/daten ->
// /home/voltpilot/vermarkter); VP_VERMARKTER_DIR overrides it for a bench.
// Edge Light gets its own, zone-bound wiring in Stufe 2 of the concept.
func vermarkterPfad(boxArt string, dataDir string) string {
	if boxArt != geraetesuche.BoxArtEdgeIndustrie {
		return ""
	}
	if p := os.Getenv("VP_VERMARKTER_DIR"); p != "" {
		return p
	}
	return filepath.Join(filepath.Dir(dataDir), "vermarkter")
}

// startLayer1 connects the Go Layer 1 to the core's local bus. The device
// search of the core takes Layer 1's logger lane before it speaks to a
// Solarman logger.
func startLayer1(name, boxArt string) func(ctx context.Context, cfg config.Config, a *agent.Agent) (func(), error) {
	return func(ctx context.Context, cfg config.Config, a *agent.Agent) (func(), error) {
		bus, err := layer1.DialMQTT(cfg.LocalMQTTAddr, name+"-layer1")
		if err != nil {
			return nil, err
		}
		if layer1.PruefstandBuild() {
			slog.Warn("PRUEFSTAND-BUILD: die Steuerung ist ohne Edge-Light-Freigabe offen - nur am Pruefstand betreiben, nie im Feld")
		}
		l1ctx, cancel := context.WithCancel(ctx)
		rt := layer1.New(bus, layer1.Options{Logger: slog.Default().WithGroup("layer1"),
			SteuerAblage:   filepath.Join(cfg.DataDir, "steuern.json"),
			VermarkterPfad: vermarkterPfad(boxArt, cfg.DataDir)})
		a.SetGeraetesucheSpur(rt.LoggerSpur)
		regelBus, err := layer1.DialMQTT(cfg.LocalMQTTAddr, name+"-verbraucherregeln")
		if err != nil {
			cancel()
			bus.Close()
			return nil, err
		}
		regeln := verbraucherregel.New(regelBus, verbraucherregel.Options{
			Logger: slog.Default().WithGroup("verbraucherregel")})
		a.SetLokaleFlowLaufzeit(regeln)
		done := make(chan struct{})
		go func() {
			defer close(done)
			if err := rt.Run(l1ctx); err != nil {
				slog.Error("layer1 stopped", "err", err)
			}
		}()
		return func() {
			cancel()
			<-done
			regeln.Close()
			regelBus.Close()
			bus.Close()
		}, nil
	}
}
