package fassungen

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

func summe(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func TestHoleLaedtPrueftUndHaelt(t *testing.T) {
	inhalt := []byte("ein abbild")
	var abrufe int
	var kopf string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		abrufe++
		kopf = r.Header.Get("Authorization")
		_, _ = w.Write(inhalt)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	tok := geheim.Neu("lese-token-fuer-releases")
	defer tok.Vergessen()
	a := &Ablage{Dir: t.TempDir(), Client: srv.Client(), Token: tok, TokenHost: u.Host}
	d := Datei{Name: "abbild.bin", URL: srv.URL + "/abbild.bin", Sha256: summe(inhalt), Max: 1024}
	e, err := a.Hole(context.Background(), d)
	if err != nil || !e.Geladen || kopf != "token lese-token-fuer-releases" {
		t.Fatalf("%+v %v %q", e, err, kopf)
	}
	e, err = a.Hole(context.Background(), d)
	if err != nil || e.Geladen || abrufe != 1 {
		t.Fatalf("zweites Mal geladen: %+v %v", e, err)
	}
	// Token nur an den eigenen Host
	b := &Ablage{Dir: t.TempDir(), Client: srv.Client(), Token: tok, TokenHost: "git.tecmaxx.de"}
	if _, err := b.Hole(context.Background(), d); err != nil || kopf != "" {
		t.Fatalf("Token an fremden Host: %q %v", kopf, err)
	}
	// falsche Prüfsumme: nie benutzt, nichts liegen gelassen
	c := &Ablage{Dir: t.TempDir(), Client: srv.Client()}
	d2 := d
	d2.Sha256 = strings.Repeat("a", 64)
	if _, err := c.Hole(context.Background(), d2); err == nil || !strings.Contains(err.Error(), "nicht benutzt") {
		t.Fatal(err)
	}
	if es, _ := os.ReadDir(c.Dir); len(es) != 0 {
		t.Fatalf("liegen geblieben: %v", es)
	}
	d3 := d
	d3.Max = 3
	if _, err := c.Hole(context.Background(), d3); err == nil {
		t.Fatal("zu groß angenommen")
	}
	d4 := d
	d4.URL = strings.Replace(srv.URL, "https", "http", 1)
	if _, err := c.Hole(context.Background(), d4); err == nil {
		t.Fatal("http angenommen")
	}
}

func targz(t *testing.T, eintraege map[string]string, typ byte) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for n, i := range eintraege {
		h := &tar.Header{Name: n, Mode: 0o755, Size: int64(len(i)), Typeflag: typ}
		if typ == tar.TypeSymlink {
			h.Size, h.Linkname = 0, "/etc/passwd"
		}
		_ = tw.WriteHeader(h)
		if typ == tar.TypeReg {
			_, _ = tw.Write([]byte(i))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	p := filepath.Join(t.TempDir(), "s.tar.gz")
	_ = os.WriteFile(p, buf.Bytes(), 0o644)
	return p
}

func TestAuspacken(t *testing.T) {
	gut := targz(t, map[string]string{"openwrt/install.sh": "#!/bin/sh\n", "openwrt/service-tunnel.sh": "#!/bin/sh\n", "openwrt/files/x": "x"}, tar.TypeReg)
	dir := t.TempDir()
	if err := Auspacken(gut, dir); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(filepath.Join(dir, "openwrt/install.sh")); err != nil || st.Mode().Perm()&0o100 == 0 {
		t.Fatal("install.sh fehlt oder nicht ausführbar")
	}
	for name, p := range map[string]string{
		"nach außen":   targz(t, map[string]string{"openwrt/install.sh": "", "openwrt/service-tunnel.sh": "", "../x": "x"}, tar.TypeReg),
		"fremder Ort":  targz(t, map[string]string{"openwrt/install.sh": "", "openwrt/service-tunnel.sh": "", "etc/x": "x"}, tar.TypeReg),
		"Verweis":      targz(t, map[string]string{"openwrt/install.sh": ""}, tar.TypeSymlink),
		"ohne Skripte": targz(t, map[string]string{"openwrt/files/x": "x"}, tar.TypeReg),
	} {
		if err := Auspacken(p, t.TempDir()); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
}

// Der echte Skriptstand, wie der Lauf edge-light-release.yaml ihn anhängt
// (edge-light/scripts/skripte-paket.py): auspackbar, mit beiden Skripten
// ausführbar, und gleicher Stand ergibt dieselbe Prüfsumme.
func TestEchterSkriptstand(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 fehlt")
	}
	dir := t.TempDir()
	var summen []string
	for _, n := range []string{"a.tar.gz", "b.tar.gz"} {
		p := filepath.Join(dir, n)
		if out, err := exec.Command("python3", "../../../../edge-light/scripts/skripte-paket.py", p).CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		s, err := Summe(p)
		if err != nil {
			t.Fatal(err)
		}
		summen = append(summen, s)
	}
	if summen[0] != summen[1] {
		t.Fatal("gleicher Stand, andere Prüfsumme")
	}
	ziel := t.TempDir()
	if err := Auspacken(filepath.Join(dir, "a.tar.gz"), ziel); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"openwrt/install.sh", "openwrt/service-tunnel.sh", "openwrt/files/usr/libexec/vp-wartung/schluessel-holen.sh"} {
		st, err := os.Stat(filepath.Join(ziel, s))
		if err != nil || st.Mode().Perm()&0o100 == 0 {
			t.Errorf("%s fehlt oder ist nicht ausführbar", s)
		}
	}
}

// Der echte Skriptstand von Edge Industrie, wie der Lauf
// edge-industrie-release.yaml ihn anhängt (edge-industrie/scripts/skripte-paket.py):
// auspackbar mit AuspackenPFC200, die Skripte ausführbar, gleicher Stand ergibt
// dieselbe Prüfsumme, und nichts im Paket, was nicht auf das Gerät gehört.
func TestEchterSkriptstandPFC200(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 fehlt")
	}
	dir := t.TempDir()
	var summen []string
	for _, n := range []string{"a.tar.gz", "b.tar.gz"} {
		p := filepath.Join(dir, n)
		if out, err := exec.Command("python3", "../../../../edge-industrie/scripts/skripte-paket.py", p).CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		s, err := Summe(p)
		if err != nil {
			t.Fatal(err)
		}
		summen = append(summen, s)
	}
	if summen[0] != summen[1] {
		t.Fatal("gleicher Stand, andere Prüfsumme")
	}
	ziel := t.TempDir()
	if err := AuspackenPFC200(filepath.Join(dir, "a.tar.gz"), ziel); err != nil {
		t.Fatal(err)
	}
	// fernlauf.sh braucht der Fernlauf (internal/fernlauf): ohne ihn im
	// signierten Skriptstand spielt er die Fassung nicht auf.
	for _, p := range []string{"install.sh", "wartung.sh", "fernlauf.sh", "files/etc/init.d/vp-wartung", "files/etc/init.d/vp-edge-industrie", "files/home/voltpilot/libexec/boot.sh"} {
		st, err := os.Stat(filepath.Join(ziel, IndustrieWurzel, p))
		if err != nil || st.Mode().Perm()&0o100 == 0 {
			t.Errorf("%s fehlt oder ist nicht ausführbar (%v)", p, err)
		}
	}
	for _, p := range []string{"wartung", "test", "scripts", "README.md", "dist"} {
		if _, err := os.Stat(filepath.Join(ziel, IndustrieWurzel, p)); err == nil {
			t.Errorf("%s gehört nicht in den Skriptstand", p)
		}
	}
	// Der Skriptstand der Mango gilt nicht als der des PFC200.
	if err := Auspacken(filepath.Join(dir, "a.tar.gz"), t.TempDir()); err == nil {
		t.Error("der Skriptstand von Edge Industrie gilt als der der Mango")
	}
}

