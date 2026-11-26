package agent

// The guard half of Stage 2 (vp-direktvermarktung-konzept d2, E2): the
// partner's fresh set-point composes into the export watchdog as
// min(registered limit, partner limit); the F5 "acts on generation" variant
// becomes a PV cap instead; an expired or missing watchdog composes NOTHING.
// The battery-first behaviour of the composed limit itself is the cascade's
// (guards/exportcascade.go) - a compliance limit lets the storage charge
// first by construction, which the container probe shows end to end.

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/vermarktertunnel"
)

type fakeVermarkter struct {
	mu         sync.Mutex
	anschluss  *vermarktertunnel.Anschluss
	kw         float64
	wirktAuf   string
	aktiv      bool
	werte      map[string]float64
	werteUm    time.Time
	status     *vermarktertunnel.Status
	stand      direktvermarkter.ServerStand
	standDa    bool
	ereignisse []string
}

func (f *fakeVermarkter) Run(ctx context.Context) { <-ctx.Done() }

func (f *fakeVermarkter) Anschluss() (vermarktertunnel.Anschluss, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.anschluss == nil {
		return vermarktertunnel.Anschluss{}, false
	}
	return *f.anschluss, true
}

func (f *fakeVermarkter) SetValues(at time.Time, values map[string]float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.werteUm, f.werte = at, values
}

func (f *fakeVermarkter) Grenze() (float64, string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.kw, f.wirktAuf, f.aktiv
}

func (f *fakeVermarkter) Status() vermarktertunnel.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.status != nil {
		return *f.status
	}
	return vermarktertunnel.Status{Lage: vermarktertunnel.LageVerbunden}
}

func (f *fakeVermarkter) ServerStand() (direktvermarkter.ServerStand, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stand, f.standDa
}

func (f *fakeVermarkter) Ereignis(text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ereignisse = append(f.ereignisse, text)
}

func TestVermarkterGrenzenKomponiertDasMinimum(t *testing.T) {
	a := &Agent{}
	fv := &fakeVermarkter{kw: 3.6, wirktAuf: direktvermarkter.WirktAufEinspeisung, aktiv: true}
	a.vermarkter = fv

	// partner below the registered limit: the partner wins
	eff, pvCap := a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 3.6 || pvCap != nil {
		t.Fatalf("eff=%v pvCap=%v, want 3.6/nil", eff, pvCap)
	}
	// registered below the partner: the registered limit stays (never widened)
	eff, _ = a.vermarkterGrenzen(fptr(2))
	if eff == nil || *eff != 2 {
		t.Fatalf("eff=%v, want 2 (min)", eff)
	}
	// no registered limit: the partner limit alone
	eff, _ = a.vermarkterGrenzen(nil)
	if eff == nil || *eff != 3.6 {
		t.Fatalf("eff=%v, want 3.6", eff)
	}
	// watchdog not fresh / set-point at rest: NOTHING composes
	fv.mu.Lock()
	fv.aktiv = false
	fv.mu.Unlock()
	eff, pvCap = a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 30 || pvCap != nil {
		t.Fatalf("abgelaufen: eff=%v pvCap=%v, want 30/nil", eff, pvCap)
	}
	// F5 answered "generation": the SAME limit returns as a PV cap and the
	// export limit stays untouched
	fv.mu.Lock()
	fv.aktiv, fv.wirktAuf = true, direktvermarkter.WirktAufErzeugung
	fv.mu.Unlock()
	eff, pvCap = a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 30 || pvCap == nil || *pvCap != 3.6 {
		t.Fatalf("erzeugung: eff=%v pvCap=%v, want 30/3.6", eff, pvCap)
	}
	// no manager at all (vp-edge-core without the feature) = untouched
	a.vermarkter = nil
	eff, pvCap = a.vermarkterGrenzen(fptr(30))
	if eff == nil || *eff != 30 || pvCap != nil {
		t.Fatalf("ohne Manager: eff=%v pvCap=%v", eff, pvCap)
	}
}

func TestFeedVermarkterDrehtDasVorzeichenUndLaesstFehlendesWeg(t *testing.T) {
	a := &Agent{}
	fv := &fakeVermarkter{anschluss: &vermarktertunnel.Anschluss{Partner: "luox", ReferenzWp: 12000}}
	a.vermarkter = fv
	a.merkeNetzgrenze(fptr(8)) // registered 8 kW on 12 kWp reference

	ts := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	a.feedVermarkter(ts, map[string]float64{
		"power_kw":    -2.35, // grid: negative = export
		"pv_power_kw": 5.0,
	})
	fv.mu.Lock()
	defer fv.mu.Unlock()
	if !fv.werteUm.Equal(ts) {
		t.Fatalf("Zeitstempel %v, want %v", fv.werteUm, ts)
	}
	if fv.werte["nvp_einspeisung_w"] != 2350 {
		t.Errorf("nvp_einspeisung_w = %v, want 2350 (Einspeisung positiv)", fv.werte["nvp_einspeisung_w"])
	}
	if fv.werte["erzeugung_w"] != 5000 {
		t.Errorf("erzeugung_w = %v", fv.werte["erzeugung_w"])
	}
	if fv.werte["referenz_w"] != 12000 {
		t.Errorf("referenz_w = %v", fv.werte["referenz_w"])
	}
	if got := fv.werte["netzbetreiber_vorgabe_pct"]; got != 67 {
		t.Errorf("netzbetreiber_vorgabe_pct = %v, want 67 (8 kW von 12 kWp)", got)
	}
}

