// Package durchreiche lässt die Skripte des Release-Stands (install.sh,
// service-tunnel.sh) über die SSH-Verbindung des Laufs mit der Box sprechen.
//
// Die Skripte rufen nur "ssh [-i datei] <ziel> <befehl>" auf, mit Daten auf
// der Standardeingabe. Der Dienst legt für einen Lauf ein Verzeichnis an, in
// dem "ssh" auf sein eigenes Programm zeigt; so aufgerufen (Shim) verbindet
// es sich mit einer Unix-Socket des Dienstes, und der Dienst führt den Befehl
// in einer neuen Sitzung auf der Box aus: Standardeingabe hin, Ausgabe,
// Fehlerausgabe und Ausgang zurück. Das Ziel im Aufruf zählt nicht: die Socket
// gehört genau einer Box. Eine Shell ohne Befehl gibt es nicht.
//
// Rahmen auf der Socket: ein Byte Art, vier Byte Länge, Daten.
//
//	Kopf  'k'  der Befehl
//	Ein   'i'  Standardeingabe; leer = Ende der Eingabe
//	Aus   'o'  Standardausgabe
//	Fehl  'f'  Fehlerausgabe
//	Ende  'x'  Ausgang (vier Byte)
package durchreiche

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Umgebungsvariable, unter der der Shim die Socket findet.
const Variable = "VP_WERKSTATT_DURCHREICHE"

const (
	artKopf = 'k'
	artEin  = 'i'
	artAus  = 'o'
	artFehl = 'f'
	artEnde = 'x'
)

const maxRahmen = 1 << 20

func schreibe(w io.Writer, art byte, daten []byte) error {
	kopf := [5]byte{art}
	binary.BigEndian.PutUint32(kopf[1:], uint32(len(daten)))
	if _, err := w.Write(kopf[:]); err != nil {
		return err
	}
	_, err := w.Write(daten)
	return err
}

func lies(r io.Reader) (byte, []byte, error) {
	var kopf [5]byte
	if _, err := io.ReadFull(r, kopf[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(kopf[1:])
	if n > maxRahmen {
		return 0, nil, fmt.Errorf("Rahmen zu groß (%d)", n)
	}
	d := make([]byte, n)
	_, err := io.ReadFull(r, d)
	return kopf[0], d, err
}

// rahmenSchreiber schreibt alles als Rahmen einer Art (threadsicher über mu).
type rahmenSchreiber struct {
	mu  *sync.Mutex
	w   io.Writer
	art byte
}

func (r rahmenSchreiber) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for off := 0; off < len(p); off += maxRahmen {
		ende := min(off+maxRahmen, len(p))
		if err := schreibe(r.w, r.art, p[off:ende]); err != nil {
			return off, err
		}
	}
	return len(p), nil
}

// ---- Dienst-Seite -----------------------------------------------------------

// Server nimmt die Aufrufe des Shims an und führt sie auf der Box aus.
type Server struct {
	Dir    string // Arbeitsverzeichnis des Laufs (bin/ssh, box.sock)
	box    func() *ssh.Client
	log    *slog.Logger
	ln     net.Listener
	befehl []string
	mu     sync.Mutex
}

// Starte legt in dir das Verzeichnis bin mit dem Shim an und lauscht auf
// dir/box.sock. box liefert die aktuelle Verbindung zur Box.
func Starte(dir string, box func() *ssh.Client, log *slog.Logger) (*Server, error) {
	if err := os.MkdirAll(filepath.Join(dir, "bin"), 0o700); err != nil {
		return nil, err
	}
	selbst, err := os.Executable()
	if err != nil {
		return nil, err
	}
	shim := filepath.Join(dir, "bin", "ssh")
	_ = os.Remove(shim)
	if err := os.Symlink(selbst, shim); err != nil {
		return nil, fmt.Errorf("Shim anlegen: %w", err)
	}
	sock := filepath.Join(dir, "box.sock")
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(sock, 0o600)
	s := &Server{Dir: dir, box: box, log: log, ln: ln}
	go s.annehmen()
	return s, nil
}

// Socket ist der Pfad der Socket.
func (s *Server) Socket() string { return filepath.Join(s.Dir, "box.sock") }

// Befehle gibt die Befehle zurück, die durchgereicht wurden.
func (s *Server) Befehle() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.befehl...)
}

// Schliesse beendet den Server.
func (s *Server) Schliesse() { _ = s.ln.Close() }

func (s *Server) annehmen() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.bediene(c)
	}
}

func (s *Server) bediene(c net.Conn) {
	defer c.Close()
	var mu sync.Mutex
	ende := func(code int) {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], uint32(int32(code)))
		mu.Lock()
		_ = schreibe(c, artEnde, b[:])
		mu.Unlock()
	}
	fehl := rahmenSchreiber{mu: &mu, w: c, art: artFehl}
	r := bufio.NewReader(c)
	art, befehl, err := lies(r)
	if err != nil || art != artKopf || len(befehl) == 0 {
		fmt.Fprintln(fehl, "durchreiche: kein Befehl")
		ende(255)
		return
	}
	s.mu.Lock()
	s.befehl = append(s.befehl, geheim.Schwaerze(string(befehl)))
	s.mu.Unlock()
	cl := s.box()
	if cl == nil {
		fmt.Fprintln(fehl, "durchreiche: keine Verbindung zur Box")
		ende(255)
		return
	}
	sitzung, err := cl.NewSession()
	if err != nil {
		fmt.Fprintf(fehl, "durchreiche: %v\n", err)
		ende(255)
		return
	}
	defer sitzung.Close()
	sitzung.Stdout = rahmenSchreiber{mu: &mu, w: c, art: artAus}
	sitzung.Stderr = fehl
	ein, err := sitzung.StdinPipe()
	if err != nil {
		ende(255)
		return
	}
	go func() {
		defer ein.Close()
		for {
			a, d, err := lies(r)
			if err != nil || a != artEin || len(d) == 0 {
				return
			}
			if _, err := ein.Write(d); err != nil {
				return
			}
		}
	}()
	err = sitzung.Run(string(befehl))
	code := 0
	var ee *ssh.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		code = ee.ExitStatus()
	default:
		// wie ssh: 255, wenn die Verbindung selbst scheitert
		fmt.Fprintf(fehl, "durchreiche: %v\n", err)
		code = 255
	}
	ende(code)
}

