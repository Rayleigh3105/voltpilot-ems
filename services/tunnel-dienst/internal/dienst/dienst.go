// Package dienst ist ein Lauf des Tunnel-Dienstes: Basis sichern, Soll
// abholen, prüfen, abgleichen, umsetzen.
//
// Die Haltung bei Störungen ist immer dieselbe: im Zweifel nichts öffnen.
//   - API nicht erreichbar, Anmeldung abgelehnt oder Soll ungültig: der letzte
//     Stand bleibt, kein neues Fenster. Offene Fenster laufen im Kernel von
//     selbst ab.
//   - Firewall-Basis nicht sicherbar: keine Änderung an Peers.
//   - Zu viele Peers sollen auf einmal weg: keiner wird entfernt, Alarm.
//   - Neustart ohne erreichbare API: Peers aus dem Zwischenstand, nie Fenster.
package dienst

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/quelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// Toleranz der Restlaufzeit, ab der ein Fenster-Element neu gesetzt wird.
const Toleranz = 10 * time.Second

// Vorlauf: so weit darf ein Fensterbeginn in der Zukunft liegen und dennoch
// als begonnen gelten (Uhrabweichung zwischen API und VM).
const Vorlauf = 60 * time.Second

// AlarmNachFehlern: ab so vielen Fehlläufen in Folge wird aus der Warnung ein Alarm.
const AlarmNachFehlern = 10

// Quelle liefert den Soll-Stand als Rohbytes.
type Quelle interface {
	Hole(ctx context.Context) ([]byte, error)
}

// WireGuard ist die Peer-Seite.
type WireGuard interface {
	Peers(ctx context.Context) (map[string][]netip.Prefix, error)
	Setze(ctx context.Context, key string, adresse netip.Addr) error
	Entferne(ctx context.Context, key string) error
}

// Firewall ist die nft-Seite.
type Firewall interface {
	SichereBasis(ctx context.Context) (bool, error)
	Fenster(ctx context.Context) (map[abgleich.Paar]time.Duration, error)
	EntferneFenster(ctx context.Context, p abgleich.Paar) error
	FuegeFensterHinzu(ctx context.Context, e []abgleich.FensterSetzen) error
}

// Dienst hält den Zustand zwischen Läufen.
type Dienst struct {
	Quelle       Quelle
	WG           WireGuard
	FW           Firewall
	Netze        soll.Netze
	MaxFenster   time.Duration
	MaxEntfernen int
	// Verzeichnis für letzter-soll.json (Wiederanlauf) und status.json.
	Zustand string
	Log     *slog.Logger
	Jetzt   func() time.Time

	fehlerInFolge        int
	wiederanlaufGeprueft bool
	letzterErfolg        time.Time
}

// Ergebnis eines Laufs.
type Ergebnis struct {
	// Frisch: ein frisch abgeholter, gültiger Soll-Stand wurde abgeglichen.
	Frisch  bool
	Plan    abgleich.Plan
	Befunde []soll.Befund
	Fehler  error
}

// Status ist der Inhalt von status.json - für `vp-tunnel-dienst status` und
// eine Überwachung von außen.
type Status struct {
	LetzterLauf   time.Time `json:"letzterLauf"`
	LetzterErfolg time.Time `json:"letzterErfolg,omitempty"`
	FehlerInFolge int       `json:"fehlerInFolge"`
	LetzterFehler string    `json:"letzterFehler,omitempty"`
	Peers         int       `json:"peers"`
	Fenster       int       `json:"fenster"`
	SollErzeugtAm time.Time `json:"sollErzeugtAm,omitempty"`
}

const (
	zwischenstand = "letzter-soll.json"
	statusDatei   = "status.json"
)

