package agent

// Pakete-Pflege (Edge Light, vp-direktvermarktung-konzept d2, E5/Stufe 5,
// PS-D10): Feldboxen bekommen die OpenWrt-Pakete des Direktvermarkter-
// Anschlusses (openvpn-mbedtls samt Abhaengigkeiten) als GEPRUEFTEN Anhang
// ihres signierten Release - nie aus dem Internet auf der Box.
//
// Der Weg: Das Manifest der LAUFENDEN, bestaetigten Fassung (die Zuweisung im
// RAM, von otaverify gegen die eingebackene Wurzel geprueft) nennt in
// pakete.sha256 die Pruefsumme des Anhangs edge-light-pakete.tar.gz. Fehlen
// Pakete auf der Box, laedt die Pflege den Anhang aus dem Portal
// (/api/v1/edge/light-pakete/<sha256>), prueft ihn gegen genau diese
// Pruefsumme, prueft die INHALT-Liste (otapakete.Lies) und installiert mit
// apk add --no-network aus den bestaetigten Dateien. Eine Lieferung, die
// nicht passt, wird verworfen; schlaegt die Installation fehl, nimmt die
// Pflege neu hinzugekommene Pakete wieder zurueck (Ruecknahme auf den
// vorherigen Stand) und versucht es spaeter erneut.
//
// Nur Edge Light auf OpenWrt: Edge Industrie bringt sein OpenVPN in der
// Firmware mit, und ein Geraet mit anderer apk-Architektur als der des
// Anhangs (INHALT "arch", z. B. die amd64-Probe) installiert nichts statt
// Falsches. Die Werkstatt installiert denselben Anhang ueber install.sh
// (VP_PAKETE); diese Pflege holt Feldboxen nach (PS-D10) und heilt eine Box,
// auf der die Zustellung vor den Paketen ankam ("openvpn fehlt" im
// vp-vermarkter-Log verschwindet mit dem naechsten Takt des Verwalters).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otapakete"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otatarget"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

const (
	// paketePflegeRetry: so lange wartet ein Fehlschlag (Netz, Portal,
	// Installation), bevor es erneut versucht wird.
	paketePflegeRetry = time.Hour
	// paketePflegeTimeout begrenzt Download und Installation zusammen.
	paketePflegeTimeout = 10 * time.Minute
)

// apkWerkzeug sind die vier apk-Handgriffe der Pflege - als Naht, damit Tests
// ohne OpenWrt laufen (das echte apk prueft die OpenWrt-Signatur jeder
// Paketdatei zusaetzlich selbst).
type apkWerkzeug interface {
	Arch(ctx context.Context) (string, error)
	// Installierte nennt die installierten Pakete (apk list --installed),
	// eine Zeile je Paket, beginnend mit "<name>-<fassung> ".
	Installierte(ctx context.Context) (string, error)
	Add(ctx context.Context, dateien []string) error
	Del(ctx context.Context, namen []string) error
}

type paketePflegeState struct {
	mu       sync.Mutex
	busy     bool
	erledigt string // Fassung, fuer die nichts (mehr) zu tun ist
	retryAt  time.Time

	// Testnaehte (nil = echt).
	apk    apkWerkzeug
	client *http.Client
	now    func() time.Time
}

// echtesApk ruft das apk des Geraets.
type echtesApk struct{}

