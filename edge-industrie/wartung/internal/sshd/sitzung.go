package sshd

import (
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

// Der Suchpfad einer Sitzung: wie ihn eine Anmeldung als root am Gerät hat.
const suchpfad = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

type ptyAnfrage struct {
	Term                         string
	Spalten, Zeilen, Breit, Hoch uint32
	Modi                         string
}

type fenstergroesse struct{ Spalten, Zeilen, Breit, Hoch uint32 }

// sitzung bedient einen Kanal "session": höchstens ein Prozess, mit oder ohne
// Terminal. Endet der Kanal vor dem Prozess (Gegenseite weg, Verbindung
// beendet), schließt die Sitzung nur ihre Enden: Das Terminal meldet der Shell
// den Abbruch (SIGHUP), ein Befehl ohne Terminal bekommt das Ende seiner
// Eingabe und scheitert an seiner nächsten Ausgabe.
func (v *verbindung) sitzung(nc ssh.NewChannel) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	var pty *ptyAnfrage
	var p *prozess
	defer func() {
		if p != nil {
			p.loslassen()
		}
	}()
	for req := range reqs {
		ok := false
		switch req.Type {
		case "pty-req":
			var a ptyAnfrage
			if p == nil && ptyMoeglich && ssh.Unmarshal(req.Payload, &a) == nil {
				pty, ok = &a, true
			}
		case "window-change":
			var g fenstergroesse
			if p != nil && p.master != nil && ssh.Unmarshal(req.Payload, &g) == nil {
				ok = setzeGroesse(p.master, g.Spalten, g.Zeilen) == nil
			}
		case "shell", "exec":
			if p != nil {
				break
			}
			befehl := ""
			if req.Type == "exec" {
				var a struct{ Befehl string }
				if ssh.Unmarshal(req.Payload, &a) != nil {
					break
				}
				befehl = a.Befehl
			}
			if p, err = v.starte(ch, befehl, req.Type == "shell", pty); err != nil {
				v.srv.Log.Warn("Sitzung: Prozess nicht gestartet", "von", v.von, "grund", err.Error())
				p = nil
				break
			}
			ok = true
		}
		// "env", "subsystem" (kein SFTP), "signal" und alles Übrige: abgelehnt.
		if req.WantReply {
			_ = req.Reply(ok, nil)
		}
	}
}

// prozess ist der Prozess einer Sitzung mit seinen Enden auf dieser Seite.
type prozess struct {
	master *os.File // mit Terminal
	ein    *os.File // ohne Terminal: Schreibseite der Eingabe
	aus    []*os.File
	einmal sync.Once
}

// loslassen schließt die Enden dieser Seite. Der Prozess wird nicht beendet.
func (p *prozess) loslassen() {
	p.einmal.Do(func() {
		if p.master != nil {
			_ = p.master.Close()
		}
		if p.ein != nil {
			_ = p.ein.Close()
		}
		for _, f := range p.aus {
			_ = f.Close()
		}
	})
}

func (v *verbindung) umgebung(pty *ptyAnfrage, tty string) []string {
	shell, heim := v.srv.shellUndHeim()
	host, port, _ := net.SplitHostPort(v.von)
	lokalHost, lokalPort, _ := net.SplitHostPort(v.srv.Lokal)
	u := []string{
		"PATH=" + suchpfad, "HOME=" + heim, "USER=root", "LOGNAME=root", "SHELL=" + shell,
		"SSH_CLIENT=" + host + " " + port + " " + lokalPort,
		"SSH_CONNECTION=" + host + " " + port + " " + lokalHost + " " + lokalPort,
		// Woran ein Skript auf der Box erkennt, dass es durch den Wartungstunnel
		// läuft (wartung.sh baut den Tunnel dann nicht unter sich ab).
		"VP_WARTUNG_SITZUNG=" + string(v.urteil.Art),
	}
	if pty != nil {
		term := pty.Term
		if term == "" {
			term = "vt100"
		}
		u = append(u, "TERM="+term, "SSH_TTY="+tty)
	}
	return u
}

func (s *Server) shellUndHeim() (shell, heim string) {
	shell, heim = s.Shell, s.Heim
	if shell == "" {
		shell = "/bin/sh"
	}
	if heim == "" {
		heim = "/root"
	}
	return
}

