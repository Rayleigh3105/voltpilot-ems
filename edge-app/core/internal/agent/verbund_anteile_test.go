package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/anteile"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Identities of verbund-anteile-mqtt-vectors.json (Ahrenberg R12: E-1 leads,
// E-4 co-controls).
const (
	vaTenant = "7a000000-0000-4000-8000-000000000001"
	vaSite   = "7a000000-0000-4000-8000-0000000000a1"
	vaE1     = "7a000000-0000-4000-8000-0000000000e1"
	vaE4     = "7a000000-0000-4000-8000-0000000000e4"
)

// anteilDok is the payload the cloud publishes (VerbundAnteileDokument.nutzlast)
// with the E-4 row of the R12 table; rolle is the IP-17 addition.
func anteilDok(site string, epoche, revision int, e1, e4 string, rolle string) []byte {
	r := ""
	if rolle != "" {
		r = fmt.Sprintf(`,"rolle":%q`, rolle)
	}
	return []byte(fmt.Sprintf(`{"schema_version":"1.0","tenant_id":%q,"site_id":%q,"device_id":%q,`+
		`"epoche":%d,"revision":%d,"schritt":"ziel","verteilbar":{"einspeisung":100.0,"bezug":77.0},`+
		`"anteile":{"einspeisung":{%q:%s,%q:%s},"bezug":{%q:0.0,%q:77.0}},"published_at":"2027-10-20T09:00:00Z"%s}`,
		vaTenant, site, vaE4, epoche, revision, vaE1, e1, vaE4, e4, vaE1, vaE4, r))
}

func anteilAgent(t *testing.T, dir string) *Agent {
	t.Helper()
	a := &Agent{State: state.New("", "")}
	a.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	s, err := anteile.NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a.restoreAnteile(s)
	return a
}

func quittung(t *testing.T, r *cloud.AnteileResult, angenommen bool, grund string, wirksam int64) {
	t.Helper()
	if r == nil || r.Angenommen != angenommen || r.Grund != grund || r.Wirksam == nil || r.Wirksam.Revision != wirksam {
		t.Fatalf("receipt %+v, want angenommen=%v grund=%q wirksam revision %d", r, angenommen, grund, wirksam)
	}
}

// A10/A18 on the box: a lower revision of the same epoch is refused and the
// held share stays; the same revision again and a higher epoch are accepted;
// another plant, a table without the own id and a sum over verteilbar are
// refused. EVERY verdict is a receipt (with the stand the box keeps).
func TestAnteilRevisionEpocheUndAblehnungen(t *testing.T) {
	a := anteilAgent(t, t.TempDir())
	now := time.Date(2027, 10, 20, 9, 0, 5, 0, time.UTC)
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 9, "10.0", "90.0", "steuert_mit"), now), true, "", 9)
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 7, "40.0", "60.0", "steuert_mit"), now), false, "revision_aelter", 9)
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 9, "10.0", "90.0", "steuert_mit"), now), true, "", 9)
	quittung(t, a.nimmAnteile(anteilDok("7a000000-0000-4000-8000-0000000000a2", 1, 10, "10.0", "90.0", ""), now),
		false, "fremde_anlage", 9)
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 10, "40.0", "70.0", ""), now), false, "summe_ueber_verteilbar", 9)
	ohneBox := []byte(`{"schema_version":"1.0","tenant_id":"` + vaTenant + `","site_id":"` + vaSite + `","device_id":"` +
		vaE4 + `","epoche":1,"revision":10,"schritt":"ziel","verteilbar":{"einspeisung":100.0,"bezug":77.0},` +
		`"anteile":{"einspeisung":{"` + vaE1 + `":40.0,"` + vaE4 + `":60.0},"bezug":{"` + vaE1 + `":0.0}},"published_at":"2027-10-20T09:00:00Z"}`)
	quittung(t, a.nimmAnteile(ohneBox, now), false, "box_fehlt_im_dokument", 9)
	if h := a.heldAnteile(); h.Stand != (anteile.Stand{Epoche: 1, Revision: 9}) || h.AnteilKw["einspeisung"] != "90.0" {
		t.Fatalf("a rejection changed the held share: %+v", h)
	}
	// a new epoch (re-armed after a rollback, A18) starts over at revision 8
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 2, 8, "10.0", "60.0", "steuert_mit"), now), true, "", 8)
	if h := a.heldAnteile(); h.Stand != (anteile.Stand{Epoche: 2, Revision: 8}) || h.AnteilKw["einspeisung"] != "60.0" {
		t.Fatalf("new epoch not held: %+v", h)
	}
	if r := a.nimmAnteile(anteilDok(vaSite, 1, 99, "10.0", "60.0", ""), now); r == nil || r.Grund != "revision_aelter" {
		t.Fatalf("older epoch with a higher revision accepted: %+v", r)
	}
}

