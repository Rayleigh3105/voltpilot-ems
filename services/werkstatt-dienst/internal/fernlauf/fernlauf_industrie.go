package fernlauf

// Der Fernlauf für eine Edge-Industrie-Box (WAGO PFC200): derselbe Ablauf und
// dieselben Schritte wie für Edge Light, mit dem, was das Gerät anders macht.
//
//   - Welches Gerät es ist, sagt die Linie der Fassung des Auftrags
//     (edge-industrie-JJJJ.MM.N). Meldet die Box eine Fassung einer anderen
//     Linie, endet der Lauf im Schritt bestand, ohne etwas zu ändern.
//   - Sichern, Neustart und Rücknahme macht das Skript fernlauf.sh aus dem
//     Skriptstand der Fassung (edge-industrie/fernlauf.sh, im Container
//     geprüft von edge-industrie/test/fernlauf-probe.sh). Er ist signiert:
//     Der Schritt fassungen prüft ihn, bevor irgendein Skript läuft.
//   - Neu startet nur der Dienst /etc/init.d/vp-edge-industrie. Nie das Gerät,
//     nie die SPS-Laufzeit: Auf dem PFC200 läuft daneben die Steuerung.
//   - Das Tunnel-Programm vp-wartung bleibt, wie es ist. Durch es läuft der
//     Fernlauf; ein neues kommt nur an der Werkbank auf das Gerät.
//   - Kein OpenWrt, kein Funkmodul: Land und relayd gibt es hier nicht.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// IndustriePraefix ist die Release-Linie von Edge Industrie.
const IndustriePraefix = "edge-industrie-"

// IstIndustrie: Die Fassung gehört zur Linie Edge Industrie (WAGO PFC200).
func IstIndustrie(fassung string) bool { return strings.HasPrefix(fassung, IndustriePraefix) }

// FernlaufSkript heißt das Skript im Skriptstand einer Edge-Industrie-Fassung.
const FernlaufSkript = "fernlauf.sh"

// industrieBauart ist die Bauart des Programms für den PFC200 (ARMv7).
const industrieBauart = "arm"

// Pfade auf dem PFC200 (edge-industrie/install.sh und wartung.sh legen sie an).
const (
	industrieDaten  = "/home/voltpilot/daten"
	industrieTunnel = "/home/voltpilot/wartung/vp-wartung"
)

// GesichertIndustrie ist, was fernlauf.sh sichert: genau das, was install.sh
// schreibt (dazu der Link /etc/rc.d/*vp-edge-industrie). Die Liste steht auch
// im Skript; hier prüft der Dienst die Sicherung dagegen.
var GesichertIndustrie = []string{
	"home/voltpilot/libexec/boot.sh",
	"etc/init.d/vp-edge-industrie",
	"home/voltpilot/konfig",
	"home/voltpilot/daten/ota",
	"home/voltpilot/fassung",
}

// nieIndustrie: Kein Eintrag der Sicherung darf hier beginnen - Identität und
// Referenz der Box, der Wartungstunnel, Zugänge und Schlüssel des Geräts.
var nieIndustrie = []string{"home/voltpilot/daten/identity", "home/voltpilot/daten/ref", "home/voltpilot/wartung", "etc/init.d/vp-wartung",
	"etc/dropbear", "etc/shadow", "etc/passwd", "root"}

func (l *laufZustand) schritteIndustrie() []schritt {
	z := l.k.Zeiten
	return []schritt{
		{"anmelden", z.Anmelden + time.Minute, l.anmelden},
		{"bestand", 2 * time.Minute, l.bestandIndustrie},
		{"fassungen", 10 * time.Minute, l.fassungenIndustrie},
		{"sichern", 8 * time.Minute, l.sichernIndustrie},
		{"aufspielen", 10 * time.Minute, l.aufspielenIndustrie},
		{"neustart", z.Programm + time.Minute, l.neustartIndustrie},
		{"meldet_sich", z.MeldetSich + time.Minute, l.meldetSich},
		{"tunnel", 3 * time.Minute, l.tunnelIndustrie},
	}
}

// ---- bestand -----------------------------------------------------------------