func TestFeedVermarkterOhneMessungLaesstDenKanalWeg(t *testing.T) {
	a := &Agent{}
	fv := &fakeVermarkter{anschluss: &vermarktertunnel.Anschluss{Partner: "luox", ReferenzWp: 12000}}
	a.vermarkter = fv
	a.feedVermarkter(time.Now(), map[string]float64{"soc_pct": 50})
	fv.mu.Lock()
	defer fv.mu.Unlock()
	if _, da := fv.werte["nvp_einspeisung_w"]; da {
		t.Error("ohne Netz-Messung darf kein nvp_einspeisung_w stehen (Unbekannt ist keine Null)")
	}
	if _, da := fv.werte["erzeugung_w"]; da {
		t.Error("ohne PV-Messung darf kein erzeugung_w stehen")
	}
	// F7: without a registered limit the grid-operator register shows 100
	if fv.werte["netzbetreiber_vorgabe_pct"] != netzbetreiberOhneSignalPct {
		t.Errorf("netzbetreiber_vorgabe_pct = %v, want %v", fv.werte["netzbetreiber_vorgabe_pct"], netzbetreiberOhneSignalPct)
	}
}

func TestNetzbetreiberPctKlemmtInsBand(t *testing.T) {
	a := &Agent{}
	a.merkeNetzgrenze(fptr(99)) // 99 kW on a 12 kWp reference: over 100 %
	if got := a.netzbetreiberPct(12000); got != 100 {
		t.Errorf("pct = %v, want 100 (geklemmt)", got)
	}
	a.merkeNetzgrenze(fptr(-1))
	if got := a.netzbetreiberPct(12000); got != 0 {
		t.Errorf("pct = %v, want 0 (geklemmt)", got)
	}
	a.merkeNetzgrenze(nil)
	if got := a.netzbetreiberPct(12000); got != netzbetreiberOhneSignalPct {
		t.Errorf("pct = %v, want %v (F7)", got, netzbetreiberOhneSignalPct)
	}
	if math.IsNaN(a.netzbetreiberPct(0)) {
		t.Error("Referenz 0 darf kein NaN ergeben")
	}
}

// --- the DELIVERY (task vp-dv-zustellung) ---------------------------------------
//
// The handlers write and remove EXACTLY the tunnel manager's files
// (internal/vermarktertunnel/zugang.go); the §5.4 state itself is the
// manager's and is proven in its own package. Here: file contract, identity
// rules, acknowledgements, back-off, heartbeat block.

func dvTestAgent(t *testing.T) (*Agent, *fakeVermarkter) {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.VermarkterDir = filepath.Join(t.TempDir(), "vermarkter")
	a := &Agent{Cfg: cfg}
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	fv := &fakeVermarkter{}
	a.vermarkter = fv
	return a, fv
}

func dvTestProfilDokument(t *testing.T, mutate ...func(*direktvermarkter.ProfilDokument)) []byte {
	t.Helper()
	doc := direktvermarkter.ProfilDokument{
		SchemaVersion: direktvermarkter.SchemaVersion,
		TenantID:      "t", SiteID: "s", DeviceID: "d",
		GeneratedAt: "2026-11-26T08:00:00Z",
		Partner:     "luox", Revision: 1, ReferenzWp: 12000,
		ZugangFingerabdruck: "SHA256:abc",
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
		GueltigBis:    "2027-11-26T00:00:00Z",
		TLSSchluessel: "keine",
		Gegenstelle:   direktvermarkter.Gegenstelle{Host: "vpn.luox.example", Port: 1194, Protokoll: "udp"},
		Dateien: direktvermarkter.Dateien{
			ZertifikatPEM: "-----BEGIN CERTIFICATE-----\nZ\n-----END CERTIFICATE-----\n",
			SchluesselPEM: "-----BEGIN PRIVATE KEY-----\nS\n-----END PRIVATE KEY-----\n",
			CAPEM:         "-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----\n"},
	}
	for _, m := range mutate {
		m(&z)
	}
	raw, _ := json.Marshal(z)
	return raw
}