// Lauf führt einen Abgleich durch.
func (d *Dienst) Lauf(ctx context.Context) Ergebnis {
	jetzt := d.Jetzt()
	neu, err := d.FW.SichereBasis(ctx)
	if err != nil {
		err = fmt.Errorf("Firewall-Basis nicht gesichert - keine Änderung: %w", err)
		d.Log.Error("ALARM", "fehler", err)
		return d.fehlschlag(jetzt, err)
	}
	if neu {
		d.Log.Warn("Firewall-Basis geladen (fehlte oder wich ab); offene Fenster öffnet der nächste frische Soll-Stand")
	}

	daten, err := d.Quelle.Hole(ctx)
	if err != nil {
		if !d.wiederanlaufGeprueft {
			d.wiederanlaufGeprueft = true
			d.wiederanlauf(ctx)
		}
		if errors.Is(err, quelle.ErrAnmeldungAbgelehnt) {
			// Kein Ausfall, sondern falsche Zugangsdaten: eigener Wortlaut,
			// die Wirkung ist dieselbe.
			return d.fehlschlag(jetzt, fmt.Errorf("%w - letzter Stand bleibt, nichts Neues wird geöffnet", err))
		}
		return d.fehlschlag(jetzt, fmt.Errorf("API nicht erreichbar - letzter Stand bleibt, nichts Neues wird geöffnet: %w", err))
	}
	d.wiederanlaufGeprueft = true

	s, err := soll.Lies(daten)
	if err != nil {
		return d.fehlschlag(jetzt, err)
	}
	g, befunde, err := soll.Pruefe(s, d.Netze)
	if err != nil {
		d.Log.Error("ALARM: Soll-Stand verworfen", "fehler", err)
		return d.fehlschlag(jetzt, err)
	}
	for _, b := range befunde {
		d.Log.Warn("Eintrag übersprungen", "befund", b.String())
	}

	ist, err := d.ist(ctx)
	if err != nil {
		return d.fehlschlag(jetzt, err)
	}
	plan := abgleich.Rechne(g, ist, abgleich.Optionen{
		Jetzt: jetzt, MitFenster: true, MaxEntfernen: d.MaxEntfernen, MaxFenster: d.MaxFenster,
		Toleranz: Toleranz, Vorlauf: Vorlauf,
	})
	for _, a := range plan.Alarme {
		d.Log.Error("ALARM", "grund", a)
	}
	errAnwenden := d.wende(ctx, plan, g)
	if err := d.schreibe(zwischenstand, daten); err != nil {
		d.Log.Warn("Zwischenstand nicht gespeichert", "fehler", err)
	}
	e := Ergebnis{Frisch: true, Plan: plan, Befunde: befunde, Fehler: errAnwenden}
	if errAnwenden != nil {
		d.fehlerInFolge++
		d.Log.Error("Umsetzung unvollständig", "fehler", errAnwenden)
	} else {
		d.fehlerInFolge = 0
		d.letzterErfolg = jetzt
	}
	d.status(jetzt, errAnwenden, len(g.Peers), len(plan.FensterHinzufuegen)+zaehleBleibende(ist, plan), s.ErzeugtAm)
	return e
}

func zaehleBleibende(ist abgleich.Ist, plan abgleich.Plan) int {
	weg := map[abgleich.Paar]bool{}
	for _, p := range plan.FensterEntfernen {
		weg[p] = true
	}
	n := 0
	for p := range ist.Fenster {
		if !weg[p] {
			n++
		}
	}
	return n
}

func (d *Dienst) ist(ctx context.Context) (abgleich.Ist, error) {
	peers, err := d.WG.Peers(ctx)
	if err != nil {
		return abgleich.Ist{}, fmt.Errorf("WireGuard lesen: %w", err)
	}
	fenster, err := d.FW.Fenster(ctx)
	if err != nil {
		return abgleich.Ist{}, fmt.Errorf("Fenster lesen: %w", err)
	}
	return abgleich.Ist{Peers: peers, Fenster: fenster}, nil
}

// wiederanlauf setzt nach einem Neustart ohne erreichbare API die Peers aus
// dem letzten gültigen Stand - nur wenn die Schnittstelle leer ist, nur
// hinzufügen, NIE ein Fenster. Peers allein öffnen keinen Weg.
func (d *Dienst) wiederanlauf(ctx context.Context) {
	peers, err := d.WG.Peers(ctx)
	if err != nil || len(peers) > 0 {
		return
	}
	daten, err := os.ReadFile(filepath.Join(d.Zustand, zwischenstand))
	if err != nil {
		d.Log.Warn("Wiederanlauf: kein Zwischenstand, Schnittstelle bleibt leer", "fehler", err)
		return
	}
	s, err := soll.Lies(daten)
	if err != nil {
		return
	}
	g, _, err := soll.Pruefe(s, d.Netze)
	if err != nil {
		d.Log.Warn("Wiederanlauf: Zwischenstand passt nicht zur Konfiguration", "fehler", err)
		return
	}
	plan := abgleich.Rechne(g, abgleich.Ist{Peers: peers}, abgleich.Optionen{NurHinzufuegen: true})
	if err := d.wende(ctx, plan, g); err != nil {
		d.Log.Error("Wiederanlauf unvollständig", "fehler", err)
	}
	d.Log.Warn("Wiederanlauf aus dem Zwischenstand: Peers gesetzt, keine Fenster",
		"peers", len(plan.PeersSetzen), "stand", s.ErzeugtAm)
}

