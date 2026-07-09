// vp-edge-core is the VoltPilot edge core agent: the reliability layer of
// the customer-side edge app. It owns identity/enrollment, the single mTLS
// cloud link, telemetry store-and-forward, schedule caching + guarded
// execution, the embedded local MQTT bus for Layer 1 (Node-RED), and the
// local device web app.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/web"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration invalid", "err", err)
		os.Exit(1)
	}

	a, err := agent.New(cfg)
	if err != nil {
		slog.Error("agent init failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := a.Start(ctx); err != nil {
		slog.Error("agent start failed", "err", err)
		os.Exit(1)
	}

	httpSrv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           web.Handler(a.State, a, a, a, a.History(), a, a),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		slog.Info("local web app listening", "addr", cfg.HTTPAddr, "ref", a.State.Get().Ref)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("web server stopped", "err", err)
			stop()
		}
	}()

	slog.Info("vp-edge-core started",
		"version", agent.Version,
		"ref", a.State.Get().Ref,
		"local_bus", cfg.LocalMQTTAddr,
		"portal", cfg.PortalBaseURL)

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	a.Stop()
}
