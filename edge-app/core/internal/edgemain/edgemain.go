// Package edgemain is the ONE process body of every box binary: config,
// agent, local web app, signal handling, ordered shutdown. vp-edge-core (the
// Docker box, Layer 1 in Node-RED) and vp-edge-light (Edge Light, Layer 1 in
// Go) differ ONLY in what they hand in as Extra - so the core a customer runs
// is the same code on both, and a fix to startup or shutdown cannot reach one
// and miss the other.
package edgemain

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraet"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/web"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/werkstatt"
)

// Options select the binary's personality.
type Options struct {
	// Name is the program name in the start/stop log lines.
	Name string
	// BoxArt is the box type this binary is (geraetesuche.BoxArtDocker or
	// BoxArtEdgeLight): it decides supports[], update.backend and what the
	// device search can see (edge-supports.md "Je Box-Art").
	BoxArt string
	// Extra runs after the agent started (its local bus is up) and until ctx
	// ends. It returns a stop function called BEFORE the agent stops, so an
	// in-process Layer 1 never talks to a bus that is going away. nil = none.
	Extra func(ctx context.Context, cfg config.Config, a *agent.Agent) (stop func(), err error)
	// SourceReads is the in-process source reader's answer to "do you wire
	// this transport in this role?" ("" = yes, else the reason). Handed to the
	// agent BEFORE it starts, so no portal plan is ever applied without it: a
	// source the reader cannot wire is reported to the portal instead of being
	// applied. nil = the sources are read elsewhere (the Docker box's flow).
	SourceReads func(comm, role string) string
}

// Main runs the box process and exits the program on a fatal error. As
// "<programm> werkstatt-anmelden …" it instead redeems a workshop code and
// exits (internal/werkstatt, docs/contracts/werkstatt-einloesen-v1.md) - in
// both binaries, from the same code.
func Main(o Options) {
	// `<programm> version`: die eingestempelte Fassung, sonst nichts. Der
	// Edge-Light-Loader startet eine neue Fassung damit zur Probe (5 s Frist),
	// bevor er sie wirklich startet - ein Programm fuer die falsche
	// Architektur oder ein kaputtes scheitert hier sofort (Konzept
	// vp-edge-light-update, Schicht 2). Kein Laden der Konfiguration, kein Netz.
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println(agent.Version)
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == werkstatt.BefehlName {
		os.Exit(werkstatt.Befehl(os.Args[2:], agent.Version, os.Stdin, os.Stdout, os.Stderr))
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration invalid", "err", err)
		os.Exit(1)
	}
	cfg.BoxArt = o.BoxArt

	a, err := agent.New(cfg)
	if err != nil {
		slog.Error("agent init failed", "err", err)
		os.Exit(1)
	}
	// Geraete & Updates G8: auf welchem Geraet laeuft dieses Programm? Einmal
	// beim Start - das Geraet wechselt nicht, solange das Programm laeuft.
	erkannt := geraet.Erkennen(os.DirFS("/"), runtime.GOARCH)
	a.SetGeraet(erkannt)
	a.SetSourceReads(o.SourceReads)
	slog.Info("device detected", "model", erkannt.Modell, "arch", erkannt.Arch)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := a.Start(ctx); err != nil {
		slog.Error("agent start failed", "err", err)
		os.Exit(1)
	}

	stopExtra := func() {}
	if o.Extra != nil {
		s, err := o.Extra(ctx, cfg, a)
		if err != nil {
			slog.Error(o.Name+" start failed", "err", err)
			a.Stop()
			os.Exit(1)
		}
		if s != nil {
			stopExtra = s
		}
	}

	httpSrv := &http.Server{
		Addr: cfg.HTTPAddr,
		// Der Beobachter lernt aus JEDER Anfrage die Adresse, unter der die Box
		// wirklich erreicht wurde - die eine Tatsache, die sie ueber sich
		// selbst nicht sagen konnte (D5). Er aendert an keiner Antwort etwas.
		Handler:           a.WebObserver(web.Handler(a.State, a, a, a, a.History(), a, a, a, a, a, a, a, a, a)),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		slog.Info("local web app listening", "addr", cfg.HTTPAddr, "ref", a.State.Get().Ref)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("web server stopped", "err", err)
			stop()
		}
	}()

	slog.Info(o.Name+" started",
		"version", agent.Version,
		"ref", a.State.Get().Ref,
		"local_bus", cfg.LocalMQTTAddr,
		"portal", cfg.PortalBaseURL)

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	stopExtra()
	a.Stop()
}