func (v *verbindung) starte(ch ssh.Channel, befehl string, anmeldeShell bool, pty *ptyAnfrage) (*prozess, error) {
	shell, heim := v.srv.shellUndHeim()
	cmd := &exec.Cmd{Path: shell, Dir: heim}
	if anmeldeShell {
		// Wie eine Anmeldung: die Shell liest /etc/profile.
		cmd.Args = []string{"-" + filepath.Base(shell)}
	} else {
		cmd.Args = []string{shell, "-c", befehl}
	}
	if st, err := os.Stat(heim); err != nil || !st.IsDir() {
		cmd.Dir = "/"
	}
	if pty != nil {
		return v.starteMitTerminal(ch, cmd, pty)
	}
	return v.starteOhneTerminal(ch, cmd)
}

func (v *verbindung) starteMitTerminal(ch ssh.Channel, cmd *exec.Cmd, pty *ptyAnfrage) (*prozess, error) {
	master, slave, name, err := oeffnePty()
	if err != nil {
		return nil, err
	}
	_ = setzeGroesse(master, pty.Spalten, pty.Zeilen)
	cmd.Env = v.umgebung(pty, name)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, err
	}
	_ = slave.Close()
	p := &prozess{master: master}
	go func() { _, _ = io.Copy(master, ch) }()
	gelesen := make(chan struct{})
	go func() {
		// Endet mit einem Lesefehler, sobald niemand das Terminal mehr hält.
		_, _ = io.Copy(ch, master)
		close(gelesen)
	}()
	go v.warte(ch, cmd, p, gelesen)
	return p, nil
}

func (v *verbindung) starteOhneTerminal(ch ssh.Channel, cmd *exec.Cmd) (*prozess, error) {
	var paare [3][2]*os.File // je Lese- und Schreibseite: Eingabe, Ausgabe, Fehlerausgabe
	zu := func() {
		for _, p := range paare {
			for _, f := range p {
				if f != nil {
					_ = f.Close()
				}
			}
		}
	}
	for i := range paare {
		r, w, err := os.Pipe()
		if err != nil {
			zu()
			return nil, err
		}
		paare[i] = [2]*os.File{r, w}
	}
	cmd.Env = v.umgebung(nil, "")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = paare[0][0], paare[1][1], paare[2][1]
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		zu()
		return nil, err
	}
	// Die Enden des Prozesses gehören jetzt nur noch ihm.
	_ = paare[0][0].Close()
	_ = paare[1][1].Close()
	_ = paare[2][1].Close()
	ein, aus, fehl := paare[0][1], paare[1][0], paare[2][0]
	p := &prozess{ein: ein, aus: []*os.File{aus, fehl}}
	go func() {
		// Das Ende der Eingabe der Gegenseite ist das Ende der Eingabe des Prozesses.
		_, _ = io.Copy(ein, ch)
		_ = ein.Close()
	}()
	gelesen := make(chan struct{})
	var beide sync.WaitGroup
	beide.Add(2)
	go func() { defer beide.Done(); _, _ = io.Copy(ch, aus) }()
	go func() { defer beide.Done(); _, _ = io.Copy(ch.Stderr(), fehl) }()
	go func() { beide.Wait(); close(gelesen) }()
	go v.warte(ch, cmd, p, gelesen)
	return p, nil
}

// warte meldet der Gegenseite das Ende des Prozesses und schließt den Kanal.
// Die Ausgabe wird vorher zu Ende gelesen; hält ein abgekoppelter Kindprozess
// sie offen, höchstens fünf Sekunden lang.
func (v *verbindung) warte(ch ssh.Channel, cmd *exec.Cmd, p *prozess, gelesen <-chan struct{}) {
	err := cmd.Wait()
	select {
	case <-gelesen:
	case <-time.After(5 * time.Second):
	}
	p.loslassen()
	var ee *exec.ExitError
	switch {
	case err == nil:
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
	case errors.As(err, &ee):
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			_, _ = ch.SendRequest("exit-signal", false, ssh.Marshal(struct {
				Signal     string
				Kern       bool
				Text, Lang string
			}{signalName(ws.Signal()), ws.CoreDump(), "", ""}))
		} else {
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(ee.ExitCode())}))
		}
	default:
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{255}))
	}
	_ = ch.Close()
}

// signalName gibt den Namen eines Signals, wie SSH ihn nennt (ohne "SIG").
func signalName(s syscall.Signal) string {
	switch s {
	case syscall.SIGHUP:
		return "HUP"
	case syscall.SIGINT:
		return "INT"
	case syscall.SIGQUIT:
		return "QUIT"
	case syscall.SIGKILL:
		return "KILL"
	case syscall.SIGTERM:
		return "TERM"
	case syscall.SIGPIPE:
		return "PIPE"
	case syscall.SIGSEGV:
		return "SEGV"
	case syscall.SIGABRT:
		return "ABRT"
	}
	return "TERM"
}
