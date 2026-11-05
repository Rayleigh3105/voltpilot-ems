// Package werkbank spricht mit der Werkbank-Brücke (services/werkstatt-dienst/
// bruecke): Status lesen, Verbindungen zu den Werkstatt-Adressen der Box
// weiterleiten, die Brücke einrichten und pflegen.
//
// Drei Schlüssel, jeder für eine Aufgabe (die Brücke erzwingt das mit
// restrict, command= und permitopen in authorized_keys):
//
//	Status         nur vp-werkbank-status
//	Weiterleitung  nur Verbindungen zu den Zielen am Werkstatt-Anschluss
//	Pflege         nur ein Paket mit genannter Prüfsumme einspielen
//
// Dazu, nur für das erste Einrichten, der Werkstatt-Schlüssel des Benutzers,
// den der Raspberry Pi Imager angelegt hat. Nach dem Einrichten kommt dieser
// Benutzer nicht mehr herein.
//
// Den Host-Schlüssel der Brücke hält der Dienst beim ersten Kontakt fest
// (oder er steht in der Konfiguration); ein anderer Schlüssel danach ist ein
// Fehler, nie ein Grund, neu einzurichten.
package werkbank

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/bruecke"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Benutzer auf der Brücke für die drei Schlüssel des Dienstes.
const Benutzer = "werkstatt"

// Namen der Schlüssel in authorized_keys (pruefen.sh sucht sie).
const (
	NameStatus        = "werkstatt-dienst-status"
	NameWeiterleitung = "werkstatt-dienst-weiterleitung"
	NamePflege        = "werkstatt-dienst-pflege"
)

// StatusSchema ist das Schema der Antwort von vp-werkbank-status.
const StatusSchema = "vp-werkbank-status.v1"

// Konfig ist, was der Client braucht.
type Konfig struct {
	Adresse            string // host:port der Brücke
	HostSchluessel     string // "SHA256:…" oder leer: beim ersten Kontakt festhalten
	HostDatei          string // dort steht der festgehaltene Host-Schlüssel
	Status             ssh.Signer
	Weiterleitung      ssh.Signer
	Pflege             ssh.Signer
	Einrichten         ssh.Signer // darf fehlen: dann richtet der Dienst nicht selbst ein
	EinrichtenBenutzer string
	Notfall            string // öffentlicher Notfall-Schlüssel (authorized_keys-Zeile) oder leer
	Netz               string // Schnittstelle der Brücke ins Netz, "wlan0"
	Werkstatt          string // Werkstatt-Anschluss, "eth0"
	WerkstattAdressen  []netip.Prefix
	Ziele              []netip.AddrPort
	SSHQuellen         []netip.Prefix
	Zeitlimit          time.Duration // für Verbindungsaufbau und Befehle
}

// Status ist die Antwort von vp-werkbank-status.
type Status struct {
	Schema    string `json:"schema"`
	Fehler    string `json:"fehler,omitempty"`
	Fassung   string `json:"fassung"`
	Zeit      string `json:"zeit"`
	Werkstatt struct {
		Schnittstelle string   `json:"schnittstelle"`
		Kabel         bool     `json:"kabel"`
		Adressen      []string `json:"adressen"`
	} `json:"werkstatt"`
	Netz struct {
		Schnittstelle string   `json:"schnittstelle"`
		Oben          bool     `json:"oben"`
		Adressen      []string `json:"adressen"`
		Energiesparen string   `json:"energiesparen"`
	} `json:"netz"`
	Durchleitung struct {
		IPForward bool `json:"ip_forward"`
		Firewall  bool `json:"firewall"`
	} `json:"durchleitung"`
	Antworten []Antwort `json:"antworten"`
	// Strom: Unterspannung des Raspberry Pi (vcgencmd get_throttled). Fehlt bei
	// einer Brücke vor dieser Fassung; Felder nil, wenn sie es nicht lesen kann.
	Strom *Strom `json:"strom,omitempty"`
}

// Strom ist die Versorgung der Brücke. Eine Mango am USB des Pi zieht beim
// Start Strom; ein Pi mit Unterspannung verliert dann WLAN (Lauf 114050-9ef8).
type Strom struct {
	UnterspannungJetzt     *bool  `json:"unterspannung_jetzt,omitempty"`
	UnterspannungSeitStart *bool  `json:"unterspannung_seit_start,omitempty"`
	Quelle                 string `json:"quelle"`
}