// wende setzt einen Plan um: erst schließen, dann öffnen.
func (d *Dienst) wende(ctx context.Context, plan abgleich.Plan, g soll.Gueltig) error {
	kennung := map[netip.Addr]string{}
	for _, p := range g.Peers {
		kennung[p.Adresse] = p.Kennung
	}
	var fehler []error
	for _, p := range plan.FensterEntfernen {
		if err := d.FW.EntferneFenster(ctx, p); err != nil {
			fehler = append(fehler, err)
			continue
		}
		d.Log.Info("Fenster geschlossen", "techniker", p.Techniker, "box", p.Box, "kennung", kennung[p.Box])
	}
	for _, key := range plan.PeersEntfernen {
		if err := d.WG.Entferne(ctx, key); err != nil {
			fehler = append(fehler, err)
			continue
		}
		d.Log.Info("Peer entfernt", "publicKey", key)
	}
	for _, ps := range plan.PeersSetzen {
		if err := d.WG.Setze(ctx, ps.PublicKey, ps.Adresse); err != nil {
			fehler = append(fehler, err)
			continue
		}
		was := "Peer-Adresse gesetzt"
		if ps.Neu {
			was = "Peer angelegt"
		}
		d.Log.Info(was, "kennung", ps.Kennung, "adresse", ps.Adresse, "publicKey", ps.PublicKey)
	}
	if len(plan.FensterHinzufuegen) > 0 {
		if err := d.FW.FuegeFensterHinzu(ctx, plan.FensterHinzufuegen); err != nil {
			fehler = append(fehler, err)
		} else {
			for _, f := range plan.FensterHinzufuegen {
				d.Log.Info("Fenster geöffnet", "techniker", f.Paar.Techniker, "box", f.Paar.Box,
					"kennung", kennung[f.Paar.Box], "sekunden", int(f.Timeout.Seconds()), "fenster", f.FensterID)
			}
		}
	}
	return errors.Join(fehler...)
}

func (d *Dienst) fehlschlag(jetzt time.Time, err error) Ergebnis {
	d.fehlerInFolge++
	switch {
	case d.fehlerInFolge >= AlarmNachFehlern:
		d.Log.Error("ALARM: Fehlläufe in Folge", "anzahl", d.fehlerInFolge, "fehler", err)
	case errors.Is(err, quelle.ErrAnmeldungAbgelehnt):
		// Vergeht nicht von selbst: sofort als Fehler, nicht erst als Alarm
		// nach AlarmNachFehlern Läufen.
		d.Log.Error("Lauf ohne Änderung", "fehler", err)
	default:
		d.Log.Warn("Lauf ohne Änderung", "fehler", err)
	}
	d.status(jetzt, err, -1, -1, time.Time{})
	return Ergebnis{Fehler: err}
}

func (d *Dienst) status(jetzt time.Time, err error, peers, fenster int, erzeugt time.Time) {
	st := Status{LetzterLauf: jetzt, LetzterErfolg: d.letzterErfolg, FehlerInFolge: d.fehlerInFolge,
		Peers: peers, Fenster: fenster, SollErzeugtAm: erzeugt}
	if err != nil {
		st.LetzterFehler = err.Error()
	}
	daten, _ := json.MarshalIndent(st, "", "  ")
	if e := d.schreibe(statusDatei, append(daten, '\n')); e != nil {
		d.Log.Warn("status.json nicht geschrieben", "fehler", e)
	}
}

// schreibe legt eine Datei atomar ab (0600: der Soll-Stand nennt alle Peers).
func (d *Dienst) schreibe(name string, daten []byte) error {
	if d.Zustand == "" {
		return nil
	}
	if err := os.MkdirAll(d.Zustand, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(d.Zustand, "."+name+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(daten); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(d.Zustand, name))
}

// LiesZwischenstand liefert den letzten gültigen Soll-Stand (für `status`).
func LiesZwischenstand(verzeichnis string) (soll.Soll, error) {
	daten, err := os.ReadFile(filepath.Join(verzeichnis, zwischenstand))
	if err != nil {
		return soll.Soll{}, err
	}
	return soll.Lies(daten)
}

// LiesStatus liefert status.json.
func LiesStatus(verzeichnis string) (Status, error) {
	var st Status
	daten, err := os.ReadFile(filepath.Join(verzeichnis, statusDatei))
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(daten, &st)
}
