// vp-edge-light is Edge Light: the whole VoltPilot box as ONE binary, without
// Docker and without Node-RED - built to run from RAM on small routers
// (OpenWrt, MIPS) as well as on any Linux. See edge-light/README.md.
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
package main

import (
	"context"
	"log/slog"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/edgemain"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/verbraucherregel"
)

func main() {
	edgemain.Main(edgemain.Options{Name: "vp-edge-light", BoxArt: geraetesuche.BoxArtEdgeLight, Extra: startLayer1,
		SourceReads: layer1.ReadsAsSource})
}

// startLayer1 connects the Go Layer 1 to the core's local bus. The device
// search of the core takes Layer 1's logger lane before it speaks to a
// Solarman logger.
func startLayer1(ctx context.Context, cfg config.Config, a *agent.Agent) (func(), error) {
	bus, err := layer1.DialMQTT(cfg.LocalMQTTAddr, "vp-edge-light-layer1")
	if err != nil {
		return nil, err
	}
	l1ctx, cancel := context.WithCancel(ctx)
	rt := layer1.New(bus, layer1.Options{Logger: slog.Default().WithGroup("layer1")})
	a.SetGeraetesucheSpur(rt.LoggerSpur)
	regelBus, err := layer1.DialMQTT(cfg.LocalMQTTAddr, "vp-edge-light-verbraucherregeln")
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
