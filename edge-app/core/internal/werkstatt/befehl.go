package werkstatt

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/agent"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

// BefehlName ist das erste Argument, unter dem beide Programme (vp-edge-core
// und vp-edge-light) den Befehl ausführen statt die Box zu starten.
const BefehlName = "werkstatt-anmelden"

// Rückgabewerte des Befehls.
const (
	OK           = 0
	Aufruf       = 2 // falscher Aufruf oder auf der Box fehlt etwas
	Abgewiesen   = 3 // das Portal hat abgelehnt (4xx); der Grund steht auf stderr
	Unerreichbar = 4 // Netz, Zeitüberschreitung oder 5xx
)

// Befehl führt werkstatt-anmelden aus. Der Code kommt als erste Zeile über
// die Standardeingabe (nie als Argument, damit er in keiner Prozessliste
// steht). Kennung und Geräteschlüssel liest er aus dem Datenverzeichnis und
// erzeugt nie einen neuen: Eingelöst wird nur, was der erste Start angelegt
// hat. Tunnel- und Host-Schlüssel nennt der Aufrufer (der Werkstatt-Dienst
// liest sie von außen). Auf stdout steht bei Erfolg die Antwort des Portals
// als JSON, sonst nichts; Fehler auf stderr.
func Befehl(args []string, fassung string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet(BefehlName, flag.ContinueOnError)
	fs.SetOutput(stderr)
	daten := fs.String("daten", "", "Datenverzeichnis der Box (Vorgabe: VP_DATA_DIR bzw. die Konfiguration)")
	portal := fs.String("portal", "", "Portal-Adresse (Vorgabe: VP_PORTAL_BASE_URL bzw. die Konfiguration)")
	wg := fs.String("wireguard", "", "öffentlicher WireGuard-Schlüssel der Box (Pflicht)")
	host := fs.String("host-schluessel", "", "Fingerabdruck des SSH-Host-Schlüssels, SHA256:… (Pflicht)")
	warte := fs.Duration("zeit", 30*time.Second, "höchstens so lange auf das Portal warten")
	if err := fs.Parse(args); err != nil {
		return Aufruf
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "%s: unerwartete Argumente %q (der Code kommt über die Standardeingabe)\n", BefehlName, fs.Args())
		return Aufruf
	}
	if *daten != "" {
		_ = os.Setenv("VP_DATA_DIR", *daten)
	}
	if *portal != "" {
		_ = os.Setenv("VP_PORTAL_BASE_URL", *portal)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(stderr, "%s: Konfiguration: %v\n", BefehlName, err)
		return Aufruf
	}
	ref, err := kennung(cfg)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", BefehlName, err)
		return Aufruf
	}
	key, err := enroll.Geraeteschluessel(filepath.Join(cfg.DataDir, "identity"))
	if err != nil {
		fmt.Fprintf(stderr, "%s: kein Geräteschlüssel in %s (erster Start fehlt?): %v\n", BefehlName,
			filepath.Join(cfg.DataDir, "identity"), err)
		return Aufruf
	}
	code, err := liesCode(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", BefehlName, err)
		return Aufruf
	}
	csr, err := enroll.Zertifikatsanfrage(key, ref)
	if err != nil {
		fmt.Fprintf(stderr, "%s: Zertifikatsanfrage: %v\n", BefehlName, err)
		return Aufruf
	}
	a := Anfrage{EdgeRef: ref, Code: code, Fassung: fassung, WireguardSchluessel: strings.TrimSpace(*wg),
		HostSchluessel: strings.TrimSpace(*host), CsrPem: csr}
	if err := Signiere(key, &a); err != nil {
		fmt.Fprintf(stderr, "%s: signieren: %v\n", BefehlName, err)
		return Aufruf
	}
	if f := Formfehler(a); len(f) > 0 {
		fmt.Fprintf(stderr, "%s: %s\n", BefehlName, strings.Join(f, "; "))
		return Aufruf
	}
	ctx, cancel := context.WithTimeout(context.Background(), *warte)
	defer cancel()
	antwort, err := Einloesen(ctx, &http.Client{Timeout: *warte}, cfg.PortalBaseURL, a)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", BefehlName, err)
		var ab Abgelehnt
		if errors.As(err, &ab) && ab.Status >= 400 && ab.Status < 500 {
			return Abgewiesen
		}
		return Unerreichbar
	}
	out, _ := json.Marshal(antwort)
	fmt.Fprintln(stdout, string(out))
	return OK
}

// kennung liest die Kennung der Box, ohne eine neue zu erzeugen (anders als
// agent.LoadRef beim Start): ohne ersten Start gibt es nichts einzulösen.
func kennung(cfg config.Config) (string, error) {
	ref := strings.TrimSpace(cfg.Ref)
	if ref == "" {
		raw, err := os.ReadFile(filepath.Join(cfg.DataDir, "ref"))
		if err != nil {
			return "", fmt.Errorf("keine Kennung in %s (erster Start fehlt?)", filepath.Join(cfg.DataDir, "ref"))
		}
		ref = strings.TrimSpace(string(raw))
	}
	if !agent.GueltigeKennung(ref) {
		return "", fmt.Errorf("die Kennung %q ist keine erzeugte Kennung mit gültigem Prüfzeichen; nur sie bekommen einen Werkstatt-Code", ref)
	}
	return ref, nil
}

func liesCode(r io.Reader) (string, error) {
	line, err := bufio.NewReader(io.LimitReader(r, 256)).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("Code von der Standardeingabe: %v", err)
	}
	code := strings.TrimSpace(line)
	if !codeMuster.MatchString(code) {
		return "", errors.New("auf der Standardeingabe steht kein Code der Form wk-… (26 Zeichen)")
	}
	return code, nil
}
