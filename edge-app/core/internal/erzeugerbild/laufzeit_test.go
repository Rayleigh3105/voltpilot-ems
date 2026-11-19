package erzeugerbild

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// The runtime vectors are generated from the palette itself
// (edge-app/nodered/measurements/erzeuger-laufzeit-vectors.gen.js drives the
// real MeasurementRuntime and vp-modbus-probe.js). This test replays every
// case through the Go twin and compares what reaches the local bus.
//
// Read receipts are compared as sums per tick (requests, samples) and the set
// of failure classes: the palette sends one receipt per sample, Edge Light one
// per read and outcome - the core's collector sums them the same way.

const laufzeitVektoren = "../../../nodered/measurements/erzeuger-laufzeit-vectors.json"

type laufzeitDatei struct {
	Start        string         `json:"start"`
	Laufzeit     []laufzeitFall `json:"laufzeit"`
	Kopfpruefung []kopfFall     `json:"kopfpruefung"`
}

type laufzeitFall struct {
	Name  string `json:"name"`
	Input struct {
		Binding struct {
			Entities map[string]struct {
				EntityType   string `json:"entity_type"`
				EdgeSourceID string `json:"edge_source_id"`
				DataSourceID string `json:"data_source_id"`
			} `json:"entities"`
			Sources map[string]struct {
				Connection struct {
					IP     string `json:"ip"`
					Port   int    `json:"port"`
					UnitID int    `json:"unit_id"`
				} `json:"connection"`
			} `json:"sources"`
		} `json:"binding"`
		Config struct {
			Revision       int64           `json:"revision"`
			CatalogVersion string          `json:"catalog_version"`
			Selections     []Auswahl       `json:"selections"`
			Bilder         []Bildparameter `json:"erzeuger_registerbilder"`
		} `json:"config"`
		Takte []struct {
			NachMs int      `json:"nach_ms"`
			Bild   []uint16 `json:"bild"`
			Basis  int      `json:"basis"`
			Fehler string   `json:"fehler"`
		} `json:"takte"`
	} `json:"input"`
	Expected struct {
		Status struct {
			Revision int64       `json:"revision"`
			Accepted []string    `json:"accepted"`
			Rejected []Ablehnung `json:"rejected"`
		} `json:"status"`
		Anfragen []struct {
			Start int `json:"start"`
			Count int `json:"count"`
			FC    int `json:"fc"`
		} `json:"anfragen"`
		Takte []struct {
			Lesungen []struct {
				Start int `json:"start"`
				Count int `json:"count"`
				FC    int `json:"fc"`
			} `json:"lesungen"`
			Nachrichten []struct {
				Topic   string          `json:"topic"`
				Payload json.RawMessage `json:"payload"`
			} `json:"nachrichten"`
			Belege struct {
				IDs      []string `json:"ids"`
				Requests int      `json:"requests"`
				Samples  int      `json:"samples"`
				Fehler   []string `json:"fehler"`
			} `json:"belege"`
		} `json:"takte"`
	} `json:"expected"`
}

type kopfFall struct {
	Name  string `json:"name"`
	Input struct {
		Ops    []ProbeOp `json:"ops"`
		Bild   []uint16  `json:"bild"`
		Basis  int       `json:"basis"`
		Fehler string    `json:"fehler"`
	} `json:"input"`
	Expected struct {
		Lesungen []struct {
			FC    int `json:"fc"`
			Start int `json:"start"`
			Count int `json:"count"`
		} `json:"lesungen"`
		Results []json.RawMessage `json:"results"`
	} `json:"expected"`
}

func ladeLaufzeit(t *testing.T) laufzeitDatei {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(laufzeitVektoren))
	if err != nil {
		t.Fatalf("Laufzeit-Vektoren: %v", err)
	}
	var d laufzeitDatei
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatalf("Laufzeit-Vektoren unlesbar: %v", err)
	}
	if len(d.Laufzeit) < 10 || len(d.Kopfpruefung) < 12 {
		t.Fatalf("zu wenige Faelle: %d/%d", len(d.Laufzeit), len(d.Kopfpruefung))
	}
	return d
}