// Liest nur. Von der Identität der Box verlässt nichts das Gerät als die
// Referenz und die Auskunft, ob ein Zertifikat da ist.
const befehlBestandIndustrie = `echo "ref=$(cat ` + industrieDaten + `/ref 2>/dev/null)"
echo "zertifikat=$([ -s ` + industrieDaten + `/identity/device.crt ] && echo ja || echo nein)"
echo "current=$(tr -d '\n' < ` + industrieDaten + `/ota/current.json 2>/dev/null)"
echo "flash_frei_kb=$(df -k /home/voltpilot 2>/dev/null | awk 'NR==2 {print $4}')"
echo "ram_frei_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null)"`

func (l *laufZustand) bestandIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	w, _, err := l.v.Werte(ctx, befehlBestandIndustrie)
	if err != nil {
		return nil, "", err
	}
	b := protokoll.Beleg{}.Mit("referenz", w["ref"]).Mit("zertifikat", w["zertifikat"]).Mit("current", w["current"]).
		Mit("flash_frei_kb", w["flash_frei_kb"]).Mit("ram_frei_kb", w["ram_frei_kb"])
	if w["ref"] != l.a.EdgeRef {
		return b, "", fmt.Errorf("die Box nennt die Referenz %q, der Auftrag %s", w["ref"], l.a.EdgeRef)
	}
	if w["zertifikat"] == "ja" {
		return b, "", ErrInzwischenVerbunden
	}
	erg, err := l.v.Fuehre(ctx, mango.BefehlHealth, nil)
	if err != nil {
		return b, "", err
	}
	h, ok := mango.LiesHealth(erg.Aus)
	if !ok || h.Version == "" {
		return b, "", errors.New("/health der Box nennt keine Fassung (läuft das Programm?)")
	}
	l.vorher = h.Version
	b = b.Mit("health", "ref "+h.Ref+", version "+h.Version)
	// Die Linie entscheidet, was auf dem Gerät läuft: Nie Edge Industrie auf
	// eine Box, die etwas anderes meldet.
	if !IstIndustrie(h.Version) {
		return b, "", fmt.Errorf("die Box läuft %s, der Auftrag bringt Edge Industrie (%s): andere Linie", h.Version, l.a.Ziel.Fassung)
	}
	var cur struct {
		Release    string `json:"release"`
		ReleaseSeq *int64 `json:"release_seq"`
	}
	if w["current"] != "" && json.Unmarshal([]byte(w["current"]), &cur) == nil && cur.ReleaseSeq != nil {
		l.seq = cur.ReleaseSeq
	}
	if h.Version == l.a.Ziel.Fassung {
		return b, "", fmt.Errorf("die Box läuft schon %s", h.Version)
	}
	if l.seq != nil && *l.seq >= l.a.Ziel.ReleaseSeq {
		return b, "", fmt.Errorf("die Box hat Stand %d, die Fassung %s nur %d: nur aufwärts", *l.seq, l.a.Ziel.Fassung, l.a.Ziel.ReleaseSeq)
	}
	if m, err := l.k.Portal.FernlaufMeldungLesen(ctx, l.id); err == nil {
		l.csrZuletzt = m.CsrUpdatedAt
	}
	stand := "unbekannt (keine current.json)"
	if l.seq != nil {
		stand = strconv.FormatInt(*l.seq, 10)
	}
	return b, fmt.Sprintf("Läuft %s, Stand %s, kein Zertifikat, Flash frei %s kB", h.Version, stand, w["flash_frei_kb"]), nil
}

// ---- fassungen ---------------------------------------------------------------

