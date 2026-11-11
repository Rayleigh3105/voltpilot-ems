package logs

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

func TestJSONFelderWieImBetriebsvertrag(t *testing.T) {
	var buf bytes.Buffer
	log := Neu(&buf, "json", nil).With("logger", "werkbank")
	log.With("request_id", "2026-11-02-090000-ab12").Warn("Schritt gescheitert", "schritt", "openwrt", "grund", "zwei Wörter")
	log.Debug("nicht sichtbar")
	zeilen := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(zeilen) != 1 {
		t.Fatalf("Zeilen: %q", zeilen)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(zeilen[0]), &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 5 || m["level"] != "WARN" || m["logger"] != "werkbank" || m["request_id"] != "2026-11-02-090000-ab12" ||
		m["message"] != `Schritt gescheitert schritt=openwrt grund="zwei Wörter"` || !strings.HasSuffix(m["@timestamp"].(string), "Z") {
		t.Fatalf("%v", m)
	}
	buf.Reset()
	Neu(&buf, "json", nil).Info("ohne Vorgang")
	if strings.Contains(buf.String(), "request_id") || !strings.Contains(buf.String(), `"logger":"werkstatt-dienst"`) {
		t.Fatalf("%s", buf.String())
	}
}

func TestTextUndSchwaerzen(t *testing.T) {
	var buf bytes.Buffer
	g := geheim.Neu("geheim-im-log-0815")
	defer g.Vergessen()
	log := Neu(&buf, "JSON", slog.LevelInfo) // groß geschrieben: bleibt Text
	log.WithGroup("box").Info("Ausgabe geheim-im-log-0815", "fehler", errors.New("mit geheim-im-log-0815"), "g", g, "zeilen", "a\nb")
	s := buf.String()
	if strings.HasPrefix(s, "{") || strings.Contains(s, "geheim-im-log") || !strings.Contains(s, "box.fehler=") || strings.Count(s, "\n") != 1 {
		t.Fatalf("%q", s)
	}
	if Format("json") != "json" || Format("text") != "text" || Format("yaml") != "text" {
		t.Fatal("Format")
	}
}
