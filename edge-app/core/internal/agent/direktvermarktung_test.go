package agent

// Agent-level tests for the direct-marketing DELIVERY (vp-direktvermarktung-
// konzept d2 §5.7): the retained profile is consumed, persisted and restored,
// the retained-clear deletes the access, the one-time access answer is checked
// against the box's own identity, and the heartbeat block reports the honest
// Lage. No tunnel, no OpenVPN - that is Stage 2/4.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

func dvTestAgent(t *testing.T) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a := &Agent{Cfg: cfg}
	a.dvDir = filepath.Join(t.TempDir(), "vermarkter")
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	t.Cleanup(func() {
		a.dvMu.Lock()
		if a.dv != nil {
			a.dv.Close()
		}
		a.dvMu.Unlock()
	})
	return a
}

func dvTestProfilDokument(t *testing.T, mutate ...func(*direktvermarkter.ProfilDokument)) []byte {
	t.Helper()
	p, ok := direktvermarkter.For("luox")
	if !ok {
		t.Fatal("eingebettetes luox-Profil fehlt")
	}
	doc := direktvermarkter.ProfilDokument{
		SchemaVersion: direktvermarkter.SchemaVersion,
		TenantID:      "t", SiteID: "s", DeviceID: "d",
		GeneratedAt: "2026-11-25T12:00:00Z",
		Partner:     "luox", Revision: 1,
		ZugangFingerabdruck: "SHA256:abc",
		Profil:              &p,
	}
	for _, m := range mutate {
		m(&doc)
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func dvTestZugang(mutate ...func(*direktvermarkter.ZugangAntwort)) []byte {
	z := direktvermarkter.ZugangAntwort{
		SchemaVersion: direktvermarkter.SchemaVersion,
		TenantID:      "t", SiteID: "s", DeviceID: "d",
		Partner: "luox", ZugangFingerabdruck: "SHA256:abc",
		Gegenstelle: direktvermarkter.Gegenstelle{Host: "vpn.luox.example", Port: 1194},
		Dateien: direktvermarkter.Dateien{ZertifikatPEM: "Z", SchluesselPEM: "S", CAPEM: "C"},
	}
	for _, m := range mutate {
		m(&z)
	}
	raw, _ := json.Marshal(z)
	return raw
}

// Profile in, access in, heartbeat block honest, restart keeps everything.
func TestDirektvermarktungZustellungAufDemAgenten(t *testing.T) {
	a := dvTestAgent(t)

	a.onDirektvermarktung(dvTestProfilDokument(t))
	sum := a.dvSummary()
	if sum == nil || sum.Partner != "luox" || sum.Lage != direktvermarkter.LageOhneZugang {
		t.Fatalf("Block nach Profil: %+v", sum)
	}

	a.onDirektvermarktungZugang(dvTestZugang())
	sum = a.dvSummary()
	if sum == nil || sum.Lage != direktvermarkter.LageBautAuf || sum.ZugangFingerabdruck != "SHA256:abc" {
		t.Fatalf("Block nach Zugang: %+v", sum)
	}
	if sum.VorgabePct == nil || *sum.VorgabePct != 100 {
		t.Fatalf("VorgabePct: %+v", sum.VorgabePct)
	}
	if sum.GrenzeKw != nil || sum.Werte != nil || sum.LebenszeichenAm != nil {
		t.Fatalf("unbekannte Werte erfunden: %+v", sum)
	}

	// A second agent over the same store (= restart): Boot restores the state.
	b := &Agent{Cfg: a.Cfg}
	b.dvDir = a.dvDir
	b.entIdentity = a.entIdentity
	defer func() {
		b.dvMu.Lock()
		if b.dv != nil {
			b.dv.Close()
		}
		b.dvMu.Unlock()
	}()
	b.loadDirektvermarktung()
	sum = b.dvSummary()
	if sum == nil || sum.Lage != direktvermarkter.LageBautAuf {
		t.Fatalf("Block nach Neustart: %+v", sum)
	}

	// Retained clear: everything deleted, block gone.
	b.onDirektvermarktung(nil)
	if sum := b.dvSummary(); sum != nil {
		t.Fatalf("Block nach Ruecknahme: %+v", sum)
	}
	if _, err := os.Stat(filepath.Join(b.dvDir, "schluessel.pem")); !os.IsNotExist(err) {
		t.Fatal("Schluessel nach Ruecknahme noch da")
	}
}

// Topic identity == payload identity: a misaddressed document changes nothing.
func TestDirektvermarktungFremdeIdentitaetWirdVerworfen(t *testing.T) {
	a := dvTestAgent(t)
	a.onDirektvermarktung(dvTestProfilDokument(t, func(d *direktvermarkter.ProfilDokument) {
		d.DeviceID = "fremd"
	}))
	if a.dvSummary() != nil {
		t.Fatal("fremdes Profil uebernommen")
	}
	a.onDirektvermarktung(dvTestProfilDokument(t))
	a.onDirektvermarktungZugang(dvTestZugang(func(z *direktvermarkter.ZugangAntwort) {
		z.DeviceID = "fremd"
	}))
	if sum := a.dvSummary(); sum.Lage != direktvermarkter.LageOhneZugang {
		t.Fatalf("fremder Zugang uebernommen: %+v", sum)
	}
}

// The per-box-kind store locations of §5.7.
func TestDirektvermarkterDirJeBoxArt(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = "/data"
	for art, want := range map[string]string{
		geraetesuche.BoxArtEdgeLight:     "/etc/vp-edge-light/vermarkter",
		geraetesuche.BoxArtEdgeIndustrie: "/home/voltpilot/vermarkter",
		geraetesuche.BoxArtDocker:        "/data/vermarkter",
		"":                               "/data/vermarkter",
	} {
		c := cfg
		c.BoxArt = art
		a := &Agent{Cfg: c}
		if got := a.direktvermarkterDir(); got != want {
			t.Fatalf("%q: %q, want %q", art, got, want)
		}
	}
}

// dvNachfassen re-asks at most every dvAnfrageAbstand while the access is
// missing, and stops once it is there.
func TestDirektvermarktungNachfassen(t *testing.T) {
	a := dvTestAgent(t)
	a.onDirektvermarktung(dvTestProfilDokument(t))
	// The handler's own request just ran (and failed - no link); the backoff
	// must hold now.
	a.dvMu.Lock()
	erste := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	if erste.IsZero() {
		t.Fatal("die Uebernahme hat keine Anfrage versucht")
	}
	a.dvNachfassen()
	a.dvMu.Lock()
	zweite := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	if !zweite.Equal(erste) {
		t.Fatal("Nachfassen ohne Abstand")
	}
	// After the backoff, it asks again.
	a.dvMu.Lock()
	a.dvLetzteAnfrage = time.Now().Add(-dvAnfrageAbstand - time.Minute)
	alt := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	a.dvNachfassen()
	a.dvMu.Lock()
	dritte := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	if dritte.Equal(alt) {
		t.Fatal("Nachfassen blieb aus")
	}
	// With the access stored, it stays quiet.
	a.onDirektvermarktungZugang(dvTestZugang())
	a.dvMu.Lock()
	a.dvLetzteAnfrage = time.Time{}
	a.dvMu.Unlock()
	a.dvNachfassen()
	a.dvMu.Lock()
	still := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	if !still.IsZero() {
		t.Fatal("Nachfassen trotz vorhandenem Zugang")
	}
}
