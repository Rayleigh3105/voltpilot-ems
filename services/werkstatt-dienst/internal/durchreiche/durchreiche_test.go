package durchreiche

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
)

func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "ssh" {
		os.Exit(Shim(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

func TestZerlege(t *testing.T) {
	faelle := []struct {
		args         []string
		ziel, befehl string
		steuerung    bool
	}{
		{[]string{"root@192.168.1.1", "cat > /x && chmod 0755 /x"}, "root@192.168.1.1", "cat > /x && chmod 0755 /x", false},
		{[]string{"-i", "/k", "-o", "BatchMode=yes", "-T", "mango", "sh", "-s"}, "mango", "sh -s", false},
		{[]string{"-ikey", "-p2222", "b", "x"}, "b", "x", false},
		{[]string{"-O", "exit", "mango"}, "mango", "", true},
		{[]string{"--", "b", "-n"}, "b", "-n", false},
	}
	for _, f := range faelle {
		z, b, s, err := Zerlege(f.args)
		if err != nil || z != f.ziel || b != f.befehl || s != f.steuerung {
			t.Errorf("%v: %q %q %v %v", f.args, z, b, s, err)
		}
	}
	if _, _, _, err := Zerlege([]string{"-i"}); err == nil {
		t.Error("-i ohne Argument")
	}
	if code := Shim([]string{"box"}, strings.NewReader(""), io.Discard, io.Discard); code != 255 {
		t.Errorf("ohne Befehl: %d", code)
	}
}

// Ein Skript ruft ssh auf; die Durchreiche gibt Eingabe, Ausgabe, Fehlerausgabe
// und Ausgang über die Verbindung zur Box weiter.
func TestSkriptUeberDieBox(t *testing.T) {
	m := attrappe.NeueMango(t, true)
	addr, _ := m.Ziel("192.168.1.1:22")
	cl, err := ssh.Dial("tcp", addr, &ssh.ClientConfig{User: "root", Auth: []ssh.AuthMethod{ssh.Password("")}, HostKeyCallback: ssh.InsecureIgnoreHostKey()})
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	dir, _ := os.MkdirTemp("/tmp", "vpd-")
	defer os.RemoveAll(dir)
	s, err := Starte(filepath.Join(dir, "d"), func() *ssh.Client { return cl }, logs.Neu(io.Discard, "text", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Schliesse()
	skript := filepath.Join(dir, "probe.sh")
	_ = os.WriteFile(skript, []byte(`#!/bin/sh
printf 'ssh-rsa AAAA notfall\n' | ssh -i /dev/null "$1" 'umask 077 && cat > /etc/dropbear/authorized_keys && chmod 600 /etc/dropbear/authorized_keys'
ssh "$1" cat /etc/dropbear/authorized_keys
ssh "$1" 'gibt es nicht' || echo "ausgang $?"
ssh -O exit "$1" && echo steuerung-ok
`), 0o755)
	l, err := s.FuehreSkript(context.Background(), skript, []string{"root@192.168.1.1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ssh-rsa AAAA notfall", "Attrappe kennt den Befehl nicht: gibt es nicht", "ausgang 127", "steuerung-ok"}
	for _, w := range want {
		if !strings.Contains(l.Ausgabe, w) {
			t.Errorf("Ausgabe ohne %q:\n%s", w, l.Ausgabe)
		}
	}
	if l.Code != 0 || m.Datei("/etc/dropbear/authorized_keys") != "ssh-rsa AAAA notfall\n" {
		t.Fatalf("Code %d, Datei %q", l.Code, m.Datei("/etc/dropbear/authorized_keys"))
	}
	if b := s.Befehle(); len(b) != 3 {
		t.Fatalf("Befehle %v", b)
	}
	var leer bytes.Buffer
	if code := Shim([]string{"b", "x"}, strings.NewReader(""), &leer, &leer); code != 255 || !strings.Contains(leer.String(), Variable) {
		t.Fatalf("ohne Socket: %d %s", code, leer.String())
	}
}
