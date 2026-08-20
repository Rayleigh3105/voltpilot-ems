package agent

// UPDATE-KONTINUITÄT auf der VERDRAHTUNGS-Ebene: eine Bestandsanlage, deren
// Quellen-Kennungen aus der Zeit VOR sources.DeterministicID stammen, überlebt
// die Bestands-Übernahme ohne einen einzigen Schreibvorgang.
//
// Der reproduzierte Live-Defekt (Pilsting/Herzogau, edge-2026.08.5 -> .10):
// applyComponentsFromRegistry leitete deterministische Kennungen ab, ersetzte
// sources.json und veröffentlichte edge/sources/config neu - beide Fronius
// erschienen im Portal als "Neues Gerät gefunden".

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// legacyIDs stampft die Kennungen der laufenden Quellen auf die zufällige Form,
// die eine vor PR 270 eingerichtete Box bis heute trägt - inklusive der Datei,
// aus der sie nach einem Neustart wieder gelesen werden.
func legacyIDs(t *testing.T, a *Agent) []sources.Source {
	t.Helper()
	a.srcMu.Lock()
	for i := range a.srcs {
		a.srcs[i].ID = []string{"src-a7k3mq2p", "src-zt9wb4hd"}[i]
	}
	list := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	if err := a.srcStore.Save(list); err != nil {
		t.Fatalf("Aufbau: %v", err)
	}
	return list
}

func TestTheTakeoverOfALegacyPlantWritesNothingAndKeepsEveryBinding(t *testing.T) {
	a := pilstingBox(t)
	running := legacyIDs(t, a)

	path := filepath.Join(a.Cfg.DataDir, "sources.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Aufbau: %v", err)
	}

	// Die ECHTE Übernahme: der Push entsteht aus dem, was diese Box meldet.
	a.applyComponentsFromRegistry(cloudPushFromReport(a.localSetupSummary()))

	after := a.ListSources()
	if len(after) != len(running) {
		t.Fatalf("Quellen = %d, will %d", len(after), len(running))
	}
	for i := range after {
		if after[i].ID != running[i].ID {
			t.Fatalf("Quelle %d: Kennung %q, will die laufende %q - die Portal-Bindung "+
				"reisst und das Gerät erscheint als \"Neues Gerät gefunden\"",
				i, after[i].ID, running[i].ID)
		}
	}
	// Kein Schreibvorgang: die Datei ist Byte für Byte dieselbe (die Übernahme
	// darf weder Kennungen noch Zeitstempel neu setzen).
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("sources.json: %v", err)
	}
	if string(got) != string(before) {
		t.Fatalf("sources.json wurde neu geschrieben:\nvorher: %s\nnachher: %s", before, got)
	}
	// Und die Anlage ist trotzdem übernommen - das ist die EINZIGE Änderung.
	if !a.PortalManagedComponents() {
		t.Fatal("nach der Übernahme muss die Anlage portal-verwaltet sein")
	}
}

func TestALegacyPlantThatMeasuresKeepsMeasuringThroughTheTakeover(t *testing.T) {
	a := pilstingBox(t)
	running := legacyIDs(t, a)

	// Beide Quellen liefern - unter ihren LAUFENDEN Kennungen.
	for _, s := range running {
		a.onSourceTelemetry(sources.TopicPrefix+s.ID+"/telemetry",
			[]byte(`{"pv_power_kw":12.5}`))
	}
	a.applyComponentsFromRegistry(cloudPushFromReport(a.localSetupSummary()))

	// Nach der Übernahme dürfen weder die Messwerte noch ihre Frische verloren
	// gehen - eine neu vergebene Kennung hätte beide aus dem Zwischenspeicher
	// geworfen (writeComponentPlan räumt Readings nicht mehr konfigurierter
	// Geräte ab).
	statuses := a.SourceStatuses()
	readings := a.SourceLastReadings()
	for _, s := range running {
		if statuses[s.ID] != "ok" {
			t.Fatalf("Quelle %q meldet %q statt ok - ihre Messwerte wurden verworfen",
				s.ID, statuses[s.ID])
		}
		r, ok := readings[s.ID]
		if !ok || r.PvKw == nil || *r.PvKw != 12.5 {
			t.Fatalf("Quelle %q hat ihren Messwert verloren: %+v", s.ID, r)
		}
	}
	_ = time.Now
}
