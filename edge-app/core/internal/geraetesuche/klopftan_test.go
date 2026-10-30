package geraetesuche

import (
	"bytes"
	"encoding/json"
	"net/netip"
	"testing"
)

type klopftAnVektoren struct {
	Grenzen struct {
		FensterH     int `json:"fenster_h"`
		MaxEintraege int `json:"max_eintraege"`
		MaxVersuche  int `json:"max_versuche"`
	} `json:"grenzen"`
	BoxAdressen []string `json:"box_adressen"`
	Lesen       []struct {
		Name  string `json:"name"`
		Block struct {
			Rejected json.RawMessage `json:"rejected"`
		} `json:"block"`
		Erwartet *[]struct {
			ID string  `json:"id"`
			IP *string `json:"ip"`
		} `json:"erwartet"`
		SchemaLehntAb bool `json:"schema_lehnt_ab"`
	} `json:"lesen"`
}

func TestKlopftAnIstZwillingDesSchemas(t *testing.T) {
	var s struct {
		Defs map[string]schema `json:"$defs"`
	}
	lade(t, "ocpp-klopft-an.schema.json", &s)
	alle, pflicht := felder(KlopftAn{})
	gleicheMenge(t, "klopft-an properties", schluessel(s.Defs["eintrag"].Properties), alle)
	gleicheMenge(t, "klopft-an required", s.Defs["eintrag"].Required, pflicht)
}

// The box sends only what the cloud would read without skipping anything.
func TestKlopftAnWieDieBoxEsSendet(t *testing.T) {
	var v klopftAnVektoren
	lade(t, "ocpp-klopft-an-vectors.json", &v)
	if v.Grenzen.FensterH != int(KlopftAnFenster.Hours()) || v.Grenzen.MaxEintraege != MaxKlopftAn ||
		v.Grenzen.MaxVersuche != MaxKlopftAnVersuche {
		t.Fatalf("grenzen %+v", v.Grenzen)
	}
	var box []netip.Addr
	for _, a := range v.BoxAdressen {
		box = append(box, netip.MustParseAddr(a))
	}
	geprueft := 0
	for _, c := range v.Lesen {
		if len(c.Block.Rejected) == 0 || c.Block.Rejected[0] != '[' {
			continue // absent or no list: unknown, nothing the box sends
		}
		var roh []map[string]any
		if err := json.Unmarshal(c.Block.Rejected, &roh); err != nil {
			t.Fatal(err)
		}
		// Sendable exactly when the reader keeps every entry with its address.
		vollstaendig := !c.SchemaLehntAb && c.Erwartet != nil && len(*c.Erwartet) == len(roh)
		for i := 0; vollstaendig && i < len(roh); i++ {
			e := (*c.Erwartet)[i]
			ip, _ := roh[i]["ip"].(string)
			vollstaendig = e.ID == roh[i]["id"] && ((e.IP == nil && ip == "") || (e.IP != nil && *e.IP == ip))
		}
		var eintraege []KlopftAn
		dec := json.NewDecoder(bytes.NewReader(c.Block.Rejected))
		dec.DisallowUnknownFields()
		err := dec.Decode(&eintraege)
		if err == nil {
			err = PruefeKlopftAn(eintraege, box)
		}
		if (err == nil) != vollstaendig {
			t.Fatalf("%s: sendable=%v (%v), want %v", c.Name, err == nil, err, vollstaendig)
		}
		geprueft++
	}
	if geprueft < 6 {
		t.Fatalf("only %d cases checked", geprueft)
	}
	if err := PruefeKlopftAn(nil, box); err == nil {
		t.Fatal("a nil list marshals as null")
	}
	viele := make([]KlopftAn, MaxKlopftAn+1)
	if err := PruefeKlopftAn(viele, box); err == nil {
		t.Fatal("17 entries accepted")
	}
}
