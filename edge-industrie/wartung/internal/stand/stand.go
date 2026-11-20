// Package stand ist der Stand des laufenden Tunnel-Programms für "vp-wartung
// status": eine Datei im RAM, die der Dienst bei jeder Änderung und alle paar
// Sekunden ersetzt. Sie nennt nie einen Schlüssel, nur Zugang, Restlaufzeit
// und Fingerabdrücke.
//
// Zeiten stehen als Dauer zum Zeitpunkt des Schreibens, dazu die Laufzeit der
// Box beim Schreiben: Wer liest, rechnet das Alter in Laufzeit, nicht in
// Uhrzeit.
package stand

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// Stand ist, was der Dienst über sich sagt. Sekundenangaben mit -1: gibt es nicht.
type Stand struct {
	Fassung     string    `json:"fassung"`
	PID         int       `json:"pid"`
	Laufzeit    int64     `json:"laufzeit"` // Laufzeit der Box beim Schreiben, s
	LaeuftSeit  int64     `json:"laeuft_seit"`
	Adresse     string    `json:"adresse"`
	Endpunkt    string    `json:"endpunkt"`         // wie eingestellt, name:port
	EndpunktIP  string    `json:"endpunkt_adresse"` // wohin der Tunnel gerade spricht
	Handshake   int64     `json:"handshake_vor"`
	Hostkeys    []string  `json:"host_schluessel"`
	Netze       string    `json:"netze"`
	Web         string    `json:"web"` // "netz -> 127.0.0.1:8484" oder "zu"
	Server      string    `json:"schluessel_server"`
	Antwort     int64     `json:"antwort_vor"`
	Grund       string    `json:"grund,omitempty"`
	DauerDatei  string    `json:"dauerhaft_datei"`
	Dauerhaft   int       `json:"dauerhaft"`
	MitOptionen int       `json:"dauerhaft_mit_optionen"`
	Fenster     []Fenster `json:"fenster"`
	SitzDauer   int       `json:"sitzungen_dauerhaft"`
	SitzFenster int       `json:"sitzungen_fenster"`
	Ereignisse  string    `json:"ereignisse"`
}

// Fenster ist ein gültiger Fenster-Schlüssel, ohne den Schlüssel.
type Fenster struct {
	Zugang string `json:"zugang"`
	Rest   int64  `json:"rest"`
}

// Laufzeit ist die Laufzeit der Box in Sekunden (monotone Uhr): in jedem
// Prozess derselbe Wert, unabhängig von der Uhrzeit.
func Laufzeit() int64 {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts); err != nil {
		return 0
	}
	return int64(ts.Sec) // Sec ist auf 32-Bit-ARM (der PFC200) int32
}

// Sekunden rundet eine Dauer; ok false ergibt -1.
func Sekunden(d time.Duration, ok bool) int64 {
	if !ok {
		return -1
	}
	return int64(d / time.Second)
}

// Schreibe ersetzt die Datei in einem Zug.
func Schreibe(pfad string, s Stand) error {
	daten, err := json.Marshal(s)
	if err != nil {
		return err
	}
	neu := filepath.Join(filepath.Dir(pfad), "."+filepath.Base(pfad)+".neu")
	// Nie einem vorgefundenen Link folgen.
	_ = os.Remove(neu)
	f, err := os.OpenFile(neu, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(daten, '\n')); err != nil {
		_ = f.Close()
		_ = os.Remove(neu)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(neu)
		return err
	}
	return os.Rename(neu, pfad)
}

// Lies liest die Datei.
func Lies(pfad string) (Stand, error) {
	var s Stand
	daten, err := os.ReadFile(pfad)
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(daten, &s)
}
