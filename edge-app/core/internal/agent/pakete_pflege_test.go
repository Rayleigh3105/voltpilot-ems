package agent

// Pakete-Pflege (Direktvermarktung Stufe 5, PS-D10): die laufende, bestaetigte
// Fassung traegt pakete im verifizierten Manifest; fehlende Pakete kommen aus
// dem Portal-Anhang, gegen die signierte Pruefsumme geprueft, installiert nur
// aus den bestaetigten Dateien; ein Fehlschlag nimmt Neues zurueck.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otapakete"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// apkAttrappe spielt das apk des Geraets nach.
type apkAttrappe struct {
	arch        string
	installiert []string // "<name>-<fassung>"-Zeilenanfaenge
	addFehler   error
	adds        [][]string
	dels        [][]string
}

func (a *apkAttrappe) Arch(context.Context) (string, error) { return a.arch, nil }

func (a *apkAttrappe) Installierte(context.Context) (string, error) {
	var b strings.Builder
	for _, p := range a.installiert {
		b.WriteString(p + " " + a.arch + " {feed} (GPL-2.0) [installed]\n")
	}
	return b.String(), nil
}

func (a *apkAttrappe) Add(_ context.Context, dateien []string) error {
	a.adds = append(a.adds, dateien)
	if a.addFehler != nil {
		return a.addFehler
	}
	for _, d := range dateien {
		// Die Datei muss zum Aufruf wirklich da sein (bestaetigte Bytes).
		if _, err := os.Stat(d); err != nil {
			return err
		}
		name := strings.TrimSuffix(d[strings.LastIndex(d, "/")+1:], ".apk")
		a.installiert = append(a.installiert, name)
	}
	return nil
}

func (a *apkAttrappe) Del(_ context.Context, namen []string) error {
	a.dels = append(a.dels, namen)
	return nil
}

// paketeBundle baut einen Anhang wie edge-light-pakete.tar.gz.
func paketeBundle(t *testing.T, arch string) []byte {
	t.Helper()
	ovpn := []byte("openvpn apk attrappe")
	kmod := []byte("kmod-tun apk attrappe")
	s := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	inhalt := "openwrt 25.12.5\narch " + arch + "\n" +
		s(ovpn) + "  openvpn-mbedtls-2.7.8-r1.apk\n" +
		s(kmod) + "  kmod-tun-6.12.94-r1.apk\n"
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, daten := range map[string][]byte{"pakete/INHALT": []byte(inhalt),
		"pakete/openvpn-mbedtls-2.7.8-r1.apk": ovpn, "pakete/kmod-tun-6.12.94-r1.apk": kmod} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(daten)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(daten)
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

// paketeBox ist eine Edge-Light-Box, deren LAUFENDE Fassung einen Paket-Anhang
// traegt: die Zuweisung nennt das laufende Release (Version), das Portal
// liefert den Anhang nach Pruefsumme.
type paketeBox struct {
	*lightBox
	apk     *apkAttrappe
	bundle  []byte
	abrufe  atomic.Int32
	anhangs *httptest.Server
}

func newPaketeBox(t *testing.T, arch string) *paketeBox {
	t.Helper()
	b := &paketeBox{lightBox: newLightBox(t), apk: &apkAttrappe{arch: "mipsel_24kc"}}
	b.bundle = paketeBundle(t, arch)
	sum := sha256.Sum256(b.bundle)
	sha := hex.EncodeToString(sum[:])
	// Die laufende Fassung: das Manifest nennt Version dieses Programms.
	b.manifest.Release = versionsRelease(t)
	b.manifest.Pakete = &otaverify.Pakete{Name: otaverify.PaketeDatei, SHA256: sha, Size: int64(len(b.bundle))}
	b.anhangs = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/edge/light-pakete/"+sha {
			http.NotFound(w, r)
			return
		}
		b.abrufe.Add(1)
		_, _ = w.Write(b.bundle)
	}))
	t.Cleanup(b.anhangs.Close)
	b.a.Cfg.PortalBaseURL = b.anhangs.URL
	b.a.Cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	b.a.paketePflege.apk = b.apk
	return b
}

// versionsRelease macht aus der Build-Stempelung einen Release-Namen, den
// ReleaseIsRunning als "laeuft hier" erkennt. Im Test ist Version kein Tag -
// darum stempeln wir sie fuer die Laufzeit des Tests um.
func versionsRelease(t *testing.T) string {
	t.Helper()
	alt := Version
	Version = "edge-light-2026.11.3"
	t.Cleanup(func() { Version = alt })
	return Version
}