// R15/A13: the accepted share is on disk and a NEW agent holds it with epoch
// and revision straight out of New - before Start, i.e. before any
// measurement can arrive - and mirrors it in the heartbeat.
func TestAnteilNeustartBehaeltDenAnteilVorDemErstenMesswert(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = vaTenant, vaSite, vaE4
	vorher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	vorher.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	if vorher.gemeinsameSteuerung() != nil {
		t.Fatal("block before any document")
	}
	quittung(t, vorher.nimmAnteile(anteilDok(vaSite, 1, 8, "10.0", "60.0", "steuert_mit"), time.Now()), true, "", 8)

	nachher, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !nachher.lastReadingAt.IsZero() {
		t.Fatal("test premise: no measurement yet")
	}
	h := nachher.heldAnteile()
	if h == nil || h.Stand != (anteile.Stand{Epoche: 1, Revision: 8}) || h.Rolle != "steuert_mit" ||
		h.AnteilKw["einspeisung"] != "60.0" || h.AnteilKw["bezug"] != "77.0" {
		t.Fatalf("share after restart: %+v", h)
	}
	raw, _ := json.Marshal(nachher.gemeinsameSteuerung())
	// IP-22 adds the day's share loss (nothing counted yet) - only with a document
	tag := nachher.verlust.TagVon(time.Now())
	if string(raw) != `{"rolle":"steuert_mit","anteile_revision":8,"anteile_epoche":1,"anteile_kw":{"einspeisung":60.0,"bezug":77.0},`+
		`"anteil_verlust":{"tag":"`+tag+`","kwh":0,"gebunden_s":0}}` {
		t.Fatalf("heartbeat block after restart: %s", raw)
	}
	// the restarted box still refuses the older revision of the same epoch
	nachher.State.Update(func(s *state.Snapshot) { s.TenantID, s.SiteID, s.DeviceID = vaTenant, vaSite, vaE4 })
	quittung(t, nachher.nimmAnteile(anteilDok(vaSite, 1, 7, "40.0", "60.0", ""), time.Now()), false, "revision_aelter", 8)
}

// Nothing ever widens: an empty retained message, an unreadable payload and a
// document for another box leave the held share (and send no receipt); a
// document that cannot be persisted is not accepted.
func TestAnteilVerlorenesDokumentErweitertNie(t *testing.T) {
	dir := t.TempDir()
	a := anteilAgent(t, dir)
	now := time.Now()
	quittung(t, a.nimmAnteile(anteilDok(vaSite, 1, 9, "10.0", "90.0", ""), now), true, "", 9)
	andereBox := []byte(`{"schema_version":"1.0","tenant_id":"` + vaTenant + `","site_id":"` + vaSite +
		`","device_id":"` + vaE1 + `","epoche":1,"revision":10,"schritt":"ziel","verteilbar":{"einspeisung":100,"bezug":77},` +
		`"anteile":{"einspeisung":{},"bezug":{}},"published_at":"2027-10-20T09:00:00Z"}`)
	for name, p := range map[string][]byte{"leer": nil, "unlesbar": []byte(`{"schema_version":"2.0"}`), "andere Box": andereBox} {
		if r := a.nimmAnteile(p, now); r != nil {
			t.Fatalf("%s: receipt %+v", name, r)
		}
		if h := a.heldAnteile(); h == nil || h.Stand.Revision != 9 {
			t.Fatalf("%s: held share changed: %+v", name, h)
		}
	}
	if b := anteilAgent(t, dir).heldAnteile(); b == nil || b.Stand.Revision != 9 {
		t.Fatalf("the empty retained message cleared the disk: %+v", b)
	}
	// a store that cannot write (a directory where its temp file goes - a type
	// collision, the root-proof way): not on disk = not accepted, no receipt
	bad := t.TempDir()
	if err := os.MkdirAll(filepath.Join(bad, "verbund-anteile.json.tmp"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := anteilAgent(t, bad)
	if r := c.nimmAnteile(anteilDok(vaSite, 1, 9, "10.0", "90.0", ""), now); r != nil || c.heldAnteile() != nil {
		t.Fatalf("accepted without persisting: %+v / %+v", r, c.heldAnteile())
	}
}

// Without a document the box is byte for byte the IP-10 box: no block without
// a plan, and with a plan exactly the IP-10 fields (TestHerzschlagMitUndOhneBlock
// pins the bytes). The capability is advertised because the way behind it works.
func TestOhneAnteilHerzschlagWieNachIP10(t *testing.T) {
	a := anteilAgent(t, t.TempDir())
	if b := a.gemeinsameSteuerung(); b != nil {
		t.Fatalf("block without plan and document: %+v", b)
	}
	if !slices.Contains(cloud.BuiltSupports(), "steuerungsverbund_anteil") {
		t.Fatal("share document built but steuerungsverbund_anteil not advertised")
	}
}