func (echtesApk) lauf(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "apk", args...).CombinedOutput()
	if err != nil {
		// Nie Dateiinhalte, nur apks eigene Meldung.
		return "", fmt.Errorf("apk %s: %v: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (a echtesApk) Arch(ctx context.Context) (string, error) {
	out, err := a.lauf(ctx, "--print-arch")
	return strings.TrimSpace(out), err
}

func (a echtesApk) Installierte(ctx context.Context) (string, error) {
	return a.lauf(ctx, "list", "--installed")
}

func (a echtesApk) Add(ctx context.Context, dateien []string) error {
	_, err := a.lauf(ctx, append([]string{"add", "--no-network"}, dateien...)...)
	return err
}

func (a echtesApk) Del(ctx context.Context, namen []string) error {
	_, err := a.lauf(ctx, append([]string{"del"}, namen...)...)
	return err
}

func (a *Agent) paketePflegeNow() time.Time {
	if a.paketePflege.now != nil {
		return a.paketePflege.now()
	}
	return time.Now()
}

// paketePflegeAnstossen stoesst die Pflege fuer die laufende, bestaetigte
// Fassung an (aus otaLightSchritt, nach otaLightBestaetigt). Idempotent und
// nie blockierend; je Fassung hoechstens ein Lauf zur Zeit.
func (a *Agent) paketePflegeAnstossen(release string) {
	if a.boxArt() != geraetesuche.BoxArtEdgeLight || a.Cfg.PortalBaseURL == "" {
		return
	}
	p := &a.paketePflege
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.busy || p.erledigt == release || a.paketePflegeNow().Before(p.retryAt) {
		return
	}
	p.busy = true
	go a.paketePflegeLauf(release)
}

func (a *Agent) paketePflegeLauf(release string) {
	err := a.paketePflegeEinmal(release)
	p := &a.paketePflege
	p.mu.Lock()
	defer p.mu.Unlock()
	p.busy = false
	if err != nil {
		p.retryAt = a.paketePflegeNow().Add(paketePflegeRetry)
		slog.Warn("Pakete-Pflege: nicht installiert - neuer Versuch spaeter",
			"release", release, "err", err)
		return
	}
	p.erledigt = release
}

// paketePflegeEinmal prueft und installiert hoechstens einmal. nil heisst:
// fuer diese Fassung ist nichts (mehr) zu tun - auch "die Fassung traegt
// keinen Anhang" und "anderes Geraet" sind kein Fehler.
func (a *Agent) paketePflegeEinmal(release string) error {
	raw, err := a.otaTargetStore().Load()
	if err != nil {
		return nil // keine Zuweisung (mehr) - nichts zu tun
	}
	env, err := otatarget.ParseEnvelope(raw)
	if err != nil {
		return nil
	}
	m, err := otaverify.ParseManifest(env.Manifest)
	if err != nil || m.Release != release || m.Pakete == nil {
		return nil
	}
	apk := a.paketePflege.apk
	if apk == nil {
		if _, err := exec.LookPath("apk"); err != nil {
			return nil // kein OpenWrt mit apk (Entwicklung, Docker) - nichts zu tun
		}
		apk = echtesApk{}
	}

	ctx, cancel := context.WithTimeout(context.Background(), paketePflegeTimeout)
	defer cancel()

	// Erst der billige Blick: fehlt ueberhaupt etwas? Dafuer reicht die
	// INHALT-Liste - und die haengt am Anhang. Der Download ist klein
	// (<1 MB); er faellt also einmal je Fassung an, danach traegt erledigt.
	roh, err := a.paketePflegeLaden(ctx, m.Pakete)
	if err != nil {
		return err
	}
	inhalt, err := otapakete.Lies(roh)
	if err != nil {
		return err
	}
	arch, err := apk.Arch(ctx)
	if err != nil {
		return err
	}
	if arch != inhalt.Arch {
		slog.Info("Pakete-Pflege: der Anhang gilt nicht fuer dieses Geraet - nichts installiert",
			"anhang_arch", inhalt.Arch, "geraet_arch", arch)
		return nil
	}
	installierte, err := apk.Installierte(ctx)
	if err != nil {
		return err
	}
	var fehlend []otapakete.Eintrag
	for _, e := range inhalt.Eintraege {
		if !paketInstalliert(installierte, e) {
			fehlend = append(fehlend, e)
		}
	}
	if len(fehlend) == 0 {
		return nil
	}

	dir := filepath.Join(a.otaRAMDir(), "pakete")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	// ALLE Dateien des Anhangs hinlegen: apk loest Abhaengigkeiten unter den
	// mitgelieferten Dateien selbst auf; installiert wird in EINER
	// Transaktion, gefordert werden nur die fehlenden.
	dateien := make([]string, 0, len(fehlend))
	for _, e := range inhalt.Eintraege {
		pfad := filepath.Join(dir, e.Datei)
		if err := os.WriteFile(pfad, inhalt.Dateien[e.Datei], 0o600); err != nil {
			return err
		}
	}
	for _, e := range fehlend {
		dateien = append(dateien, filepath.Join(dir, e.Datei))
	}
	if err := apk.Add(ctx, dateien); err != nil {
		// Ruecknahme auf den vorherigen Stand: was eben noch fehlte und nun
		// (halb) da ist, kommt wieder weg. apk installiert zwar in einer
		// Transaktion; der Gurt kostet nichts.
		namen := make([]string, 0, len(fehlend))
		for _, e := range fehlend {
			namen = append(namen, e.Name())
		}
		if delErr := apk.Del(ctx, namen); delErr != nil {
			slog.Warn("Pakete-Pflege: Ruecknahme nach Fehlschlag unvollstaendig", "err", delErr)
		}
		return err
	}
	// Nachweis: jetzt muss alles da sein.
	installierte, err = apk.Installierte(ctx)
	if err != nil {
		return err
	}
	for _, e := range inhalt.Eintraege {
		if !paketInstalliert(installierte, e) {
			return fmt.Errorf("nach der Installation fehlt %s weiterhin", e.Paket())
		}
	}
	namen := make([]string, 0, len(fehlend))
	for _, e := range fehlend {
		namen = append(namen, e.Paket())
	}
	slog.Info("Pakete-Pflege: Pakete aus dem geprueften Release-Anhang installiert",
		"release", release, "pakete", strings.Join(namen, ", "))
	return nil
}

// paketInstalliert sagt, ob apk list --installed genau dieses Paket in dieser
// Fassung nennt (Zeilenanfang "<name>-<fassung> ").
func paketInstalliert(installierte string, e otapakete.Eintrag) bool {
	for _, zeile := range strings.Split(installierte, "\n") {
		if strings.HasPrefix(zeile, e.Paket()+" ") {
			return true
		}
	}
	return false
}

// paketePflegeLaden holt den Anhang aus dem Portal und haelt ihn gegen die
// Pruefsumme aus dem verifizierten Manifest - wie otaLightLadenEinmal beim
// Programm.
func (a *Agent) paketePflegeLaden(ctx context.Context, p *otaverify.Pakete) ([]byte, error) {
	if p.Size <= 0 || p.Size > otapakete.MaxAnhang {
		return nil, fmt.Errorf("pakete.size %d liegt ausserhalb von (0, %d]", p.Size, otapakete.MaxAnhang)
	}
	if avail, ok := a.otaLightMemAvail(); ok && avail < p.Size+otaLightRAMReserve {
		return nil, fmt.Errorf("zu wenig freier Arbeitsspeicher (%d kB verfuegbar)", avail/1024)
	}
	url := strings.TrimRight(a.Cfg.PortalBaseURL, "/") + "/api/v1/edge/light-pakete/" + p.SHA256
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := a.paketePflege.client
	if client == nil {
		client = &http.Client{}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Portal antwortet HTTP %d", resp.StatusCode)
	}
	roh, err := io.ReadAll(io.LimitReader(resp.Body, p.Size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(roh)) != p.Size {
		return nil, fmt.Errorf("Lieferung hat %d statt %d Bytes", len(roh), p.Size)
	}
	h := sha256.Sum256(roh)
	if hex.EncodeToString(h[:]) != p.SHA256 {
		return nil, errors.New("die Pruefsumme der Lieferung passt nicht zum signierten Manifest - verworfen")
	}
	return roh, nil
}
