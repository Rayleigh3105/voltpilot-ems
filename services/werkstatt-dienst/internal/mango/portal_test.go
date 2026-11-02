package mango_test

import (
	"bytes"
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

const testCode = "wk-abcdefghijklmnopqrstuvwxyz"

// falschesPortal steht für den Dienst-Baum der API.
type falschesPortal struct {
	mu          sync.Mutex
	codes       []string
	geschlossen []string
	abnahmen    []portal.Abnahme
	codeFehler  error
}

func (p *falschesPortal) CodeHolen(_ context.Context, ref string, tausch bool) (portal.Code, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.codeFehler != nil {
		return portal.Code{}, p.codeFehler
	}
	p.codes = append(p.codes, ref)
	return portal.Code{Code: geheim.Neu(testCode), EdgeRef: ref, Freigabe: "2026-11-mango-1",
		GueltigBis: time.Now().Add(30 * time.Minute), Tausch: tausch}, nil
}

func (p *falschesPortal) FensterSchliessen(_ context.Context, id string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.geschlossen = append(p.geschlossen, id)
	return false, nil
}

func (p *falschesPortal) AbnahmeSchreiben(_ context.Context, ref string, a portal.Abnahme) (portal.Angenommen, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.abnahmen = append(p.abnahmen, a)
	return portal.Angenommen{ID: "abnahme-1", EdgeRef: ref, FreigabeID: "freigabe-1", EinloesungID: "einloesung-1"}, nil
}

const antwortEinloesung = `{"schema":"vp-werkstatt-einloesung.v1","edgeRef":"edge-k7m2xq3","freigabe":"2026-11-mango-1","tunnelErgebnis":"angelegt",
"tunnel":{"adresse":"10.10.16.7","boxNetz":"10.10.16.0/20","technikerNetz":"10.10.32.0/24","serverEndpunkt":"wartung.voltpilot.de","serverPort":51820,
"serverPublicKey":"c2VydmVyc2NobHVlc3NlbGRlc3dhcnR1bmdzc2VydmU=","serverAdresse":"10.10.16.1"},
"probe":{"fensterId":"5d1b2c3e-0000-4000-8000-000000000001","technikerId":"7e57ab1e-0000-4000-8000-00000000c0de","technikerName":"Werkstatt-Dienst",
"beginn":"2026-11-02T10:00:00Z","ende":"2026-11-02T10:30:00Z"},"geraeteSchluessel":{"sha256":"ab12","festgehaltenAm":"2026-11-02T10:00:00Z"}}`

func TestLaufMitPortal(t *testing.T) {
	a := neu(t, false)
	p := &falschesPortal{}
	a.k.Portal = p
	var gesehen struct{ code, wg, host string }
	a.m.Anmelden = func(code, wg, host string) (string, int) {
		gesehen.code, gesehen.wg, gesehen.host = code, wg, host
		return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0
	}
	l, z := a.fahre(t, mango.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v\n%s", z, l.Stand(), a.log.String())
	}
	want := "erkennen fassungen openwrt wiedererkennen internet passwort notfall programm tunnel_schluessel einloesen tunnel lan neustart probe internet_weg uebergabe"
	if got := strings.Join(l.Stand().Erledigt, " "); got != want {
		t.Fatalf("Schritte %s", got)
	}
	b := a.belege(t, l)
	// Die Box bekam den Code über die Standardeingabe, ihren Tunnel- und den im LAN gelesenen Host-Schlüssel.
	if gesehen.code != testCode || gesehen.wg != a.m.WgPub || !strings.HasPrefix(gesehen.host, "SHA256:") {
		t.Fatalf("an der Box: %+v", gesehen)
	}
	for _, c := range a.m.Befehle() {
		if strings.Contains(c, testCode) {
			t.Fatal("der Code steht im Befehl")
		}
	}
	e := b["einloesen"]
	if wert(t, e, "tunnel_adresse") != "10.10.16.7" || !strings.Contains(wert(t, e, "probe_fenster"), "5d1b2c3e-") ||
		!strings.Contains(wert(t, e, "geraete_schluessel"), "festgehalten") {
		t.Fatalf("Beleg einloesen %v", e)
	}
	// Der Tunnel nutzt die Adresse aus der Einlösung.
	if _, _, _, tunnel := a.m.Stand(); tunnel != "10.10.16.7" {
		t.Fatalf("Tunnel %s", tunnel)
	}
	// Probe-Fenster der Einlösung geschlossen, Abnahme mit acht Belegen und verschlüsseltem Passwort.
	if len(p.geschlossen) != 1 || p.geschlossen[0] != "5d1b2c3e-0000-4000-8000-000000000001" {
		t.Fatalf("geschlossen %v", p.geschlossen)
	}
	if len(p.abnahmen) != 1 {
		t.Fatalf("Abnahmen %d", len(p.abnahmen))
	}
	an := p.abnahmen[0]
	if len(an.Belege) != 8 || an.LanNetz != "10.213.0.1/24" || an.Fassung != "edge-light-2026.11.1" ||
		an.HostSchluessel != gesehen.host || !strings.HasPrefix(an.PasswortAge, "-----BEGIN AGE ENCRYPTED FILE-----") {
		t.Fatalf("Abnahme %+v", an)
	}
	for _, pr := range mango.Pruefungen {
		if strings.TrimSpace(an.Belege[pr]) == "" {
			t.Errorf("kein Beleg für %s", pr)
		}
	}
	if strings.Contains(an.PasswortAge, a.m.Passwort()) {
		t.Fatal("Passwort im Klartext an der Abnahme")
	}
	if !strings.Contains(wert(t, b["uebergabe"], "abnahme"), "abnahme-1") {
		t.Fatalf("Übergabe %v", b["uebergabe"])
	}
	// Der Code steht weder im Protokoll noch im Log.
	var alles bytes.Buffer
	_ = filepath.Walk(a.dir, func(pfad string, i os.FileInfo, err error) error {
		if err == nil && !i.IsDir() && !strings.Contains(pfad, "fassungen") {
			d, _ := os.ReadFile(pfad)
			alles.Write(d)
		}
		return nil
	})
	if strings.Contains(alles.String(), testCode) || strings.Contains(a.log.String(), testCode) {
		t.Fatal("der Code steht im Protokoll oder im Log")
	}
}

func TestEinloesenAbgewiesen(t *testing.T) {
	a := neu(t, true)
	a.k.Portal = &falschesPortal{}
	a.m.Anmelden = func(code, wg, host string) (string, int) {
		return "werkstatt-anmelden: Einlösen abgelehnt (HTTP 409, schluessel_festgehalten): Für edge-k7m2xq3 ist schon ein anderer Geräteschlüssel festgehalten.", 3
	}
	l, z := a.fahre(t, mango.AbOpenWrt)
	if z != lauf.Angehalten {
		t.Fatalf("Zustand %s", z)
	}
	s := l.Stand()
	if s.Schritt != "einloesen" || !strings.Contains(s.Grund, "abgewiesen") || !strings.Contains(s.Grund, "schluessel_festgehalten") {
		t.Fatalf("Stand %+v", s)
	}
	// Ohne Freigabe kein Code: an die Box geht kein werkstatt-anmelden.
	b := neu(t, true)
	b.k.Portal = &falschesPortal{codeFehler: errors.New("Portal: HTTP 409: Die Werkstatt ist nicht freigegeben.")}
	l2, z2 := b.fahre(t, mango.AbOpenWrt)
	if z2 != lauf.Angehalten || !strings.Contains(l2.Stand().Grund, "nicht freigegeben") {
		t.Fatalf("ohne Freigabe: %s %+v", z2, l2.Stand())
	}
	for _, c := range b.m.Befehle() {
		if strings.Contains(c, "werkstatt-anmelden") {
			t.Fatal("ohne Code an die Box gegangen")
		}
	}
}

// falscheProbe steht für die Anmeldung über den Tunnel (echt geprüft in internal/wartung).
type falscheProbe struct {
	m        interface{ Protokolliere(string) }
	host     string
	server   wartung.Server
	ziel     netip.AddrPort
	nachEnde string
}

func (p *falscheProbe) Fingerabdruck() string {
	return "SHA256:dienstschluesseldienstschluesseldienstschl"
}

func (p *falscheProbe) Anmelden(_ context.Context, s wartung.Server, box netip.AddrPort) (wartung.Anmeldung, error) {
	p.server, p.ziel = s, box
	p.m.Protokolliere("dropbear[812]: Pubkey auth succeeded for 'root' with ssh-rsa key " + p.Fingerabdruck() + " from 10.10.32.50:41000")
	return wartung.Anmeldung{HostSchluessel: p.host, Versuche: 2, Dauer: 4 * time.Second}, nil
}

func (p *falscheProbe) NachEnde(context.Context, wartung.Server, netip.AddrPort) (string, error) {
	p.m.Protokolliere("vp-wartung: Fenster-Schluessel jetzt: keine")
	p.m.Protokolliere("vp-wartung: Sitzung beendet (Dropbear-Prozess 812): Fenster zu")
	if p.nachEnde != "" {
		return "", errors.New(p.nachEnde)
	}
	return "Connection timed out (TCP-Aufbau an 10.10.16.7:2222 nach 10s ohne Antwort, Versuch 1)", nil
}

func TestLaufMitProbeUeberDenTunnel(t *testing.T) {
	a := neu(t, false)
	p := &falschesPortal{}
	a.k.Portal = p
	a.m.Anmelden = func(code, wg, host string) (string, int) { return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0 }
	probe := &falscheProbe{m: a.m}
	a.k.Probe = probe
	// Der Host-Schlüssel durch den Tunnel ist der aus dem LAN: die Attrappe nennt ihn beim ersten Schritt.
	a.m.Anmelden = func(code, wg, host string) (string, int) {
		probe.host = host
		return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0
	}
	l, z := a.fahre(t, mango.AbWerk)
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s: %+v\n%s", z, l.Stand(), a.log.String())
	}
	b := a.belege(t, l)
	pr := b["probe"]
	if wert(t, pr, "host_schluessel_tunnel") != wert(t, pr, "host_schluessel_lan") || !strings.HasPrefix(wert(t, pr, "neuer_versuch"), "Connection timed out") ||
		!strings.Contains(wert(t, pr, "box_log_anmeldung"), probe.Fingerabdruck()) || !(strings.Contains(wert(t, pr, "box_log_ende"), "Sitzung beendet") || strings.Contains(wert(t, pr, "box_log_ende"), "Fenster-Schluessel jetzt: keine")) {
		t.Fatalf("Beleg probe %v", pr)
	}
	// Server und Ziel kommen aus der Einlösung.
	if probe.server.PublicKey != "c2VydmVyc2NobHVlc3NlbGRlc3dhcnR1bmdzc2VydmU=" || probe.server.Endpunkt != "wartung.voltpilot.de:51820" ||
		probe.ziel.String() != "10.10.16.7:2222" {
		t.Fatalf("Probe gegen %+v %s", probe.server, probe.ziel)
	}
	if len(p.geschlossen) != 1 {
		t.Fatalf("geschlossen %v", p.geschlossen)
	}
	an := p.abnahmen[0]
	if !strings.Contains(an.Belege["anmeldeprobe"], probe.Fingerabdruck()) || !strings.Contains(an.Belege["fenster_zu"], "Connection timed out") ||
		!strings.Contains(an.Belege["host_schluessel"], "Tunnel-Weg: "+probe.host+" (gleich)") || strings.Contains(an.Belege["anmeldeprobe"], "Handgriff") {
		t.Fatalf("Belege %v", an.Belege)
	}
	// Kein Handgriff: der Lauf hat nie auf die Probe gewartet.
	if strings.Contains(a.log.String(), "wartet_auf=probe") {
		t.Fatal("der Lauf hat auf die Probe gewartet")
	}
}

func TestProbeUeberDenTunnelOhneZeitueberschreitungHaeltAn(t *testing.T) {
	a := neu(t, true)
	a.k.Portal = &falschesPortal{}
	probe := &falscheProbe{m: a.m, nachEnde: "nach dem Ende des Fensters ist die Box über den Tunnel noch erreichbar"}
	a.k.Probe = probe
	a.m.Anmelden = func(code, wg, host string) (string, int) {
		probe.host = host
		return strings.ReplaceAll(antwortEinloesung, "\n", ""), 0
	}
	l, z := a.fahre(t, mango.AbOpenWrt)
	if z != lauf.Angehalten || l.Stand().Schritt != "probe" || !strings.Contains(l.Stand().Grund, "noch erreichbar") {
		t.Fatalf("%s %+v", z, l.Stand())
	}
}