func (l *laufZustand) fassungenIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	z := l.a.Ziel
	f := freigabe.Freigabe{BoxArt: freigabe.PFC200, EdgeIndustrie: freigabe.Industrie{Fassung: z.Fassung, Quelle: z.Quelle,
		ProgrammSha256: z.ProgrammSha256, SkripteSha256: z.SkripteSha256}}
	// Das Tunnel-Programm lädt der Fernlauf nicht: Er fasst den Tunnel nicht an.
	programm, skripte, _ := fassungen.DateienPFC200(f)
	b := protokoll.Beleg{}.Mit("fassung", z.Fassung)
	for _, d := range []fassungen.Datei{programm, skripte} {
		erg, err := l.k.Fassungen.Hole(ctx, d)
		if err != nil {
			return b, "", err
		}
		b = b.Mit(d.Name, fmt.Sprintf("sha256 %s, %d Bytes", d.Sha256, erg.Groesse))
		if d.Name == programm.Name {
			l.pfadProgramm = erg.Pfad
		} else {
			l.pfadSkripte = erg.Pfad
		}
	}
	m, msig, err := l.k.Fassungen.HoleManifest(ctx, z.Quelle, z.Fassung)
	if err != nil {
		return b, "", fmt.Errorf("signiertes Manifest der Fassung: %w", err)
	}
	set, setSig, err := l.k.Fassungen.HoleVertrauensSet(ctx, l.k.PortalURL)
	if err != nil {
		return b, "", fmt.Errorf("Vertrauens-Set: %w", err)
	}
	// Dieselbe Prüfung wie für Edge Light und wie im Werkstatt-Schritt
	// fassungen: eingebackene Wurzel, root-signiertes Vertrauens-Set,
	// Release-Schlüssel, Manifest - auf den rohen Bytes, vor jedem Parsen.
	signiertVon, err := l.k.Fassungen.PruefeSignatur(set, setSig, m, msig)
	b = b.Mit("signatur", orKein(signiertVon))
	if err != nil {
		return b, "", fmt.Errorf("Fassung nicht echt: %w", err)
	}
	var vm struct {
		Release    string `json:"release"`
		ReleaseSeq int64  `json:"release_seq"`
		MinFromSeq int64  `json:"min_from_seq"`
		Skripte    *struct {
			SHA256 string `json:"sha256"`
		} `json:"skripte"`
	}
	if err := json.Unmarshal(m, &vm); err != nil {
		return b, "", fmt.Errorf("release.json: %v", err)
	}
	switch {
	case vm.Release != z.Fassung || vm.ReleaseSeq != z.ReleaseSeq:
		return b, "", fmt.Errorf("das signierte Manifest nennt %s Stand %d, der Auftrag %s Stand %d", vm.Release, vm.ReleaseSeq, z.Fassung, z.ReleaseSeq)
	case vm.Skripte == nil || vm.Skripte.SHA256 != z.SkripteSha256:
		return b, "", errors.New("das signierte Manifest trägt nicht den Skriptstand des Auftrags")
	case l.seq != nil && *l.seq >= vm.ReleaseSeq:
		return b, "", fmt.Errorf("die Box hat Stand %d, die Fassung %d: nur aufwärts", *l.seq, vm.ReleaseSeq)
	case l.seq != nil && *l.seq < vm.MinFromSeq:
		return b, "", fmt.Errorf("die Fassung setzt mindestens Stand %d voraus, die Box hat %d", vm.MinFromSeq, *l.seq)
	}
	st, err := fassungen.PruefeManifestFuer(m, msig, z.Fassung, industrieBauart, z.ProgrammSha256, fassungen.BackendsPFC200...)
	if err != nil {
		return b, "", err
	}
	l.stand = st
	dir, err := l.arbeitsDir()
	if err != nil {
		return b, "", err
	}
	l.pfadManifest = filepath.Join(dir, fassungen.ManifestDatei)
	l.dirVertrauen = filepath.Join(dir, "trust-set")
	if err := os.MkdirAll(l.dirVertrauen, 0o755); err != nil {
		return b, "", err
	}
	for p, inhalt := range map[string][]byte{l.pfadManifest: m, filepath.Join(l.dirVertrauen, "trust-set.json"): set, filepath.Join(l.dirVertrauen, "trust-set.json.sig"): setSig} {
		if err := os.WriteFile(p, inhalt, 0o644); err != nil {
			return b, "", err
		}
	}
	// Der geprüfte Skriptstand muss den Fernlauf mitbringen: Eine Fassung vor
	// fernlauf.sh kann der Dienst nicht sichern und nicht zurücknehmen, also
	// spielt er sie auch nicht auf.
	_, wurzel, err := l.skripteIndustrie()
	if err != nil {
		return b, "", err
	}
	if _, err := os.Stat(filepath.Join(wurzel, FernlaufSkript)); err != nil {
		return b.Mit("fernlauf_skript", "fehlt"), "", fmt.Errorf("der Skriptstand der Fassung %s bringt %s nicht mit: Ein Fernlauf geht erst mit einer Fassung, die damit gebaut ist", z.Fassung, FernlaufSkript)
	}
	return b, fmt.Sprintf("%s Stand %d, signiert von %s, Kette gegen die eingebackene Wurzel geprüft; Programm und Skriptstand nach sha256", z.Fassung, vm.ReleaseSeq, signiertVon), nil
}

// ---- Skripte des Skriptstands -------------------------------------------------

