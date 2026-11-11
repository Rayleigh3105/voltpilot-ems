package csms

// OCPP "klopft an" (docs/contracts/ocpp-klopft-an.md): a refused identity is
// remembered 24 h with its attempts and address, reported newest first, at
// most 16, and gone once it is on the allowlist; an identity the allowlist
// could never take is not remembered. The list always passes the contract's
// own check (geraetesuche.PruefeKlopftAn).

import (
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

func klopfServer(t *testing.T, ids ...string) *Server {
	t.Helper()
	s, err := New(Options{Enabled: true, DataDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if _, err := s.Add(AddRequest{ID: id}); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func TestKlopfenFensterFormUndObergrenze(t *testing.T) {
	s := klopfServer(t, "SAEULE-1")
	t0 := time.Date(2026, 11, 2, 8, 0, 0, 0, time.UTC)
	s.merkeAbgewiesen("CP-HALLE1", "192.168.178.80:51234", t0)
	s.merkeAbgewiesen("CP-HALLE1", "192.168.178.80:51235", t0.Add(50*time.Minute))
	s.merkeAbgewiesen("kein gültiges wort", "192.168.178.81:1", t0)
	s.merkeAbgewiesen("SAEULE-1", "192.168.178.82:1", t0) // admitted meanwhile: not reported
	s.merkeAbgewiesen("ALT", "192.168.178.83:1", t0.Add(-25*time.Hour))
	for i := 0; i < 20; i++ {
		s.merkeAbgewiesen(fmt.Sprintf("CP-%02d", i), "172.17.0.1:1", t0.Add(time.Duration(i)*time.Minute))
	}
	nurLan := func(a netip.Addr) bool { return geraetesuche.KlopftAnAdresse(a.String(), nil) }
	liste := s.KlopfenAn(t0.Add(time.Hour), nurLan)
	if len(liste) != geraetesuche.MaxKlopftAn {
		t.Fatalf("%d entries, want %d", len(liste), geraetesuche.MaxKlopftAn)
	}
	if liste[0].ID != "CP-HALLE1" || liste[0].Attempts != 2 || !liste[0].FirstSeen.Equal(t0) ||
		liste[0].IP != "192.168.178.80" {
		t.Fatalf("newest first: %+v", liste[0])
	}
	for _, e := range liste {
		if e.ID == "SAEULE-1" || e.ID == "ALT" || e.ID == "kein gültiges wort" {
			t.Fatalf("reported %q", e.ID)
		}
	}
	if err := geraetesuche.PruefeKlopftAn(liste, nil); err != nil {
		t.Fatal(err)
	}
	// 24 h after the last knock the identity is forgotten.
	if spaeter := s.KlopfenAn(t0.Add(50*time.Minute+24*time.Hour+time.Second), nurLan); len(spaeter) != 0 {
		t.Fatalf("not forgotten: %+v", spaeter)
	}
}