// Unterspannung sagt, ob die Brücke jetzt oder seit ihrem Start zu wenig Strom hatte.
func (s Status) Unterspannung() bool {
	if s.Strom == nil {
		return false
	}
	return (s.Strom.UnterspannungJetzt != nil && *s.Strom.UnterspannungJetzt) ||
		(s.Strom.UnterspannungSeitStart != nil && *s.Strom.UnterspannungSeitStart)
}

// Antwort: wer an einer Box-Adresse des Werkstatt-Anschlusses antwortet.
type Antwort struct {
	Adresse string   `json:"adresse"`
	MACs    []string `json:"macs"`
}

// Client spricht mit der Brücke. Er hält je Schlüssel eine Verbindung offen.
type Client struct {
	k   Konfig
	log *slog.Logger

	mu       sync.Mutex
	status   *ssh.Client
	weiter   *ssh.Client
	hostMu   sync.Mutex
	festHost string // Fingerabdruck, sobald bekannt
}

// Neu legt einen Client an.
func Neu(k Konfig, log *slog.Logger) (*Client, error) {
	if k.Adresse == "" {
		return nil, errors.New("keine Adresse der Brücke")
	}
	if _, _, err := net.SplitHostPort(k.Adresse); err != nil {
		k.Adresse = net.JoinHostPort(k.Adresse, "22")
	}
	if k.Status == nil || k.Weiterleitung == nil || k.Pflege == nil {
		return nil, errors.New("die drei Schlüssel des Dienstes (Status, Weiterleitung, Pflege) sind Pflicht")
	}
	if k.Zeitlimit <= 0 {
		k.Zeitlimit = 20 * time.Second
	}
	if k.EinrichtenBenutzer == "" {
		k.EinrichtenBenutzer = "vpwerkstatt"
	}
	if _, err := k.parameter(); err != nil {
		return nil, err
	}
	return &Client{k: k, log: log.With("logger", "werkbank")}, nil
}

func (k Konfig) parameter() (bruecke.Parameter, error) {
	zeilen := []string{
		`restrict,command="sudo -n /usr/local/sbin/vp-werkbank-status" ` + oeffentlich(k.Status) + " " + NameStatus,
		weiterleitungZeile(k.Ziele, k.Weiterleitung),
		`restrict,command="/usr/local/bin/vp-werkbank-pflege" ` + oeffentlich(k.Pflege) + " " + NamePflege,
	}
	if n := strings.TrimSpace(k.Notfall); n != "" {
		pk, kommentar, _, _, err := ssh.ParseAuthorizedKey([]byte(n))
		if err != nil {
			return bruecke.Parameter{}, fmt.Errorf("Notfall-Schlüssel: %w", err)
		}
		if kommentar == "" {
			kommentar = "voltpilot-notfall"
		}
		zeilen = append(zeilen, "no-agent-forwarding,no-X11-forwarding,no-user-rc "+strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pk)))+" "+kommentar)
	}
	p := bruecke.Parameter{
		Netz:              k.Netz,
		Werkstatt:         k.Werkstatt,
		WerkstattAdressen: k.WerkstattAdressen,
		Ziele:             k.Ziele,
		SSHQuellen:        k.SSHQuellen,
		AuthorizedKeys:    zeilen,
	}
	return p, p.Pruefe()
}

func oeffentlich(s ssh.Signer) string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey())))
}

func weiterleitungZeile(ziele []netip.AddrPort, s ssh.Signer) string {
	var b strings.Builder
	b.WriteString(`restrict,port-forwarding,command="/bin/false"`)
	for _, z := range ziele {
		fmt.Fprintf(&b, `,permitopen="%s"`, z)
	}
	return b.String() + " " + oeffentlich(s) + " " + NameWeiterleitung
}

// Paket baut das Paket, das die Brücke tragen soll.
func (c *Client) Paket() (bruecke.Paket, error) {
	p, err := c.k.parameter()
	if err != nil {
		return bruecke.Paket{}, err
	}
	return bruecke.Baue(p)
}

// ---- Host-Schlüssel -------------------------------------------------------

// HostFremd: Die Brücke zeigt einen anderen Host-Schlüssel als festgehalten.
type HostFremd struct{ Erwartet, Bekommen string }

func (h HostFremd) Error() string {
	return fmt.Sprintf("Host-Schlüssel der Brücke ist %s, festgehalten ist %s: nicht verbunden (neu aufgesetzte Brücke? dann die Datei mit dem festgehaltenen Schlüssel löschen, siehe Runbook)", h.Bekommen, h.Erwartet)
}

