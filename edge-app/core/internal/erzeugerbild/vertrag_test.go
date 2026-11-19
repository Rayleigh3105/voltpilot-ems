package erzeugerbild

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The contract vectors are the reader's specification (erzeuger-registerbild.md
// §12, E1-E21): raw words in, every field out. This test reads each case
// through the same Stufe the box uses and compares what the box decides -
// result, reason, head, number of requests, heartbeat verdict, staleness,
// every value with its reason, every unit, the names.
//
// Two columns of the vectors are not the box's to compute and are left to the
// cloud, exactly like on the Docker box: the per-bit flags of a bit field (the
// box sends the word, the cloud names the bits) and zaehler_differenz (the
// cloud's VorgabenAbleitung counts the changes between two readings).

const vertragsVektoren = "../../../../docs/contracts/v2/erzeuger-registerbild-vectors.json"

type vertragKopf struct {
	VersionHaupt   int    `json:"version_haupt"`
	VersionNeben   int    `json:"version_neben"`
	TeAnzahl       int    `json:"te_anzahl"`
	Herzschlag     int    `json:"herzschlag"`
	Programmstand  *int   `json:"programmstand"`
	SteuerungID    *int64 `json:"steuerung_id"`
	Anlagenart     *int   `json:"anlagenart"`
	BeschreibungAb int    `json:"beschreibung_ab"`
}

type vertragEinheit struct {
	N       int               `json:"n"`
	Adresse int               `json:"adresse"`
	Werte   map[string]*int64 `json:"werte"`
	Leer    map[string]string `json:"leer"`
}

type vertragLesung struct {
	Ergebnis         string            `json:"ergebnis"`
	Grund            *string           `json:"grund"`
	Kopf             *vertragKopf      `json:"kopf"`
	Anfragen         *int              `json:"anfragen"`
	HerzschlagUrteil *string           `json:"herzschlag_urteil"`
	Veraltet         *bool             `json:"veraltet"`
	Werte            map[string]*int64 `json:"werte"`
	Einheiten        []vertragEinheit  `json:"einheiten"`
	Leer             map[string]string `json:"leer"`
}

type vertragNamen struct {
	Ergebnis             string    `json:"ergebnis"`
	Anfragen             *int      `json:"anfragen"`
	NetzbetreiberName    *string   `json:"netzbetreiber_name"`
	DirektvermarkterName *string   `json:"direktvermarkter_name"`
	TTypName             []*string `json:"t_typ_name"`
}

type vertragFall struct {
	Name  string `json:"name"`
	Input struct {
		Lesungen []struct {
			Woerter []uint16 `json:"woerter"`
		} `json:"lesungen"`
		Namen *struct {
			Ab      int      `json:"ab"`
			Woerter []uint16 `json:"woerter"`
		} `json:"namen"`
	} `json:"input"`
	Expected struct {
		Lesungen []vertragLesung `json:"lesungen"`
		Namen    *vertragNamen   `json:"namen"`
	} `json:"expected"`
}

