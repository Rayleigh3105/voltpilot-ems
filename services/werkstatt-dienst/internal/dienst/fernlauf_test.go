package dienst_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/netip"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fernlauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// fernlaufPortal nimmt keinen Auftrag an (409, wie ein schon angenommener) und zählt die Versuche.
type fernlaufPortal struct {
	mu       sync.Mutex
	beginnen []string
}

func (p *fernlaufPortal) FernlaufBeginnen(_ context.Context, id string) (portal.FernlaufAuftrag, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.beginnen = append(p.beginnen, id)
	return portal.FernlaufAuftrag{}, portal.Abgelehnt{Status: 409, Message: "schon angenommen"}
}
func (p *fernlaufPortal) FernlaufSchritt(context.Context, string, string, string, string) error {
	return nil
}
func (p *fernlaufPortal) FernlaufMeldungLesen(context.Context, string) (portal.FernlaufMeldung, error) {
	return portal.FernlaufMeldung{}, nil
}
func (p *fernlaufPortal) FernlaufErgebnisMelden(context.Context, string, portal.FernlaufErgebnis) error {
	return nil
}
func (p *fernlaufPortal) FernlaufFensterSchliessen(context.Context, string) (bool, error) {
	return false, nil
}

// Ein Auftrag „aufspielen“ kommt mit der Antwort auf die Ansicht (wie
// „nochmal“) und geht an den Fernlauf; das Portal nennt ihn in jeder Antwort,
// bis er angenommen ist - der Dienst nimmt ihn trotzdem nur einmal an. Die
// Ansicht meldet, ob der Dienst Fernläufe kann.
func TestAuftragAufspielenGehtAnDenFernlauf(t *testing.T) {
	m := attrappe.NeueMango(t, true)
	w := werkbankMit(t, m, &standPortal{})
	melder := &melderAttrappe{}
	w.d.Melder = melder
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	ablage, err := protokoll.NeueAblage(filepath.Join(t.TempDir(), "fernlaeufe"))
	if err != nil {
		t.Fatal(err)
	}
	fp := &fernlaufPortal{}
	w.d.Fernlauf = fernlauf.Neu(fernlauf.Konfig{Zugang: wartung.Zugang{Adresse: netip.MustParseAddr("10.10.32.50")}, SSH: signer,
		Fassungen: &fassungen.Ablage{Dir: t.TempDir()}, PortalURL: "http://portal.invalid", Bauart: "mipsle", Arbeit: t.TempDir(),
		Portal: fp, Ablage: ablage})
	ctx := context.Background()
	w.d.Runde(ctx)
	if a := w.d.Ansicht().Fernlauf; a == nil || !a.Bereit {
		t.Fatalf("Ansicht ohne bereiten Fernlauf: %+v", a)
	}
	auftrag := portal.Auftrag{ID: "0b5e7c1a-1111-4aaa-8bbb-0123456789ab", Art: portal.FernlaufArt, Lauf: "edge-k7m2xq3"}
	for range 3 {
		melder.auftraege = []portal.Auftrag{auftrag}
		w.d.Runde(ctx)
	}
	ende := time.Now().Add(5 * time.Second)
	for {
		fp.mu.Lock()
		n := len(fp.beginnen)
		fp.mu.Unlock()
		if n == 1 {
			break
		}
		if n > 1 || time.Now().After(ende) {
			t.Fatalf("FernlaufBeginnen %d-mal aufgerufen, erwartet einmal", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(melder.gesehen) == 0 || melder.gesehen[len(melder.gesehen)-1].Fernlauf == nil {
		t.Fatal("die gemeldete Ansicht trägt fernlauf nicht")
	}
}