func (c *Client) hostPruefen(_ string, _ net.Addr, key ssh.PublicKey) error {
	ist := ssh.FingerprintSHA256(key)
	if c.k.HostSchluessel != "" {
		if ist != c.k.HostSchluessel {
			return HostFremd{Erwartet: c.k.HostSchluessel, Bekommen: ist}
		}
		return nil
	}
	c.hostMu.Lock()
	defer c.hostMu.Unlock()
	if c.festHost == "" && c.k.HostDatei != "" {
		if b, err := os.ReadFile(c.k.HostDatei); err == nil {
			if pk, _, _, _, err := ssh.ParseAuthorizedKey(b); err == nil {
				c.festHost = ssh.FingerprintSHA256(pk)
			} else {
				return fmt.Errorf("festgehaltener Host-Schlüssel %s unlesbar: %w", c.k.HostDatei, err)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("festgehaltener Host-Schlüssel: %w", err)
		}
	}
	if c.festHost == "" {
		if c.k.HostDatei != "" {
			if err := os.MkdirAll(filepath.Dir(c.k.HostDatei), 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(c.k.HostDatei, ssh.MarshalAuthorizedKey(key), 0o600); err != nil {
				return fmt.Errorf("Host-Schlüssel festhalten: %w", err)
			}
		}
		c.festHost = ist
		c.log.Info("Host-Schlüssel der Brücke beim ersten Kontakt festgehalten", "fingerabdruck", ist)
		return nil
	}
	if ist != c.festHost {
		return HostFremd{Erwartet: c.festHost, Bekommen: ist}
	}
	return nil
}

// HostSchluessel gibt den festgehaltenen Fingerabdruck zurück (leer, solange
// es keinen Kontakt gab).
func (c *Client) HostSchluessel() string {
	if c.k.HostSchluessel != "" {
		return c.k.HostSchluessel
	}
	c.hostMu.Lock()
	defer c.hostMu.Unlock()
	return c.festHost
}

// ---- Verbindungen ---------------------------------------------------------

func (c *Client) verbinde(ctx context.Context, benutzer string, s ssh.Signer) (*ssh.Client, error) {
	cfg := &ssh.ClientConfig{
		User:            benutzer,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(s)},
		HostKeyCallback: c.hostPruefen,
		Timeout:         c.k.Zeitlimit,
	}
	d := net.Dialer{Timeout: c.k.Zeitlimit}
	conn, err := d.DialContext(ctx, "tcp", c.k.Adresse)
	if err != nil {
		return nil, fmt.Errorf("Brücke %s nicht erreichbar: %w", c.k.Adresse, err)
	}
	frist := time.Now().Add(c.k.Zeitlimit)
	if dl, ok := ctx.Deadline(); ok && dl.Before(frist) {
		frist = dl
	}
	_ = conn.SetDeadline(frist)
	sc, chans, reqs, err := ssh.NewClientConn(conn, c.k.Adresse, cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(sc, chans, reqs), nil
}

// Abgewiesen sagt, ob die Brücke den Schlüssel nicht angenommen hat.
func Abgewiesen(err error) bool {
	return err != nil && strings.Contains(err.Error(), "unable to authenticate")
}

// fuehre führt einen Befehl in einer neuen Sitzung aus.
func fuehre(ctx context.Context, cl *ssh.Client, befehl string, ein io.Reader) (aus, fehl []byte, err error) {
	s, err := cl.NewSession()
	if err != nil {
		return nil, nil, err
	}
	defer s.Close()
	var o, e bytes.Buffer
	s.Stdout, s.Stderr = &o, &e
	if ein != nil {
		s.Stdin = ein
	}
	fertig := make(chan error, 1)
	go func() { fertig <- s.Run(befehl) }()
	select {
	case err = <-fertig:
	case <-ctx.Done():
		_ = s.Close()
		err = ctx.Err()
	}
	return o.Bytes(), e.Bytes(), err
}

func (c *Client) statusClient(ctx context.Context) (*ssh.Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.status != nil {
		if _, _, err := c.status.SendRequest("keepalive@openssh.com", true, nil); err == nil {
			return c.status, nil
		}
		_ = c.status.Close()
		c.status = nil
	}
	cl, err := c.verbinde(ctx, Benutzer, c.k.Status)
	if err != nil {
		return nil, err
	}
	c.status = cl
	return cl, nil
}

// Status liest den Stand der Brücke.
func (c *Client) Status(ctx context.Context) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, c.k.Zeitlimit)
	defer cancel()
	cl, err := c.statusClient(ctx)
	if err != nil {
		return Status{}, err
	}
	aus, fehl, err := fuehre(ctx, cl, "status", nil)
	if err != nil {
		c.mu.Lock()
		if c.status == cl {
			_ = cl.Close()
			c.status = nil
		}
		c.mu.Unlock()
		return Status{}, fmt.Errorf("Status der Brücke: %w (%s)", err, geheim.Schwaerze(strings.TrimSpace(string(fehl))))
	}
	var s Status
	if err := json.Unmarshal(bytes.TrimSpace(aus), &s); err != nil {
		return Status{}, fmt.Errorf("Status der Brücke ist kein JSON: %w", err)
	}
	if s.Schema != StatusSchema {
		return Status{}, fmt.Errorf("Status der Brücke: Schema %q, erwartet %q", s.Schema, StatusSchema)
	}
	if s.Fehler != "" {
		return s, fmt.Errorf("Brücke meldet: %s", s.Fehler)
	}
	return s, nil
}