// normal re-reads a JSON value into generic form, so field order and number
// spelling (1e3 vs 1000) do not matter - only meaning does.
func normal(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// zeitGleich compares the batch's observed_at as an instant (the palette writes
// milliseconds, the core accepts any RFC 3339).
func ohneZeit(m map[string]any) (map[string]any, string) {
	z, _ := m["observed_at"].(string)
	delete(m, "observed_at")
	return m, z
}

func TestLaufzeitVektoren(t *testing.T) {
	d := ladeLaufzeit(t)
	start, err := time.Parse(time.RFC3339, d.Start)
	if err != nil {
		t.Fatal(err)
	}
	for _, fall := range d.Laufzeit {
		t.Run(fall.Name, func(t *testing.T) {
			b := Bindung{Entitaeten: map[string]BindungsEntitaet{}, Quellen: map[string]BindungsQuelle{}}
			for id, e := range fall.Input.Binding.Entities {
				b.Entitaeten[id] = BindungsEntitaet{EntityType: e.EntityType, EdgeSourceID: e.EdgeSourceID,
					DataSourceID: e.DataSourceID}
			}
			for id, q := range fall.Input.Binding.Sources {
				b.Quellen[id] = BindungsQuelle{IP: q.Connection.IP, Port: q.Connection.Port, UnitID: q.Connection.UnitID}
			}
			c := fall.Input.Config
			var l Laufzeit
			status := l.Plane(Konfig{Revision: c.Revision, CatalogVersion: c.CatalogVersion, Auswahl: c.Selections,
				Bilder: c.Bilder}, b)
			soll := fall.Expected.Status
			if !reflect.DeepEqual(sortiert(status.Accepted), sortiert(soll.Accepted)) {
				t.Errorf("angenommen %v, erwartet %v", status.Accepted, soll.Accepted)
			}
			if !reflect.DeepEqual(normal(t, status.Rejected), normal(t, soll.Rejected)) {
				t.Errorf("abgelehnt %v, erwartet %v", status.Rejected, soll.Rejected)
			}
			var anfragen []string
			for _, a := range l.Anfragen() {
				anfragen = append(anfragen, anfrageText(a.Start, a.Count, a.FC))
			}
			var sollAnfragen []string
			for _, a := range fall.Expected.Anfragen {
				sollAnfragen = append(sollAnfragen, anfrageText(a.Start, a.Count, a.FC))
			}
			if strings.Join(anfragen, " ") != strings.Join(sollAnfragen, " ") {
				t.Errorf("Anfragen %v, erwartet %v", anfragen, sollAnfragen)
			}

			jetzt := start
			var bild []uint16
			basis := 0
			for i, takt := range fall.Input.Takte {
				jetzt = jetzt.Add(time.Duration(takt.NachMs) * time.Millisecond)
				if takt.Bild != nil {
					bild, basis = takt.Bild, takt.Basis
				}
				fehler := takt.Fehler
				lies := func(_ context.Context, _ Zielverbindung, s, n, _ int) ([]uint16, string) {
					if fehler != "" {
						return nil, fehler
					}
					von := s - basis
					if von < 0 || von+n > len(bild) {
						return nil, "no_answer"
					}
					return bild[von : von+n], ""
				}
				ist := l.Takt(context.Background(), jetzt, lies)
				erw := fall.Expected.Takte[i]
				wo := fall.Name + " Takt " + itoa(i+1)

				var gelesen, sollGelesen []string
				for _, a := range ist.Lesungen {
					gelesen = append(gelesen, anfrageText(a.Start, a.Count, a.FC))
				}
				for _, a := range erw.Lesungen {
					sollGelesen = append(sollGelesen, anfrageText(a.Start, a.Count, a.FC))
				}
				if strings.Join(gelesen, " ") != strings.Join(sollGelesen, " ") {
					t.Errorf("%s: gelesen %v, erwartet %v", wo, gelesen, sollGelesen)
				}

				if len(ist.Nachrichten) != len(erw.Nachrichten) {
					t.Errorf("%s: %d Nachrichten, erwartet %d: %s", wo, len(ist.Nachrichten), len(erw.Nachrichten),
						themen(ist.Nachrichten))
				}
				for j := 0; j < len(ist.Nachrichten) && j < len(erw.Nachrichten); j++ {
					n, e := ist.Nachrichten[j], erw.Nachrichten[j]
					if n.Topic != e.Topic {
						t.Errorf("%s Nachricht %d: %s, erwartet %s", wo, j, n.Topic, e.Topic)
						continue
					}
					var sollPayload any
					if err := json.Unmarshal(e.Payload, &sollPayload); err != nil {
						t.Fatal(err)
					}
					istPayload := normal(t, n.Payload)
					if n.Topic == SamplesTopic {
						im, iz := ohneZeit(istPayload.(map[string]any))
						sm, sz := ohneZeit(sollPayload.(map[string]any))
						it, _ := time.Parse(time.RFC3339Nano, iz)
						st, _ := time.Parse(time.RFC3339Nano, sz)
						if !it.Equal(st) {
							t.Errorf("%s: observed_at %s, erwartet %s", wo, iz, sz)
						}
						istPayload, sollPayload = im, sm
					}
					if !reflect.DeepEqual(istPayload, sollPayload) {
						a, _ := json.Marshal(istPayload)
						s, _ := json.Marshal(sollPayload)
						t.Errorf("%s %s:\n ist  %s\n soll %s", wo, n.Topic, a, s)
					}
				}

				requests, samples := 0, 0
				ids := map[string]bool{}
				var klassen []string
				for _, beleg := range ist.Belege {
					requests += beleg.Requests
					samples += beleg.Samples
					if beleg.Ziel.DataSourceID != "" {
						ids[beleg.Ziel.DataSourceID] = true
					}
					if beleg.Failed {
						klassen = append(klassen, beleg.ErrorClass)
					}
				}
				if requests != erw.Belege.Requests || samples != erw.Belege.Samples {
					t.Errorf("%s: Belege %d Anfragen/%d Samples, erwartet %d/%d", wo, requests, samples,
						erw.Belege.Requests, erw.Belege.Samples)
				}
				if !reflect.DeepEqual(menge(klassen), menge(erw.Belege.Fehler)) {
					t.Errorf("%s: Fehlerklassen %v, erwartet %v", wo, klassen, erw.Belege.Fehler)
				}
				var idListe []string
				for id := range ids {
					idListe = append(idListe, id)
				}
				if !reflect.DeepEqual(sortiert(idListe), sortiert(erw.Belege.IDs)) {
					t.Errorf("%s: Beleg-Kennungen %v, erwartet %v", wo, idListe, erw.Belege.IDs)
				}
			}
		})
	}
}

func TestKopfpruefungVektoren(t *testing.T) {
	d := ladeLaufzeit(t)
	for _, fall := range d.Kopfpruefung {
		t.Run(fall.Name, func(t *testing.T) {
			var gelesen []string
			lies := func(_ context.Context, v ProbeVerbindung, s, n int) ([]uint16, string, string) {
				gelesen = append(gelesen, anfrageText(s, n, v.FC))
				if fall.Input.Fehler != "" {
					// The palette's message prefix names the class (classify).
					return nil, ProbeUnerreichbar, fall.Input.Fehler
				}
				von := s - fall.Input.Basis
				if fall.Input.Bild == nil || von < 0 || von+n > len(fall.Input.Bild) {
					return nil, ProbeKeineAntwort, "Modbus-Ausnahme 0x02"
				}
				return fall.Input.Bild[von : von+n], "", ""
			}
			var ergebnisse []ProbeErgebnis
			for _, op := range fall.Input.Ops {
				ergebnisse = append(ergebnisse, KopfProbe(context.Background(), op, lies))
			}
			var soll []string
			for _, a := range fall.Expected.Lesungen {
				soll = append(soll, anfrageText(a.Start, a.Count, a.FC))
			}
			if strings.Join(gelesen, " ") != strings.Join(soll, " ") {
				t.Errorf("gelesen %v, erwartet %v", gelesen, soll)
			}
			if len(ergebnisse) != len(fall.Expected.Results) {
				t.Fatalf("%d Ergebnisse, erwartet %d", len(ergebnisse), len(fall.Expected.Results))
			}
			for i, raw := range fall.Expected.Results {
				var s map[string]any
				if err := json.Unmarshal(raw, &s); err != nil {
					t.Fatal(err)
				}
				ist := normal(t, ergebnisse[i]).(map[string]any)
				// The sentence must match; the original text in brackets is the
				// palette's socket wording, not a contract.
				for _, m := range []map[string]any{s, ist} {
					if msg, ok := m["message"].(string); ok {
						if k := strings.Index(msg, " ("); k >= 0 {
							m["message"] = msg[:k]
						}
					}
				}
				if !reflect.DeepEqual(ist, s) {
					a, _ := json.Marshal(ist)
					b, _ := json.Marshal(s)
					t.Errorf("Ergebnis %d:\n ist  %s\n soll %s", i, a, b)
				}
			}
		})
	}
}

func anfrageText(start, count, fc int) string {
	return "FC" + itoa(fc) + "@" + itoa(start) + "+" + itoa(count)
}

func themen(n []Nachricht) string {
	var out []string
	for _, x := range n {
		out = append(out, x.Topic)
	}
	return strings.Join(out, ",")
}

func sortiert(s []string) []string {
	out := append([]string{}, s...)
	sort.Strings(out)
	return out
}

func menge(s []string) map[string]bool {
	out := map[string]bool{}
	for _, x := range s {
		out[x] = true
	}
	return out
}
