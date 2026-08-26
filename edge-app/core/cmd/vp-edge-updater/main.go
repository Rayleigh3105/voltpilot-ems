// Command vp-edge-updater ist der Apply-Sidecar der OTA-Stufe 3 „Autonom".
//
// Er besitzt `/var/run/docker.sock` und ist der EINZIGE, der die Container der
// Edge-App tauscht. Er hat kein Netz, keinen Host-Port, keine MQTT-Verbindung
// und keine Identitaet; mit dem Kern spricht er ausschliesslich ueber Dateien
// in `/data/ota` (siehe internal/otaapply).
//
// **Vorgabe ist AUS.** Ohne `<data>/ota/autonomy.json` mit `enabled: true`
// (bzw. den Not-Ein `VP_OTA_AUTONOMOUS=true` fuer den Laborstand) wendet er
// nichts an - er beobachtet und meldet. Eine Box mit diesem Container
// verhaelt sich dann zeichengleich wie eine ohne ihn.
//
// # Wer aktualisiert den Aktualisierer
//
// Nicht er selbst - und das ist eine Zusage, keine Auslassung (Vorentwurf §3
// „who updates the updater"). Sein eigenes Image steht bewusst NICHT in der
// Artefakt-Liste, die er tauscht: ein Prozess, der sich mitten in einer
// Orchestrierung selbst ersetzt, verliert genau den Zustand, mit dem er den
// Vorgang zu Ende fahren muesste. Der Sidecar wird deshalb selten und
// beaufsichtigt ueber den bestehenden Weg aktualisiert
// (`update.sh` -> `docker compose up -d updater`). Aus der Absicht wird eine
// Sperre in [otaapply.TargetRefs], die den eigenen Anteil eines Releases
// auslaesst - siehe [otaapply.UpdaterComponent].
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaupdater"
)

// Version wird beim Bau eingestempelt (-ldflags -X main.Version=…).
var Version = "dev"

func main() {
	interval := flag.Duration("interval", envDuration("VP_OTA_TICK_SECONDS", 5*time.Second),
		"Takt, in dem der Zustand geprueft wird")
	once := flag.Bool("once", false, "nur einen Durchlauf machen (Diagnose)")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	dataDir := env("VP_DATA_DIR", "/data")
	deployDir := env("VP_DEPLOY_DIR", "/deploy")

	e := otaupdater.New(otaupdater.Options{
		DataDir:      dataDir,
		DeployDir:    deployDir,
		ComposeFiles: composeFiles(),
		Runner:       &otaupdater.ExecRunner{Timeout: envDuration("VP_OTA_CMD_TIMEOUT_SECONDS", 10*time.Minute)},
		Deadline:     envDuration("VP_OTA_WATCHDOG_SECONDS", 10*time.Minute),
		DiskGuard:    envBytes("VP_OTA_DISK_GUARD_MB", otaapply.DefaultDiskGuardBytes),
		Prune:        prunePolicy(),
		AckWait:      envDuration("VP_OTA_ACK_WAIT_SECONDS", 45*time.Second),
		HealthWait:   envDuration("VP_OTA_HEALTH_WAIT_SECONDS", 120*time.Second),
		Log:          log,
	})

	if err := setupRegistryAuth(dataDir, log); err != nil {
		// Kein Abbruch: ohne Zugangsdaten scheitert spaeter der Pull mit einer
		// klaren Meldung, und der Sidecar bleibt beobachtend nuetzlich.
		log.Warn("Registry-Zugangsdaten nicht eingerichtet", "grund", err)
	}

	log.Info("vp-edge-updater gestartet", "version", Version, "daten", dataDir,
		"deploy", deployDir, "takt", interval.String(),
		"aufraeumen", prunePolicy().Enabled,
		"aufraeumen_aufgehoben", prunePolicy().KeepReleases)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	tick := func() {
		if err := e.Tick(ctx); err != nil && ctx.Err() == nil {
			log.Error("Durchlauf fehlgeschlagen", "err", err)
		}
	}
	tick()
	if *once {
		return
	}
	t := time.NewTicker(*interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("vp-edge-updater beendet")
			return
		case <-t.C:
			tick()
		}
	}
}