func (b *paketeBox) pflegeLaeuft(t *testing.T) {
	t.Helper()
	b.zuweisen(t, "2026-11-26T08:00:00Z")
	b.a.otaCheckOnce()
	deadline := time.Now().Add(5 * time.Second)
	for {
		b.a.paketePflege.mu.Lock()
		busy, erledigt := b.a.paketePflege.busy, b.a.paketePflege.erledigt
		retry := b.a.paketePflege.retryAt
		b.a.paketePflege.mu.Unlock()
		if !busy && (erledigt != "" || !retry.IsZero()) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Pflege endet nicht (busy=%v erledigt=%q)", busy, erledigt)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPaketePflegeInstalliertAusDemGepruefteAnhang(t *testing.T) {
	b := newPaketeBox(t, "mipsel_24kc")
	b.pflegeLaeuft(t)
	if len(b.apk.adds) != 1 || len(b.apk.adds[0]) != 2 {
		t.Fatalf("apk add: %v", b.apk.adds)
	}
	if !paketInstalliert(mussInstallierte(t, b.apk), otapakete.Eintrag{Datei: "openvpn-mbedtls-2.7.8-r1.apk"}) ||
		!paketInstalliert(mussInstallierte(t, b.apk), otapakete.Eintrag{Datei: "kmod-tun-6.12.94-r1.apk"}) {
		t.Fatalf("installiert: %v", b.apk.installiert)
	}
	if b.a.paketePflege.erledigt != b.manifest.Release {
		t.Fatalf("erledigt %q", b.a.paketePflege.erledigt)
	}
	// Der naechste Takt laedt und installiert nicht erneut.
	b.a.otaCheckOnce()
	time.Sleep(20 * time.Millisecond)
	if b.abrufe.Load() != 1 || len(b.apk.adds) != 1 {
		t.Fatalf("erneut geladen/installiert: %d/%d", b.abrufe.Load(), len(b.apk.adds))
	}
	// Der RAM-Ordner mit den Paketdateien ist wieder weg.
	if _, err := os.Stat(b.ram + "/pakete"); !os.IsNotExist(err) {
		t.Fatal("der Pakete-Ordner liegt noch im RAM")
	}
}

func TestPaketePflegeTutNichtsWennAllesDa(t *testing.T) {
	b := newPaketeBox(t, "mipsel_24kc")
	b.apk.installiert = []string{"openvpn-mbedtls-2.7.8-r1", "kmod-tun-6.12.94-r1"}
	b.pflegeLaeuft(t)
	if len(b.apk.adds) != 0 || b.a.paketePflege.erledigt != b.manifest.Release {
		t.Fatalf("adds %v, erledigt %q", b.apk.adds, b.a.paketePflege.erledigt)
	}
}

func TestPaketePflegeAndereArchitekturInstalliertNichts(t *testing.T) {
	b := newPaketeBox(t, "x86_64") // der Anhang gilt fuer x86_64, das Geraet ist mipsel_24kc
	b.pflegeLaeuft(t)
	if len(b.apk.adds) != 0 || b.a.paketePflege.erledigt != b.manifest.Release {
		t.Fatalf("adds %v, erledigt %q", b.apk.adds, b.a.paketePflege.erledigt)
	}
}

func TestPaketePflegeNimmtBeiFehlschlagZurueck(t *testing.T) {
	b := newPaketeBox(t, "mipsel_24kc")
	b.apk.addFehler = errors.New("apk: Signatur ungueltig")
	b.pflegeLaeuft(t)
	if len(b.apk.dels) != 1 || strings.Join(b.apk.dels[0], " ") != "openvpn-mbedtls kmod-tun" {
		t.Fatalf("Ruecknahme: %v", b.apk.dels)
	}
	if b.a.paketePflege.erledigt != "" || b.a.paketePflege.retryAt.IsZero() {
		t.Fatalf("erledigt %q, retryAt %v", b.a.paketePflege.erledigt, b.a.paketePflege.retryAt)
	}
}

func TestPaketePflegeFalscheLieferungWirdVerworfen(t *testing.T) {
	b := newPaketeBox(t, "mipsel_24kc")
	b.bundle = append(b.bundle[:len(b.bundle)-1], b.bundle[len(b.bundle)-1]^1)
	b.pflegeLaeuft(t)
	if len(b.apk.adds) != 0 || b.a.paketePflege.erledigt != "" || b.a.paketePflege.retryAt.IsZero() {
		t.Fatalf("adds %v, erledigt %q", b.apk.adds, b.a.paketePflege.erledigt)
	}
}

func mussInstallierte(t *testing.T, a *apkAttrappe) string {
	t.Helper()
	s, err := a.Installierte(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return s
}