func ladeVertrag(t *testing.T) []vertragFall {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(vertragsVektoren))
	if err != nil {
		t.Fatalf("Vertragsvektoren: %v", err)
	}
	var doc struct {
		Faelle []vertragFall `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("Vertragsvektoren unlesbar: %v", err)
	}
	if len(doc.Faelle) < 21 {
		t.Fatalf("nur %d Faelle", len(doc.Faelle))
	}
	return doc.Faelle
}

func gleichZeiger[T comparable](a, b *T) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// rohWerte is the box's reading in the vector's terms: the raw number of a
// value (unscaled - the vector states n_p_prozent 1000, not 100,0 %), null
// without one, and the reason beside it. The head's four points stand under
// kopf in the vector, their reasons beside the plant's.
func rohWerte(werte []Wert, einheit int) (map[string]*int64, map[string]string) {
	out, leer := map[string]*int64{}, map[string]string{}
	for _, v := range werte {
		if v.Einheit != einheit {
			continue
		}
		if v.Wert == nil {
			leer[v.Feld] = v.Grund
		}
		if einheit == 0 && v.Abschnitt == "kopf" {
			continue
		}
		if v.Wert == nil {
			out[v.Feld] = nil
			continue
		}
		r := v.Roh
		out[v.Feld] = &r
	}
	return out, leer
}

func vergleicheWerte(t *testing.T, wo string, soll map[string]*int64, sollLeer map[string]string,
	ist map[string]*int64, istLeer map[string]string) {
	t.Helper()
	if len(soll) != len(ist) {
		t.Errorf("%s: %d Werte, erwartet %d", wo, len(ist), len(soll))
	}
	for feld, s := range soll {
		i, da := ist[feld]
		if !da || !gleichZeiger(s, i) {
			t.Errorf("%s %s: %v, erwartet %v", wo, feld, deref(i), deref(s))
		}
	}
	for feld, s := range sollLeer {
		if istLeer[feld] != s {
			t.Errorf("%s %s: Grund %q, erwartet %q", wo, feld, istLeer[feld], s)
		}
	}
	if len(sollLeer) != len(istLeer) {
		t.Errorf("%s: Gruende %v, erwartet %v", wo, istLeer, sollLeer)
	}
}

func deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestVertragsvektorenLesungen(t *testing.T) {
	for _, fall := range ladeVertrag(t) {
		t.Run(fall.Name, func(t *testing.T) {
			var stufe Stufe
			jetzt := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
			var letzterKopf *Kopf
			for i, eingabe := range fall.Input.Lesungen {
				soll := fall.Expected.Lesungen[i]
				ist := stufe.LesungAuswerten(eingabe.Woerter, "steuerung", "big", nil, "DQ-1", "", jetzt)
				jetzt = jetzt.Add(5 * time.Second)
				wo := fall.Name + " Lesung " + string(rune('1'+i))
				ergebnis := "nicht_lesbar"
				if ist.Ergebnis == ErgebnisErkannt {
					ergebnis = "lesbar"
					letzterKopf = ist.Kopf
				}
				if ergebnis != soll.Ergebnis {
					t.Fatalf("%s: %s, erwartet %s (%s)", wo, ergebnis, soll.Ergebnis, ist.Grund)
				}
				if soll.Grund == nil && ist.Grund != "" || soll.Grund != nil && *soll.Grund != ist.Grund {
					t.Errorf("%s: Grund %q, erwartet %v", wo, ist.Grund, deref(soll.Grund))
				}
				vergleicheKopf(t, wo, soll.Kopf, ist.Kopf)
				if ergebnis != "lesbar" {
					if soll.Anfragen != nil || soll.Veraltet != nil || soll.HerzschlagUrteil != nil {
						t.Errorf("%s: unlesbar mit Anfragen/Urteil im Vektor", wo)
					}
					continue
				}
				anfragen, err := PlaneAnfragen(0, ist.Kopf.TeAnzahl, 0)
				if err != nil || soll.Anfragen == nil || len(anfragen) != *soll.Anfragen {
					t.Errorf("%s: %d Anfragen (%v), erwartet %v", wo, len(anfragen), err, deref(soll.Anfragen))
				}
				urteil := ist.HerzschlagUrteil
				if urteil == "erste_lesung" {
					urteil = ""
				}
				if soll.HerzschlagUrteil == nil && urteil != "" ||
					soll.HerzschlagUrteil != nil && *soll.HerzschlagUrteil != urteil {
					t.Errorf("%s: Herzschlag %q, erwartet %v", wo, urteil, deref(soll.HerzschlagUrteil))
				}
				veraltet := ist.Qualitaet == QualitaetAlt
				if soll.Veraltet == nil || *soll.Veraltet != veraltet {
					t.Errorf("%s: veraltet %v, erwartet %v", wo, veraltet, deref(soll.Veraltet))
				}
				werte, leer := rohWerte(ist.Werte, 0)
				vergleicheWerte(t, wo, soll.Werte, soll.Leer, werte, leer)
				if len(soll.Einheiten) != ist.Kopf.TeAnzahl {
					t.Fatalf("%s: %d Einheiten, erwartet %d", wo, ist.Kopf.TeAnzahl, len(soll.Einheiten))
				}
				for _, e := range soll.Einheiten {
					if e.Adresse != FesterTeil+(e.N-1)*EinheitLaenge {
						t.Errorf("%s: Einheit %d an %d", wo, e.N, e.Adresse)
					}
					w, l := rohWerte(ist.Werte, e.N)
					vergleicheWerte(t, wo+" Einheit "+string(rune('0'+e.N)), e.Werte, e.Leer, w, l)
				}
			}
			vergleicheNamen(t, fall, letzterKopf)
		})
	}
}

func vergleicheKopf(t *testing.T, wo string, soll *vertragKopf, ist *Kopf) {
	t.Helper()
	if soll == nil {
		return // the vector names no head; the box may still know the version
	}
	if ist == nil || !ist.Voll {
		t.Errorf("%s: kein Kopf, erwartet %+v", wo, *soll)
		return
	}
	if ist.Hauptversion != soll.VersionHaupt || ist.Nebenversion != soll.VersionNeben ||
		ist.TeAnzahl != soll.TeAnzahl || ist.Herzschlag != soll.Herzschlag ||
		!gleichZeiger(ist.Programmstand, soll.Programmstand) || !gleichZeiger(ist.SteuerungID, soll.SteuerungID) ||
		!gleichZeiger(ist.Anlagenart, soll.Anlagenart) || ist.BeschreibungAb != soll.BeschreibungAb {
		t.Errorf("%s: Kopf %+v, erwartet %+v", wo, *ist, *soll)
	}
}

func vergleicheNamen(t *testing.T, fall vertragFall, k *Kopf) {
	t.Helper()
	soll := fall.Expected.Namen
	if soll == nil {
		if k != nil {
			t.Errorf("%s: lesbares Bild ohne Namen-Erwartung", fall.Name)
		}
		return
	}
	if k == nil {
		t.Fatalf("%s: Namen erwartet, aber kein lesbares Bild", fall.Name)
	}
	bereich, ok := NamensBereich(k, 0)
	ergebnis := "gelesen"
	switch {
	case !ok && (k.BeschreibungAb == 0 || k.BeschreibungAb == 0xFFFF):
		ergebnis = "keine_namen"
	case !ok:
		ergebnis = "bereich_ungueltig"
	}
	if ergebnis != soll.Ergebnis {
		t.Fatalf("%s: Namen %s, erwartet %s", fall.Name, ergebnis, soll.Ergebnis)
	}
	if !ok {
		return
	}
	if fall.Input.Namen == nil || fall.Input.Namen.Ab != k.BeschreibungAb {
		t.Fatalf("%s: Namen-Eingabe passt nicht zum Kopf", fall.Name)
	}
	if n := len(PlaneNamen(bereich, ok, 0)); soll.Anfragen == nil || n != *soll.Anfragen {
		t.Errorf("%s: %d Namen-Anfragen, erwartet %v", fall.Name, n, deref(soll.Anfragen))
	}
	namen := LiesNamen(fall.Input.Namen.Woerter, k.TeAnzahl)
	if !gleichZeiger(namen[0].Wert, soll.NetzbetreiberName) || !gleichZeiger(namen[1].Wert, soll.DirektvermarkterName) {
		t.Errorf("%s: Namen %v/%v, erwartet %v/%v", fall.Name, deref(namen[0].Wert), deref(namen[1].Wert),
			deref(soll.NetzbetreiberName), deref(soll.DirektvermarkterName))
	}
	if len(namen)-2 != len(soll.TTypName) {
		t.Fatalf("%s: %d Typnamen, erwartet %d", fall.Name, len(namen)-2, len(soll.TTypName))
	}
	for i, s := range soll.TTypName {
		if !gleichZeiger(namen[2+i].Wert, s) {
			t.Errorf("%s: Typname %d %v, erwartet %v", fall.Name, i+1, deref(namen[2+i].Wert), deref(s))
		}
	}
}
