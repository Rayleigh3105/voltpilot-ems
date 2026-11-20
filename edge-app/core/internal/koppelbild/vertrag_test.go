package koppelbild

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The contract's vectors (docs/contracts/v2/koppelbild-vectors.json) are the
// specification: every step of every case runs through the writer, the reader
// and the Lage here, exactly as the portal checker and the SPS checker run it
// through their own twins.
const vertragsVektoren = "../../../../docs/contracts/v2/koppelbild-vectors.json"

type vSchritt struct {
	TMs int64 `json:"t_ms"`
	W   *struct {
		Absicht *struct {
			Sitzung     uint16                 `json:"sitzung"`
			Herzschlag  uint16                 `json:"herzschlag"`
			SteuerungID uint32                 `json:"steuerung_id"`
			FristS      uint16                 `json:"frist_s"`
			EBits       []string               `json:"e_bits"`
			Plaetze     map[string]PlatzWunsch `json:"plaetze"`
		} `json:"absicht"`
		Woerter []uint16 `json:"woerter"`
		Von     string   `json:"von"`
	} `json:"w"`
	QWoerter []uint16 `json:"q_woerter"`
	Lesung   *struct {
		Woerter      []uint16 `json:"woerter"`
		KeineAntwort bool     `json:"keine_antwort"`
	} `json:"lesung"`
	Liest          *bool           `json:"liest"`
	NurLesen       bool            `json:"nur_lesen"`
	EdgeNeustart   bool            `json:"edge_neustart"`
	ErwartetLesung json.RawMessage `json:"erwartet_lesung"`
	ErwartetLage   *Urteil         `json:"erwartet_lage"`
}

type vFall struct {
	Name          string     `json:"name"`
	SteuerungSoll uint32     `json:"steuerung_soll"`
	Schritte      []vSchritt `json:"schritte"`
}

func ladeFaelle(t *testing.T) []vFall {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(vertragsVektoren))
	if err != nil {
		t.Fatalf("Vektoren: %v", err)
	}
	var v struct {
		Faelle []vFall `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren: %v", err)
	}
	if len(v.Faelle) < 29 {
		t.Fatalf("nur %d Fälle", len(v.Faelle))
	}
	return v.Faelle
}

// alsVektor renders a reading in the vectors' shape (grund and leer always
// present on a readable one).
func alsVektor(t *testing.T, l *Lesung) any {
	t.Helper()
	if l == nil {
		return nil
	}
	raw, _ := json.Marshal(l)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if l.Lesbar() {
		if _, da := m["grund"]; !da {
			m["grund"] = nil
		}
		if _, da := m["leer"]; !da {
			m["leer"] = map[string]any{}
		}
	}
	return m
}

func TestVertragsvektoren(t *testing.T) {
	for _, f := range ladeFaelle(t) {
		t.Run(f.Name, func(t *testing.T) {
			var z Lage
			for i, s := range f.Schritte {
				if s.EdgeNeustart {
					z = Lage{}
				}
				if s.W != nil {
					if a := s.W.Absicht; a != nil {
						pl := map[int]PlatzWunsch{}
						for k, p := range a.Plaetze {
							var n int
							_ = json.Unmarshal([]byte(k), &n)
							pl[n] = p
						}
						w := Schreibe(Absicht{Sitzung: a.Sitzung, Herzschlag: a.Herzschlag, SteuerungID: a.SteuerungID,
							FristS: a.FristS, EBits: a.EBits, Plaetze: pl})
						if !reflect.DeepEqual(w, s.W.Woerter) {
							t.Fatalf("Schritt %d: Schreiber\n%v\nstatt\n%v", i+1, w, s.W.Woerter)
						}
					}
					if s.W.Von == "edge" {
						z.Schrieb(s.W.Woerter[6])
					}
				}
				if s.Liest != nil && !*s.Liest {
					continue
				}
				var l *Lesung
				if s.Lesung == nil || !s.Lesung.KeineAntwort {
					q := s.QWoerter
					if s.Lesung != nil && s.Lesung.Woerter != nil {
						q = s.Lesung.Woerter
					}
					x := Lies(q, f.SteuerungSoll)
					l = &x
				}
				var soll any
				_ = json.Unmarshal(s.ErwartetLesung, &soll)
				if ist := alsVektor(t, l); !reflect.DeepEqual(ist, soll) {
					a, _ := json.Marshal(ist)
					t.Fatalf("Schritt %d: Leser\n%s\nstatt\n%s", i+1, a, s.ErwartetLesung)
				}
				if s.NurLesen {
					z.vorige = nil
				}
				if u := z.Nach(l); s.ErwartetLage == nil || u != *s.ErwartetLage {
					t.Fatalf("Schritt %d: Lage %+v statt %+v", i+1, u, s.ErwartetLage)
				}
			}
		})
	}
}

func TestSiegelPruefwert(t *testing.T) {
	w := []uint16{}
	b := []byte("123456789")
	// CRC über Bytes: das Verfahren selbst (Vertrag §8), ohne Wortgrenze
	c := uint16(0xFFFF)
	for _, x := range b {
		c ^= uint16(x)
		for i := 0; i < 8; i++ {
			if c&1 != 0 {
				c = c>>1 ^ 0xA001
			} else {
				c >>= 1
			}
		}
	}
	if c != 0x4B37 {
		t.Fatalf("Prüfwert %#x", c)
	}
	if got := Crc16(append(w, make([]uint16, 63)...)); got != 0x1AAB {
		t.Fatalf("63 Nullwörter: %#x", got)
	}
}