// Profile in: the manager's files appear. Access in: loadable through the
// SAME LadeZugang the manager uses, 0600. Retained clear: everything gone.
func TestDirektvermarktungZustellungSchreibtDenDateivertrag(t *testing.T) {
	a, fv := dvTestAgent(t)
	dir := a.dvDir()

	a.onDirektvermarktung(dvTestProfilDokument(t))
	anschluss, ok, err := vermarktertunnel.LadeAnschluss(dir)
	if err != nil || !ok || anschluss.Partner != "luox" || anschluss.ReferenzWp != 12000 {
		t.Fatalf("anschluss.json: %+v ok=%v err=%v", anschluss, ok, err)
	}
	if doc := a.dvDokument(); doc == nil || doc.Revision != 1 || doc.ZugangFingerabdruck != "SHA256:abc" {
		t.Fatalf("zustellung.json: %+v", doc)
	}
	if _, ok, _ := vermarktertunnel.LadeZugang(dir); ok {
		t.Fatal("Zugang vor der Zustellung vorhanden")
	}

	a.onDirektvermarktungZugang(dvTestZugang())
	z, ok, err := vermarktertunnel.LadeZugang(dir)
	if err != nil || !ok || z.Fingerabdruck != "SHA256:abc" || z.Gegenstelle.Host != "vpn.luox.example" ||
		z.Gegenstelle.Protokoll != "udp" || z.TLSSchluessel != "keine" {
		t.Fatalf("zugang: %+v ok=%v err=%v", z, ok, err)
	}
	for _, name := range []string{vermarktertunnel.ZertifikatDatei, vermarktertunnel.SchluesselDatei,
		vermarktertunnel.CADatei, vermarktertunnel.ZugangDatei} {
		info, err := os.Stat(filepath.Join(dir, vermarktertunnel.ZugangOrdner, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s: Rechte %v", name, info.Mode().Perm())
		}
	}

	// Retained clear: access, choice and bookkeeping gone; the event trail
	// went through the manager's one flash list.
	a.onDirektvermarktung(nil)
	if _, ok, _ := vermarktertunnel.LadeAnschluss(dir); ok {
		t.Fatal("anschluss.json nach der Ruecknahme noch da")
	}
	if _, ok, _ := vermarktertunnel.LadeZugang(dir); ok {
		t.Fatal("zugang nach der Ruecknahme noch da")
	}
	if _, err := os.Stat(filepath.Join(dir, vermarktertunnel.ZugangOrdner, vermarktertunnel.SchluesselDatei)); !os.IsNotExist(err) {
		t.Fatal("schluessel.pem nach der Ruecknahme noch da")
	}
	if a.dvDokument() != nil {
		t.Fatal("zustellung.json nach der Ruecknahme noch da")
	}
	fv.mu.Lock()
	defer fv.mu.Unlock()
	if len(fv.ereignisse) < 3 {
		t.Fatalf("Ereignisse: %v", fv.ereignisse)
	}
	for _, e := range fv.ereignisse {
		if strings.Contains(e, "BEGIN") || strings.Contains(e, "PRIVATE") {
			t.Fatalf("Ereignis traegt Material: %q", e)
		}
	}
}

// A profile naming a DIFFERENT access deletes the stored one first (one
// certificate, one plant - §8).
func TestDirektvermarktungFingerabdruckWechselLoeschtDenAlten(t *testing.T) {
	a, _ := dvTestAgent(t)
	a.onDirektvermarktung(dvTestProfilDokument(t))
	a.onDirektvermarktungZugang(dvTestZugang())

	a.onDirektvermarktung(dvTestProfilDokument(t, func(d *direktvermarkter.ProfilDokument) {
		d.Revision = 2
		d.ZugangFingerabdruck = "SHA256:neu"
	}))
	if _, ok, _ := vermarktertunnel.LadeZugang(a.dvDir()); ok {
		t.Fatal("alter Zugang nach dem Wechsel noch da")
	}
	// A late answer for the OLD fingerprint is refused; the new one lands.
	a.onDirektvermarktungZugang(dvTestZugang())
	if _, ok, _ := vermarktertunnel.LadeZugang(a.dvDir()); ok {
		t.Fatal("alter Zugang angenommen")
	}
	a.onDirektvermarktungZugang(dvTestZugang(func(z *direktvermarkter.ZugangAntwort) {
		z.ZugangFingerabdruck = "SHA256:neu"
	}))
	z, ok, _ := vermarktertunnel.LadeZugang(a.dvDir())
	if !ok || z.Fingerabdruck != "SHA256:neu" {
		t.Fatalf("neuer Zugang: %+v ok=%v", z, ok)
	}
}

// Topic identity == payload identity: a misaddressed document changes nothing.
func TestDirektvermarktungFremdeIdentitaetWirdVerworfen(t *testing.T) {
	a, _ := dvTestAgent(t)
	a.onDirektvermarktung(dvTestProfilDokument(t, func(d *direktvermarkter.ProfilDokument) {
		d.DeviceID = "fremd"
	}))
	if _, ok, _ := vermarktertunnel.LadeAnschluss(a.dvDir()); ok {
		t.Fatal("fremdes Profil uebernommen")
	}
	a.onDirektvermarktung(dvTestProfilDokument(t))
	a.onDirektvermarktungZugang(dvTestZugang(func(z *direktvermarkter.ZugangAntwort) {
		z.DeviceID = "fremd"
	}))
	if _, ok, _ := vermarktertunnel.LadeZugang(a.dvDir()); ok {
		t.Fatal("fremder Zugang uebernommen")
	}
}

// dvNachfassen re-asks at most every dvAnfrageAbstand while the access is
// missing, and stays quiet once it is there.
func TestDirektvermarktungNachfassen(t *testing.T) {
	a, _ := dvTestAgent(t)
	a.onDirektvermarktung(dvTestProfilDokument(t))
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

// The heartbeat block reports the manager's §5.4 view plus the interface
// snapshot - absent facts stay absent, never a fabricated zero.
func TestDvSummaryBerichtetAusManagerUndSchnittstelle(t *testing.T) {
	a, fv := dvTestAgent(t)
	a.onDirektvermarktung(dvTestProfilDokument(t))
	a.onDirektvermarktungZugang(dvTestZugang())

	jetzt := time.Now()
	handschlag := jetzt.Add(-20 * time.Second)
	abfrage := jetzt.Add(-12 * time.Second)
	pct := 30
	kw := 3.6
	fv.mu.Lock()
	fv.status = &vermarktertunnel.Status{
		Lage: vermarktertunnel.LageVorgabeAktiv, Partner: "luox",
		Gegenstelle: "vpn.luox.example:1194", TunnelLebteZuletzt: &handschlag,
		LetzteAbfrage: &abfrage, VorgabePct: &pct, GrenzeKw: &kw,
	}
	fv.stand = direktvermarkter.ServerStand{
		State: direktvermarkter.StateLimitActive, EffektivPct: 30, Aktiv: true,
		LetzteAbfrage: abfrage, LetzteSchreibung: abfrage, Lebenszeichen: abfrage,
		WerteStand: jetzt.Add(-5 * time.Second), Abfragen: 7,
		Werte: map[string]float64{"nvp_einspeisung_w": 1200, "erzeugung_w": 3000,
			"netzbetreiber_vorgabe_pct": 100, "referenz_w": 12000},
	}
	fv.standDa = true
	fv.mu.Unlock()

	sum := a.dvSummary()
	if sum == nil || sum.Lage != "vorgabe_aktiv" || sum.Partner != "luox" || sum.Revision != 1 {
		t.Fatalf("Block: %+v", sum)
	}
	if sum.ZugangFingerabdruck != "SHA256:abc" {
		t.Fatalf("Fingerabdruck: %q", sum.ZugangFingerabdruck)
	}
	if sum.VorgabePct == nil || *sum.VorgabePct != 30 || sum.GrenzeKw == nil || *sum.GrenzeKw != 3.6 {
		t.Fatalf("Vorgabe/Grenze: %+v", sum)
	}
	if sum.Tunnel == nil || sum.Tunnel.HandshakeAm == nil || sum.Tunnel.Gegenstelle != "vpn.luox.example:1194" {
		t.Fatalf("Tunnel: %+v", sum.Tunnel)
	}
	if sum.LebenszeichenAm == nil || sum.LetzteSchreibungAm == nil || sum.LetzteAbfrageAm == nil {
		t.Fatalf("Zeiten: %+v", sum)
	}
	if sum.Werte == nil || sum.Werte.EinspeisungW == nil || *sum.Werte.EinspeisungW != 1200 ||
		sum.Werte.ReferenzW == nil || *sum.Werte.ReferenzW != 12000 {
		t.Fatalf("Werte: %+v", sum.Werte)
	}

	// Stale input cache: the values leave the block (the partner would get
	// the stale exception for them too).
	fv.mu.Lock()
	fv.stand.WerteStand = jetzt.Add(-5 * time.Minute)
	fv.mu.Unlock()
	if sum := a.dvSummary(); sum.Werte != nil {
		t.Fatalf("veraltete Werte berichtet: %+v", sum.Werte)
	}

	// No profile delivered at all: no block.
	fv.mu.Lock()
	fv.status = &vermarktertunnel.Status{Lage: vermarktertunnel.LageOhneProfil}
	fv.mu.Unlock()
	if sum := a.dvSummary(); sum != nil {
		t.Fatalf("Block ohne Anschluss: %+v", sum)
	}
}
