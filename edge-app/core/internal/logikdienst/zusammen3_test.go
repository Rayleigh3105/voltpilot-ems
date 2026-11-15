package logikdienst

// Die Übersetzungen des dritten Teils von Stufe 6 am Dienst: die Verbraucherregel einer Steuerart
// (POST /aus-steuerart) und der Heizstab-Regler aus seinem Parameterblock (POST /aus-heizstab),
// je mit dem, was die API daraus baut: das scharfe Artefakt.

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// steuerartDokument ist die generierte Verbraucherregel einer Steuerart „Solar-Überschuss“ für die
// Pumpe der Anlage (wie ConsumerPolicyCompiler sie baut); mustRun macht sie zur Pflichtregel.
func steuerartDokument(mustRun bool) json.RawMessage {
	pflicht := "false"
	if mustRun {
		pflicht = "true"
	}
	return json.RawMessage(`{"schema_version":"1.0","flow_id":"0d9c3c1e-5b7a-3f4e-9a61-2f0c8a7b6d51","flow_version":3,
	 "name":"Verbraucherregel: Pumpe","runtime":"edge",
	 "origin":{"kind":"consumer-policy","policy_id":"7c1e0c9a-0000-4000-8000-000000000001","policy_version":3,
	  "entity_id":"44444444-4444-4444-8444-444444444444"},
	 "nodes":[{"id":"reaktiv","type":"vp.consumer.reactive","type_version":"1.0.0","label":"Reaktive Regeln: Pumpe",
	  "parameters":{"entity_id":"44444444-4444-4444-8444-444444444444","command":"on_off","ttl_s":45,"renew_s":15,
	   "off_delay_s":15,"requirements":[{"id":"ueberschuss","must_run":` + pflicht + `,"value":true,
	    "condition":{"signal":"site.pv_surplus_kw","source":"site","channel":"pv_surplus_kw","op":"gt","value":1.5,
	     "reset_value":1.125,"max_age_s":120}}]},
	  "claims":[{"entity_id":"44444444-4444-4444-8444-444444444444","commands":["on_off"]}]}],
	 "edges":[],"triggers":[{"id":"tick","kind":"interval","every_s":15}]}`)
}

func post(t *testing.T, srv *httptest.Server, pfad string, auftrag any) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(auftrag)
	res, err := http.Post(srv.URL+pfad, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var antwort map[string]any
	_ = json.NewDecoder(res.Body).Decode(&antwort)
	return res.StatusCode, antwort
}

func TestAusSteuerartUebersetztUndBautDasScharfeArtefakt(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	for _, pflicht := range []bool{false, true} {
		status, a := post(t, srv, "/aus-steuerart", SteuerartAuftrag{Dokument: steuerartDokument(pflicht),
			Name: "Verbraucherregel: Pumpe", Fassung: 3, Registry: regelRegistry()})
		if status != http.StatusOK || a["uebersetzt"] != true || a["pflicht"] != pflicht {
			t.Fatalf("Pflicht %v: Status %d, %v", pflicht, status, a)
		}
		text := a["text"].(string)
		if !strings.Contains(text, "source: site.surplus") || !strings.Contains(text, "name: Pumpe") {
			t.Fatalf("Text:\n%s", text)
		}
		if strings.Contains(text, "must_run") != pflicht {
			t.Fatalf("must_run nur bei einer Pflichtregel:\n%s", text)
		}
		// Das Artefakt: mit Pflicht nur, wenn die API sie erlaubt.
		auftrag := Auftrag{Text: text, Registry: regelRegistry(), FlowID: "8f1e6b2a-1111-4111-8111-000000000001",
			FlowVersion: 1, Armed: true}
		_, _, err := Artefakt(auftrag)
		if pflicht && !errors.Is(err, ErrSperrt) {
			t.Fatalf("Pflicht ohne Erlaubnis muss die Prüfung sperren: %v", err)
		}
		auftrag.Pflicht = pflicht
		art, _, err := Artefakt(auftrag)
		if err != nil {
			t.Fatalf("Artefakt: %v", err)
		}
		var x struct {
			Required []struct {
				Capabilities []string `json:"capabilities"`
			} `json:"required_entities"`
		}
		_ = json.Unmarshal(art, &x)
		if len(x.Required) != 1 || strings.Join(x.Required[0].Capabilities, ",") != "actuate:on_off" {
			t.Fatalf("das scharfe Artefakt verlangt Ein/Aus: %s", art)
		}
	}
	status, a := post(t, srv, "/aus-steuerart", SteuerartAuftrag{Dokument: json.RawMessage(`{"nodes":[],"origin":{"kind":"x"}}`)})
	if status != http.StatusUnprocessableEntity || a["grund"] != "steuerart" {
		t.Fatalf("kein generierter Flow: Status %d, %v", status, a)
	}
}