// skripteIndustrie packt den geprüften Skriptstand aus, legt das geprüfte
// Programm daneben (dort sucht install.sh es) und startet die Durchreiche.
func (l *laufZustand) skripteIndustrie() (*durchreiche.Server, string, error) {
	dir, err := l.arbeitsDir()
	if err != nil {
		return nil, "", err
	}
	basis := filepath.Join(dir, "s")
	wurzel := filepath.Join(basis, fassungen.IndustrieWurzel)
	if l.dr == nil {
		if err := fassungen.AuspackenPFC200(l.pfadSkripte, basis); err != nil {
			return nil, "", err
		}
		if err := os.MkdirAll(filepath.Join(wurzel, "dist"), 0o755); err != nil {
			return nil, "", err
		}
		inhalt, err := os.ReadFile(l.pfadProgramm)
		if err != nil {
			return nil, "", err
		}
		if err := os.WriteFile(filepath.Join(wurzel, "dist", fassungen.IndustrieProgramm), inhalt, 0o755); err != nil {
			return nil, "", err
		}
		dr, err := durchreiche.Starte(filepath.Join(dir, "d"), l.klient.Load, l.log)
		if err != nil {
			return nil, "", err
		}
		l.dr = dr
	}
	return l.dr, wurzel, nil
}

func (l *laufZustand) skriptIndustrie(ctx context.Context, name string, args []string, env ...string) (durchreiche.Lauf, error) {
	dr, dir, err := l.skripteIndustrie()
	if err != nil {
		return durchreiche.Lauf{}, err
	}
	env = append([]string{"VP_INDUSTRIE_ARCH=" + industrieBauart}, env...)
	return dr.FuehreSkript(ctx, filepath.Join(dir, name), append([]string{"root@" + l.ziel.Addr().String()}, args...), env)
}

// ---- Tunnel ------------------------------------------------------------------

// tunnelLueckenIndustrie liest den Stand des Tunnel-Programms (vp-wartung
// status werte) und nennt, was fehlt. Nur gelesen: Der Fernlauf ändert am
// Tunnel nichts.
func (l *laufZustand) tunnelLueckenIndustrie(ctx context.Context) ([]string, protokoll.Beleg, error) {
	w, _, err := l.v.Werte(ctx, industrieTunnel+" status werte 2>&1")
	if err != nil {
		return nil, nil, err
	}
	b := protokoll.Beleg{}.Mit("laeuft", w["laeuft"]).Mit("adresse", w["adresse"]).Mit("handshake", "vor "+w["handshake_vor"]+" s").
		Mit("ssh_2222", w["ssh_2222"]).Mit("abholer", "letzte gültige Antwort des Wartungsservers vor "+w["antwort_vor"]+" s")
	var f []string
	if w["laeuft"] != "ja" {
		f = append(f, "das Tunnel-Programm läuft nicht")
	}
	if hs, err := strconv.Atoi(w["handshake_vor"]); err != nil || hs < 0 || hs > 180 {
		f = append(f, "kein frischer Handshake")
	}
	if w["ssh_2222"] != "nur_im_tunnel" {
		f = append(f, "SSH 2222 nicht nur im Tunnel")
	}
	if an, err := strconv.Atoi(w["antwort_vor"]); err != nil || an < 0 {
		f = append(f, "keine gültige Antwort des Wartungsservers")
	}
	return f, b, nil
}

func (l *laufZustand) tunnelIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	luecken, b, err := l.tunnelLueckenIndustrie(ctx)
	if err != nil {
		return nil, "", err
	}
	var neu []string
	for _, f := range luecken {
		if !l.tunnelVorher[f] {
			neu = append(neu, f)
		}
	}
	if len(neu) > 0 {
		return b, "", fmt.Errorf("am Tunnel fehlt jetzt, was vorher da war: %s", strings.Join(neu, ", "))
	}
	hs, _ := b.Wert("handshake")
	return b, "Tunnel wie vorher: Handshake " + orKein(hs), nil
}

// ---- sichern -----------------------------------------------------------------

