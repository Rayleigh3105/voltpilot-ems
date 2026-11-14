// vp-logik-dienst: the Steuerlogik service beside the API (Steuerlogik
// Stufe 2, second part; docs/contracts/v2/steuerlogik.md). It reads a logic
// with the box's own readers, runs the contract's check and builds the
// deployment artifact (internal/logikdienst). It lives in the core module
// because the readers are internal packages there - the language is read in
// exactly one place.
//
//	LOGIK_DIENST_PORT (default 8101), LOGIK_DIENST_BIND (default 0.0.0.0)
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst"
)

func main() {
	port := os.Getenv("LOGIK_DIENST_PORT")
	if port == "" {
		port = "8101"
	}
	bind := os.Getenv("LOGIK_DIENST_BIND")
	if bind == "" {
		bind = "0.0.0.0"
	}
	srv := &http.Server{
		Addr:              net.JoinHostPort(bind, port),
		Handler:           logikdienst.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		// Drain like flowc: running checks finish, new ones are refused.
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	slog.Info("vp-logik-dienst läuft", "addr", srv.Addr, "version", logikdienst.Version)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("vp-logik-dienst beendet", "err", err)
		os.Exit(1)
	}
}