// Pruefe sagt, ob die Brücke für einen Lauf bereit ist.
func (s Status) Pruefe(fassung string) error {
	var f []string
	if s.Fassung != fassung {
		f = append(f, fmt.Sprintf("Fassung %q statt %q", s.Fassung, fassung))
	}
	if !s.Durchleitung.Firewall {
		f = append(f, "Firewall nicht geladen")
	}
	if !s.Durchleitung.IPForward {
		f = append(f, "Durchleitung aus")
	}
	if !s.Netz.Oben {
		f = append(f, "WLAN unten")
	}
	if len(f) > 0 {
		return errors.New("Brücke nicht bereit: " + strings.Join(f, ", "))
	}
	return nil
}

// Pflegbar sagt, ob ein neues Aufspielen etwas heilen würde (Firewall oder
// Durchleitung fehlen); ein WLAN, das unten ist, heilt es nicht.
func (s Status) Pflegbar() bool { return !s.Durchleitung.Firewall || !s.Durchleitung.IPForward }

// ZielErlaubt sagt, ob die Weiterleitung zu ziel darf.
func (c *Client) ZielErlaubt(ziel netip.AddrPort) bool {
	for _, z := range c.k.Ziele {
		if z == ziel {
			return true
		}
	}
	return false
}

// Dial öffnet durch die Brücke eine Verbindung zu einer Werkstatt-Adresse der
// Box. Andere Ziele lehnt schon der Dienst ab, nicht erst die Brücke.
func (c *Client) Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error) {
	if !c.ZielErlaubt(ziel) {
		return nil, fmt.Errorf("Ziel %s ist keine Werkstatt-Adresse der Box", ziel)
	}
	for versuch := 0; versuch < 2; versuch++ {
		c.mu.Lock()
		cl := c.weiter
		c.mu.Unlock()
		if cl == nil {
			neu, err := c.verbinde(ctx, Benutzer, c.k.Weiterleitung)
			if err != nil {
				return nil, err
			}
			c.mu.Lock()
			if c.weiter == nil {
				c.weiter = neu
			} else {
				_ = neu.Close()
			}
			cl = c.weiter
			c.mu.Unlock()
		}
		conn, err := cl.DialContext(ctx, "tcp", ziel.String())
		if err == nil {
			return conn, nil
		}
		var oe *ssh.OpenChannelError
		if errors.As(err, &oe) {
			// Die Brücke hat geantwortet und abgelehnt (Box antwortet nicht,
			// oder das Ziel ist dort nicht erlaubt): nicht neu verbinden.
			return nil, fmt.Errorf("Brücke leitet nicht weiter zu %s: %s", ziel, oe.Message)
		}
		c.mu.Lock()
		if c.weiter == cl {
			_ = cl.Close()
			c.weiter = nil
		}
		c.mu.Unlock()
		if versuch == 1 {
			return nil, err
		}
	}
	return nil, errors.New("unerreichbar")
}

// Schliesse schließt die offenen Verbindungen.
func (c *Client) Schliesse() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.status != nil {
		_ = c.status.Close()
		c.status = nil
	}
	if c.weiter != nil {
		_ = c.weiter.Close()
		c.weiter = nil
	}
}

// ---- Einrichten und Pflegen -------------------------------------------------

// Ergebnis eines Einrichtens.
type Ergebnis struct {
	Weg     string // "eingerichtet" (erstmals, Imager-Benutzer) oder "gepflegt" (Pflege-Schlüssel)
	Fassung string
	Ausgabe string // Ausgabe von einrichten.sh (geschwärzt)
}