func (l *laufZustand) sichernIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	if rest := time.Until(l.a.FensterEnde); rest < l.k.Zeiten.Reserve {
		return nil, "", fmt.Errorf("im Fenster bleiben nur %s, für Aufspielen und Rücknahme braucht es %s", rest.Round(time.Second), l.k.Zeiten.Reserve)
	}
	// Wie der Tunnel jetzt steht: Danach darf nichts fehlen, was jetzt da ist.
	luecken, _, err := l.tunnelLueckenIndustrie(ctx)
	if err != nil {
		return nil, "", err
	}
	l.tunnelVorher = map[string]bool{}
	for _, f := range luecken {
		l.tunnelVorher[f] = true
	}
	dir, err := l.arbeitsDir()
	if err != nil {
		return nil, "", err
	}
	datei := filepath.Join(dir, "sicherung.tar.gz")
	r, err := l.skriptIndustrie(ctx, FernlaufSkript, []string{"sichern", datei})
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung: %w", err)
	}
	if r.Code != 0 {
		return nil, "", fmt.Errorf("Sicherung: %s endete mit %d: %s", FernlaufSkript, r.Code, letzteZeilen(r.Ausgabe, 3))
	}
	daten, err := os.ReadFile(datei)
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung: %w", err)
	}
	eintraege, err := tarEintraege(daten)
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung unlesbar: %w", err)
	}
	// Der Dienst glaubt dem Skript nicht blind: nichts von der Identität, vom
	// Tunnel oder von den Zugängen, und nichts außerhalb dessen, was install.sh schreibt.
	for e := range eintraege {
		for _, n := range nieIndustrie {
			if e == n || strings.HasPrefix(e, n+"/") {
				_ = os.Remove(datei)
				return nil, "", fmt.Errorf("die Sicherung enthielte %s: abgebrochen", e)
			}
		}
		if !gesichertIndustrie(e) {
			_ = os.Remove(datei)
			return nil, "", fmt.Errorf("die Sicherung enthielte %s, das nicht zu Edge Industrie gehört: abgebrochen", e)
		}
	}
	for _, p := range []string{"home/voltpilot/libexec/boot.sh", "etc/init.d/vp-edge-industrie", "home/voltpilot/konfig", "home/voltpilot/fassung"} {
		if !eintraege[p] {
			_ = os.Remove(datei)
			return nil, "", fmt.Errorf("die Sicherung enthält %s nicht", p)
		}
	}
	if err := os.Chmod(datei, 0o600); err != nil {
		return nil, "", err
	}
	l.sicherung, l.inSicherung = datei, eintraege
	summe := fmt.Sprintf("%x", sha256Summe(daten))
	b := protokoll.Beleg{}.Mit("sicherung", fmt.Sprintf("sha256 %s, %d Bytes, %d Einträge", summe, len(daten), len(eintraege))).
		Mit("pfade", strings.Join(sortiert(eintraege), " ")).Mit("tunnel_vorher", strings.Join(sortiert(l.tunnelVorher), ", "))
	l.belege["sicherung_sha256"] = summe
	return b, fmt.Sprintf("Gesichert: %d Einträge, %d Bytes, sha256 %s (ohne Identität, Referenz und Tunnel)", len(eintraege), len(daten), kurz(summe, 16)), nil
}

// gesichertIndustrie: Der Eintrag gehört zu dem, was fernlauf.sh sichern darf.
func gesichertIndustrie(e string) bool {
	for _, p := range GesichertIndustrie {
		if e == p || strings.HasPrefix(e, p+"/") {
			return true
		}
	}
	// Der Link für den Start beim Hochfahren (sein Name ist einstellbar).
	return strings.HasPrefix(e, "etc/rc.d/") && strings.HasSuffix(e, "vp-edge-industrie") && !strings.Contains(e[len("etc/rc.d/"):], "/")
}

// ---- aufspielen --------------------------------------------------------------

func (l *laufZustand) aufspielenIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	// Ab hier nimmt jeder Fehler die Sicherung zurück.
	l.aufgespielt = true
	env := []string{"VP_INDUSTRIE_MANIFEST=" + l.pfadManifest, "VP_TRUST_SET_DIR=" + l.dirVertrauen}
	if l.k.PortalURL != "" {
		env = append(env, "VP_PORTAL_URL="+l.k.PortalURL)
	}
	r, err := l.skriptIndustrie(ctx, "install.sh", nil, env...)
	if err != nil {
		return nil, "", err
	}
	b := protokoll.Beleg{}.Mit("install", zeilenMit(r.Ausgabe, "Fassung", "Pruefsumme", "FEHLER", "fehlt:", "fertig"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "Pruefsumme auf dem Geraet bestaetigt") {
		return b, "", fmt.Errorf("install.sh endete mit %d: %s", r.Code, letzteZeilen(r.Ausgabe, 4))
	}
	// install.sh fasst weder Firewall noch Tunnel an; die Sitzung sollte stehen.
	// Steht sie nicht, einmal neu anmelden.
	if _, err := l.v.Fuehre(ctx, "true", nil); err != nil {
		l.v.Schliesse()
		l.setzeVerbindung(nil)
		if err := l.verbinde(ctx, wartung.Server{}, nil); err != nil {
			return b, "", fmt.Errorf("nach install.sh: %w", err)
		}
		b = b.Mit("sitzung", "nach install.sh neu angemeldet")
	} else {
		b = b.Mit("sitzung", "Sitzung im Tunnel blieb über install.sh hinweg stehen")
	}
	return b, "install.sh: Prüfsumme auf dem Gerät bestätigt; SPS, Firewall und Tunnel nicht angefasst", nil
}