// ---- Shim-Seite (das Programm, als "ssh" aufgerufen) -------------------------------

// Optionen von ssh, die ein Argument haben.
const mitArgument = "bcDEeFIiJLlmOoPpQRSWw"

// Zerlege liest die Argumente wie ssh: Optionen, dann das Ziel, dann den
// Befehl (die restlichen Argumente mit Leerzeichen verbunden, wie bei ssh).
func Zerlege(args []string) (ziel, befehl string, steuerung bool, err error) {
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			i++
			break
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			break
		}
		for j := 1; j < len(a); j++ {
			o := a[j]
			if o == 'O' {
				steuerung = true
			}
			if strings.IndexByte(mitArgument, o) >= 0 {
				if j+1 == len(a) {
					i++
					if i >= len(args) {
						return "", "", false, fmt.Errorf("ssh: -%c braucht ein Argument", o)
					}
				}
				break
			}
		}
	}
	if i >= len(args) {
		return "", "", steuerung, errors.New("ssh: kein Ziel")
	}
	ziel = args[i]
	befehl = strings.Join(args[i+1:], " ")
	return ziel, befehl, steuerung, nil
}

// Shim ist das Programm, wenn es als "ssh" aufgerufen wird. Ausgang wie ssh.
func Shim(args []string, ein io.Reader, aus, fehl io.Writer) int {
	_, befehl, steuerung, err := Zerlege(args)
	if steuerung {
		return 0 // ssh -O …: keine gehaltene Verbindung zu steuern
	}
	if err != nil {
		fmt.Fprintln(fehl, err)
		return 255
	}
	if strings.TrimSpace(befehl) == "" {
		fmt.Fprintln(fehl, "ssh (Durchreiche des Werkstatt-Dienstes): ohne Befehl keine Shell")
		return 255
	}
	sock := os.Getenv(Variable)
	if sock == "" {
		fmt.Fprintln(fehl, "ssh (Durchreiche): "+Variable+" fehlt")
		return 255
	}
	c, err := net.DialTimeout("unix", sock, 5*time.Second)
	if err != nil {
		fmt.Fprintf(fehl, "ssh (Durchreiche): %v\n", err)
		return 255
	}
	defer c.Close()
	var mu sync.Mutex
	if err := schreibe(c, artKopf, []byte(befehl)); err != nil {
		return 255
	}
	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, err := ein.Read(buf)
			if n > 0 {
				mu.Lock()
				werr := schreibe(c, artEin, buf[:n])
				mu.Unlock()
				if werr != nil {
					return
				}
			}
			if err != nil {
				mu.Lock()
				_ = schreibe(c, artEin, nil)
				mu.Unlock()
				return
			}
		}
	}()
	r := bufio.NewReader(c)
	for {
		art, d, err := lies(r)
		if err != nil {
			fmt.Fprintln(fehl, "ssh (Durchreiche): Verbindung zum Dienst abgerissen")
			return 255
		}
		switch art {
		case artAus:
			_, _ = aus.Write(d)
		case artFehl:
			_, _ = fehl.Write(d)
		case artEnde:
			if len(d) == 4 {
				return int(int32(binary.BigEndian.Uint32(d)))
			}
			return 255
		}
	}
}

// ---- Skripte ausführen ----------------------------------------------------------------

// Lauf ist das Ergebnis eines Skripts.
type Lauf struct {
	Ausgabe string // Ausgabe und Fehlerausgabe, gemischt wie im Terminal, geschwärzt
	Code    int
}

// FuehreSkript führt ein Skript mit /bin/sh aus, mit dem Shim vorn im PATH.
// env sind zusätzliche Variablen (VP_SERVICE_PUBKEY=…).
func (s *Server) FuehreSkript(ctx context.Context, skript string, args []string, env []string) (Lauf, error) {
	cmd := exec.CommandContext(ctx, "/bin/sh", append([]string{skript}, args...)...)
	cmd.Dir = filepath.Dir(skript)
	cmd.Env = append([]string{
		"PATH=" + filepath.Join(s.Dir, "bin") + ":/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		"HOME=" + s.Dir,
		"TMPDIR=" + s.Dir,
		"LANG=C.UTF-8",
		Variable + "=" + s.Socket(),
	}, env...)
	var out begrenzt
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.Stdin = nil
	err := cmd.Run()
	l := Lauf{Ausgabe: geheim.Schwaerze(out.String())}
	var ee *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		l.Code = ee.ExitCode()
	default:
		return l, err
	}
	return l, nil
}

// begrenzt hält höchstens 1 MiB Ausgabe (der Rest wird verworfen).
type begrenzt struct {
	mu sync.Mutex
	b  []byte
}

func (b *begrenzt) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if rest := maxRahmen - len(b.b); rest > 0 {
		b.b = append(b.b, p[:min(len(p), rest)]...)
	}
	return len(p), nil
}

func (b *begrenzt) String() string { b.mu.Lock(); defer b.mu.Unlock(); return string(b.b) }