// Bereit bringt die Brücke auf die Fassung, die der Dienst baut, und gibt
// ihren Stand zurück. Weg:
//   - Status geht, Fassung gleich: nichts zu tun
//   - Status geht, Fassung anders: mit dem Pflege-Schlüssel neu aufspielen
//   - Status abgewiesen (Benutzer werkstatt gibt es noch nicht): mit dem
//     Werkstatt-Schlüssel des Imager-Benutzers erstmals einrichten
func (c *Client) Bereit(ctx context.Context) (Status, *Ergebnis, error) {
	p, err := c.Paket()
	if err != nil {
		return Status{}, nil, err
	}
	s, err := c.Status(ctx)
	switch {
	case err == nil && s.Fassung == p.Fassung && !s.Pflegbar():
		return s, nil, s.Pruefe(p.Fassung)
	case err == nil:
		// andere Fassung, oder Firewall bzw. Durchleitung fehlen: neu aufspielen
		erg, perr := c.pflege(ctx, p)
		if perr != nil {
			return s, nil, perr
		}
		s, err = c.Status(ctx)
		if err != nil {
			return s, erg, err
		}
		return s, erg, s.Pruefe(p.Fassung)
	case Abgewiesen(err):
		if c.k.Einrichten == nil {
			return Status{}, nil, fmt.Errorf("Brücke nimmt den Status-Schlüssel nicht an und kein Werkstatt-Schlüssel zum Einrichten ist da: %w", err)
		}
		erg, eerr := c.einrichten(ctx, p)
		if eerr != nil {
			return Status{}, nil, eerr
		}
		s, err = c.Status(ctx)
		if err != nil {
			return s, erg, err
		}
		return s, erg, s.Pruefe(p.Fassung)
	default:
		return Status{}, nil, err
	}
}

func (c *Client) pflege(ctx context.Context, p bruecke.Paket) (*Ergebnis, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cl, err := c.verbinde(ctx, Benutzer, c.k.Pflege)
	if err != nil {
		return nil, fmt.Errorf("Pflege-Schlüssel: %w", err)
	}
	defer cl.Close()
	aus, fehl, err := fuehre(ctx, cl, "einrichten "+p.Sha256, bytes.NewReader(p.Tar))
	text := geheim.Schwaerze(strings.TrimSpace(string(aus) + "\n" + string(fehl)))
	if err != nil {
		return nil, fmt.Errorf("Brücke pflegen: %w: %s", err, letzteZeilen(text, 8))
	}
	c.log.Info("Brücke gepflegt", "fassung", p.Fassung)
	return &Ergebnis{Weg: "gepflegt", Fassung: p.Fassung, Ausgabe: text}, nil
}

func (c *Client) einrichten(ctx context.Context, p bruecke.Paket) (*Ergebnis, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	cl, err := c.verbinde(ctx, c.k.EinrichtenBenutzer, c.k.Einrichten)
	if err != nil {
		return nil, fmt.Errorf("Brücke erstmals einrichten (Benutzer %s): %w", c.k.EinrichtenBenutzer, err)
	}
	defer cl.Close()
	datei := "/tmp/vp-werkbank-" + p.Sha256[:16] + ".tar"
	if _, fehl, err := fuehre(ctx, cl, "umask 077 && cat > "+datei, bytes.NewReader(p.Tar)); err != nil {
		return nil, fmt.Errorf("Paket übertragen: %w (%s)", err, strings.TrimSpace(string(fehl)))
	}
	aus, _, err := fuehre(ctx, cl, "sha256sum "+datei, nil)
	if err != nil || !strings.HasPrefix(string(aus), p.Sha256+" ") {
		return nil, fmt.Errorf("Paket auf der Brücke hat nicht die Prüfsumme %s: %q", p.Sha256, strings.TrimSpace(string(aus)))
	}
	befehl := "sudo -n /bin/sh -c 'd=$(mktemp -d) && tar -x -f " + datei + " -C \"$d\" --no-same-owner && sh \"$d/einrichten.sh\"; r=$?; rm -rf \"$d\" " + datei + "; exit $r'"
	aus, fehl, err := fuehre(ctx, cl, befehl, nil)
	text := geheim.Schwaerze(strings.TrimSpace(string(aus) + "\n" + string(fehl)))
	if err != nil {
		return nil, fmt.Errorf("einrichten.sh auf der Brücke: %w: %s", err, letzteZeilen(text, 8))
	}
	c.log.Info("Brücke erstmals eingerichtet", "fassung", p.Fassung)
	return &Ergebnis{Weg: "eingerichtet", Fassung: p.Fassung, Ausgabe: text}, nil
}

func letzteZeilen(s string, n int) string {
	z := strings.Split(strings.TrimSpace(s), "\n")
	if len(z) > n {
		z = z[len(z)-n:]
	}
	return strings.Join(z, " | ")
}