// ---- neustart ----------------------------------------------------------------

func (l *laufZustand) neustartIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	if m, err := l.k.Portal.FernlaufMeldungLesen(ctx, l.id); err == nil && m.CsrUpdatedAt.After(l.csrZuletzt) {
		l.csrZuletzt = m.CsrUpdatedAt
	}
	// Nur der Dienst vp-edge-industrie: Gerät und SPS-Laufzeit laufen weiter.
	r, err := l.skriptIndustrie(ctx, FernlaufSkript, []string{"neustart"})
	if err != nil || r.Code != 0 {
		return nil, "", fmt.Errorf("Neustart des Dienstes: %v %s", err, letzteZeilen(r.Ausgabe, 2))
	}
	h, err := l.warteHealth(ctx, l.a.Ziel.Fassung)
	b := protokoll.Beleg{}.Mit("neustart", "nur der Dienst vp-edge-industrie; Gerät und SPS-Laufzeit laufen weiter").Mit("health", "ref "+h.Ref+", version "+h.Version)
	if err != nil {
		return b, "", err
	}
	if g := mango.UpdateBereitFuer(h, &l.stand, fassungen.BackendsPFC200...); g != "" {
		return b.Mit("update_bereit", "nein - "+g), "", fmt.Errorf("nicht update-bereit: %s", g)
	}
	return b.Mit("update_bereit", "ja"), fmt.Sprintf("Nur der Dienst neu gestartet; /health: %s, Referenz %s, update-bereit (Stand %d)", h.Version, h.Ref, l.stand.ReleaseSeq), nil
}

// ---- zurueck -----------------------------------------------------------------

// zurueckIndustrie spielt die Sicherung mit fernlauf.sh ein (Dienst anhalten,
// Verzeichnisse als Ganzes tauschen, Dateien ersetzen, Dienst starten); dann
// muss /health die alte Fassung nennen und die Plattform sie wieder hören.
// Auch hier startet nur der Dienst neu.
func (l *laufZustand) zurueckIndustrie(ctx context.Context) (protokoll.Beleg, string, error) {
	if l.sicherung == "" {
		return nil, "", errors.New("keine Sicherung")
	}
	if l.v == nil {
		if err := l.verbinde(ctx, wartung.Server{}, nil); err != nil {
			return nil, "", err
		}
	} else if _, err := l.v.Fuehre(ctx, "true", nil); err != nil {
		l.v.Schliesse()
		l.setzeVerbindung(nil)
		if err := l.verbinde(ctx, wartung.Server{}, nil); err != nil {
			return nil, "", err
		}
	}
	if m, err := l.k.Portal.FernlaufMeldungLesen(ctx, l.id); err == nil && m.CsrUpdatedAt.After(l.csrZuletzt) {
		l.csrZuletzt = m.CsrUpdatedAt
	}
	r, err := l.skriptIndustrie(ctx, FernlaufSkript, []string{"zurueck", l.sicherung})
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung einspielen: %w", err)
	}
	b := protokoll.Beleg{}.Mit("eingespielt", zeilenMit(r.Ausgabe, "zurueck:", "FEHLER"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "zurueck: ") {
		return b, "", fmt.Errorf("Sicherung einspielen: %s endete mit %d: %s", FernlaufSkript, r.Code, letzteZeilen(r.Ausgabe, 3))
	}
	h, err := l.warteHealth(ctx, l.vorher)
	b = b.Mit("health", "ref "+h.Ref+", version "+h.Version)
	if err != nil {
		return b, "", err
	}
	m, err := l.warteMeldung(ctx, l.vorher)
	b = b.Mit("device_info", m.DeviceInfo)
	if err != nil {
		return b, "", err
	}
	return b, "Zurück auf " + l.vorher + ": /health nennt sie, die Plattform hört sie wieder; nur der Dienst neu gestartet", nil
}