func TestAusSteuerartNenntGruende(t *testing.T) {
	doc := strings.Replace(string(steuerartDokument(false)), `"source":"site","channel":"pv_surplus_kw"`,
		`"source":"entity","channel":"available"`, 1)
	e, err := AusSteuerart(SteuerartAuftrag{Dokument: json.RawMessage(doc), Registry: regelRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	if e.Uebersetzt || len(e.Gruende) != 1 || e.Gruende[0].Code != "messwert" {
		t.Fatalf("ein Signal des Geräts liest die Box nicht: %+v", e)
	}
}

func heizstabBlock(t *testing.T) json.RawMessage {
	return json.RawMessage(`{"modus":"ueberschuss","vorrang":"heizstab_zuerst","mindestlauf_s":600}`)
}

func TestAusHeizstabUebersetztUndBautDasScharfeArtefakt(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	status, a := post(t, srv, "/aus-heizstab", HeizstabAuftrag{Entity: "33333333-3333-4333-8333-333333333333",
		Block: heizstabBlock(t), Registry: regelRegistry()})
	if status != http.StatusOK || a["uebersetzt"] != true {
		t.Fatalf("Status %d, %v", status, a)
	}
	text := a["text"].(string)
	for _, soll := range []string{"default: heizstab_zuerst", "default: 600 s", "frei * 1.000001 >= 3 kW",
		"source: \"33333333-3333-4333-8333-333333333333.power\"", "name: \"Heizstab-Regler: Heizstab\""} {
		if !strings.Contains(text, soll) {
			t.Fatalf("„%s“ fehlt:\n%s", soll, text)
		}
	}
	art, _, err := Artefakt(Auftrag{Text: text, Registry: regelRegistry(), FlowID: "8f1e6b2a-1111-4111-8111-000000000002",
		FlowVersion: 1, Armed: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(art), `"actuate:setpoint_kw"`) {
		t.Fatalf("eine Stufe an der Ausgangsmenge schaltet die Box mit setpoint_kw: %s", art)
	}
	for _, f := range []struct {
		auftrag HeizstabAuftrag
		code    string
	}{
		{HeizstabAuftrag{Entity: "99999999-9999-4999-8999-999999999999", Block: heizstabBlock(t), Registry: regelRegistry()}, "geraet"},
		{HeizstabAuftrag{Entity: "33333333-3333-4333-8333-333333333333", Block: json.RawMessage(`{"modus":"ueberschuss","reserve_kw":-1}`), Registry: regelRegistry()}, "block"},
		{HeizstabAuftrag{Entity: "44444444-4444-4444-8444-444444444444", Block: heizstabBlock(t), Registry: regelRegistry()}, "stufen"},
		{HeizstabAuftrag{Entity: "33333333-3333-4333-8333-333333333333", Block: json.RawMessage(`{"modus":"aus"}`), Registry: regelRegistry()}, "modus"},
	} {
		e, err := AusHeizstab(f.auftrag)
		if err != nil {
			t.Fatal(err)
		}
		if e.Uebersetzt || len(e.Gruende) == 0 || e.Gruende[0].Code != f.code {
			t.Errorf("erwartet Grund %s: %+v", f.code, e.Gruende)
		}
	}
}

// Die Antworten des Dienstes, gepinnt für API und Portal.
func TestZusammen3GepinnteAntworten(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	for _, f := range []struct {
		pfad, datei string
		auftrag     any
	}{
		{"/aus-steuerart", "steuerlogik-aus-steuerart.valid.pumpe.json", SteuerartAuftrag{Dokument: steuerartDokument(false),
			Name: "Verbraucherregel: Pumpe", Fassung: 3, Registry: regelRegistry()}},
		{"/aus-heizstab", "steuerlogik-aus-heizstab.valid.heizstab.json", HeizstabAuftrag{Entity: "33333333-3333-4333-8333-333333333333",
			Block: json.RawMessage(`{"modus":"ueberschuss","vorrang":"speicher_zuerst"}`), Registry: regelRegistry()}},
	} {
		_, antwort := post(t, srv, f.pfad, f.auftrag)
		roh, _ := json.MarshalIndent(antwort, "", "  ")
		roh = append(roh, '\n')
		pfad := "../../../../docs/contracts/v2/examples/" + f.datei
		if os.Getenv("VP_FIXTURES_SCHREIBEN") == "1" {
			if err := os.WriteFile(pfad, roh, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		alt, err := os.ReadFile(pfad)
		if err != nil {
			t.Fatalf("%v (VP_FIXTURES_SCHREIBEN=1 schreibt sie)", err)
		}
		if string(alt) != string(roh) {
			t.Fatalf("%s ist nicht die Antwort des Dienstes; VP_FIXTURES_SCHREIBEN=1 schreibt sie neu", pfad)
		}
	}
}
