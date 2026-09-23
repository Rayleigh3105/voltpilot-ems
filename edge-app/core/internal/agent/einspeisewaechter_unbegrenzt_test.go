package agent

// AP-15 Folge "Anlage ohne Einspeisegrenze" (captain 23.09.2026: Einspeisung
// unbegrenzt - nur der Bezug wird aufgeteilt), agent half: a share document
// WITHOUT a feed-in side is accepted and receipted like any valid document,
// the import share binds, and there is NO feed-in watchdog share - the
// feed-in side runs exactly as without a document. A document with both
// sides stays as before (einspeisewaechter_anteil_test.go, R15/V6).

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/anteile"
)

// nurBezugDok is the document of Box Verwaltung (E-4) at a plant with
// explicitly no feed-in limit: only the import side, 0 / 77 kW.
func nurBezugDok(revision int) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":1,"revision":%d,"schritt":"ziel","rolle":"fuehrt","verteilbar":{"bezug":77.0},`+
		`"anteile":{"bezug":{%q:0.0,%q:77.0}},"published_at":"2027-10-20T09:00:00Z"}`,
		vaTenant, vaSite, vaE4, revision, vaE1, vaE4))
}

func TestOhneEinspeiseseiteAngenommenOhneEinspeiseWaechter(t *testing.T) {
	dir := t.TempDir()
	a := anteilAgent(t, dir)
	quittung(t, a.nimmAnteile(nurBezugDok(1), time.Now()), true, "", 1)
	if an := a.exportAnteil(); an != nil {
		t.Fatalf("no feed-in side: no feed-in share expected, got %+v", an)
	}
	b := a.bezugAnteil()
	if b == nil || b.AnteilKw != 77 {
		t.Fatalf("the import share binds: 77 kW expected, got %+v", b)
	}
	h := a.heldAnteile()
	if h == nil || !h.EinspeisungUnbegrenzt || h.AnteilKw["bezug"] != "77.0" {
		t.Fatalf("held share: %+v", h)
	}
	if _, ok := h.AnteilKw["einspeisung"]; ok {
		t.Fatalf("no feed-in entry may be mirrored: %+v", h.AnteilKw)
	}

	// R15: after a restart the same document is back from disk, still
	// without a feed-in share.
	neu := anteilAgent(t, dir)
	if an := neu.exportAnteil(); an != nil || neu.heldAnteile() == nil || !neu.heldAnteile().EinspeisungUnbegrenzt {
		t.Fatalf("after restart: feed-in share %+v, held %+v", an, neu.heldAnteile())
	}

	// A later document WITH a feed-in side narrows again: the watchdog is back.
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 2, "40.0", "60.0", "fuehrt"), time.Now()), true, "", 2)
	if an := a.exportAnteil(); an == nil || an.AnteilKw != 60 || !an.Fuehrt {
		t.Fatalf("with a feed-in side the share is back: %+v", an)
	}
}

// Bestandsschutz: a document with both sides holds the feed-in share exactly
// as before - never "unbounded".
func TestMitBeidenSeitenBleibtDerEinspeiseAnteil(t *testing.T) {
	a := anteilAgent(t, t.TempDir())
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 1, "40.0", "60.0", "steuert_mit"), time.Now()), true, "", 1)
	h := a.heldAnteile()
	if h == nil || h.EinspeisungUnbegrenzt || h.AnteilKw["einspeisung"] != "60.0" {
		t.Fatalf("held share: %+v", h)
	}
	if an := a.exportAnteil(); an == nil || an.AnteilKw != 60 || an.Fuehrt {
		t.Fatalf("feed-in share 60 kW expected, got %+v", an)
	}
}

// Half a feed-in side stays refused as before: verteilbar.einspeisung without
// a feed-in table is box_fehlt_im_dokument (with a receipt), a feed-in table
// without verteilbar.einspeisung is unreadable (no receipt).
func TestHalbeEinspeiseseiteBleibtAbgelehnt(t *testing.T) {
	a := anteilAgent(t, t.TempDir())
	ohneTabelle := []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":1,"revision":1,"schritt":"ziel","verteilbar":{"einspeisung":100.0,"bezug":77.0},`+
		`"anteile":{"bezug":{%q:0.0,%q:77.0}},"published_at":"2027-10-20T09:00:00Z"}`, vaTenant, vaSite, vaE4, vaE1, vaE4))
	if r := a.nimmAnteile(ohneTabelle, time.Now()); r == nil || r.Angenommen || r.Grund != anteile.GrundBoxFehlt {
		t.Fatalf("verteilbar without table: %+v", r)
	}
	ohneVerteilbar := []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":1,"revision":1,"schritt":"ziel","verteilbar":{"bezug":77.0},`+
		`"anteile":{"einspeisung":{%q:40.0,%q:60.0},"bezug":{%q:0.0,%q:77.0}},"published_at":"2027-10-20T09:00:00Z"}`,
		vaTenant, vaSite, vaE4, vaE1, vaE4, vaE1, vaE4))
	if r := a.nimmAnteile(ohneVerteilbar, time.Now()); r != nil {
		t.Fatalf("table without verteilbar: unreadable, no receipt expected, got %+v", r)
	}
	if a.heldAnteile() != nil {
		t.Fatalf("nothing may be held: %+v", a.heldAnteile())
	}
}