// setupRegistryAuth legt die Docker-Zugangsdaten dieses GERAETS an.
//
// Die Datei `<data>/ota/registry-auth.json` traegt `{registry, username,
// token}` und wird beim TOFU-Crossover je Box abgelegt (docs/ota-autonomie.md
// §Token). Sie wird NIE in ein Image gebacken: ein Image ist fuer die ganze
// Flotte gleich, ein Zugang gehoert genau einer Box.
//
// Daraus entsteht eine gewoehnliche `config.json` fuer den docker-Client. Sie
// liegt unter `/tmp`, nicht neben den Zugangsdaten: sie ist ein Abfallprodukt,
// und `/data` soll nur tragen, was wirklich Zustand ist.
func setupRegistryAuth(dataDir string, log *slog.Logger) error {
	auth, err := otaupdater.ReadRegistryAuth(dataDir)
	if err != nil {
		return err
	}
	if auth == nil {
		log.Info("Keine geraeteeigenen Registry-Zugangsdaten hinterlegt - " +
			"es wird die Umgebung des Docker-Daemons benutzt.")
		return nil
	}
	cfgDir := env("DOCKER_CONFIG", "/tmp/vp-docker")
	if err := otaupdater.WriteDockerConfig(cfgDir, auth); err != nil {
		return err
	}
	if err := os.Setenv("DOCKER_CONFIG", cfgDir); err != nil {
		return err
	}
	log.Info("Registry-Zugangsdaten eingerichtet", "registry", auth.Registry,
		"benutzer", auth.Username)
	return nil
}

// prunePolicy ist die FLOTTEN-Vorgabe fuers Aufraeumen abgeloester Abbilder.
//
// Die Vorgabe ist AN (das Nicht-Aufraeumen war der Defekt, nicht das
// Aufraeumen); `VP_OTA_PRUNE=false` schaltet es flottenweit ab,
// `VP_OTA_PRUNE_KEEP` bestimmt, wie viele abgeloeste Releases je Komponente
// liegen bleiben. Das einzelne Geraet ueberstimmt beides mit
// `<data>/ota/prune.json` (siehe otaapply.ResolvePrunePolicy).
func prunePolicy() otaapply.PrunePolicy {
	p := otaapply.DefaultPrunePolicy()
	p.Enabled = envBool("VP_OTA_PRUNE", p.Enabled)
	p.KeepReleases = envCount("VP_OTA_PRUNE_KEEP", p.KeepReleases)
	return p
}

func composeFiles() []string {
	raw := env("VP_OTA_COMPOSE_FILES", "docker-compose.yml")
	var out []string
	for _, f := range strings.Split(raw, ":") {
		if s := strings.TrimSpace(f); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v == "1" || v == "true" || v == "yes" || v == "ja"
}

func envDuration(key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return time.Duration(n) * time.Second
}

// envCount liest eine Anzahl. Anders als [envDuration] ist 0 hier ein
// GUELTIGER Wert („nichts zusaetzlich aufheben"); nur eine unlesbare oder
// negative Angabe faellt auf die Vorgabe zurueck.
func envCount(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

func envBytes(key string, def uint64) uint64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil || n == 0 {
		return def
	}
	return n << 20
}

func init() {
	// Der Pfad wird nur benutzt, wenn jemand den Sidecar von Hand mit einem
	// abweichenden Datenverzeichnis startet; er existiert, damit ein Tippfehler
	// frueh auffaellt statt erst beim Schreiben.
	if d := os.Getenv("VP_DATA_DIR"); d != "" && !filepath.IsAbs(d) {
		fmt.Fprintln(os.Stderr, "VP_DATA_DIR muss ein absoluter Pfad sein")
		os.Exit(2)
	}
}