// Der Skriptstand des PFC200 liegt unter edge-industrie/ und braucht
// install.sh, wartung.sh und das Dienst-Skript des Tunnels; der der Mango
// gilt dafür nicht.
func TestAuspackenPFC200(t *testing.T) {
	voll := map[string]string{"edge-industrie/install.sh": "#!/bin/sh\n", "edge-industrie/wartung.sh": "#!/bin/sh\n", "edge-industrie/files/etc/init.d/vp-wartung": "#!/bin/sh\n"}
	dir := t.TempDir()
	if err := AuspackenPFC200(targz(t, voll, tar.TypeReg), dir); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(filepath.Join(dir, "edge-industrie/wartung.sh")); err != nil || st.Mode().Perm()&0o100 == 0 {
		t.Fatal("wartung.sh fehlt oder nicht ausführbar")
	}
	for name, p := range map[string]string{
		"Skriptstand der Mango": targz(t, map[string]string{"openwrt/install.sh": "", "openwrt/service-tunnel.sh": ""}, tar.TypeReg),
		"ohne wartung.sh":       targz(t, map[string]string{"edge-industrie/install.sh": "", "edge-industrie/files/etc/init.d/vp-wartung": ""}, tar.TypeReg),
		"ohne Dienst-Skript":    targz(t, map[string]string{"edge-industrie/install.sh": "", "edge-industrie/wartung.sh": ""}, tar.TypeReg),
		"nach außen":            targz(t, map[string]string{"edge-industrie/install.sh": "", "edge-industrie/wartung.sh": "", "edge-industrie/files/etc/init.d/vp-wartung": "", "../x": "x"}, tar.TypeReg),
	} {
		if err := AuspackenPFC200(p, t.TempDir()); err == nil {
			t.Errorf("%s: angenommen", name)
		}
	}
	if err := Auspacken(targz(t, voll, tar.TypeReg), t.TempDir()); err == nil {
		t.Error("der Skriptstand des PFC200 gilt als der der Mango")
	}
}
