// Package logs schreibt die Log-Zeilen des Dienstes auf stdout, als Text
// (Vorgabe) oder mit VOLTPILOT_LOGGING_FORMAT=json als eine JSON-Zeile je
// Ereignis, mit denselben Feldern wie die Dienste im Betriebsvertrag
// (docs/k8s-readiness.md, Abschnitt Logs): @timestamp, level, logger,
// message und request_id (hier: die Kennung des Laufs; fehlt ohne Lauf).
// Weitere Angaben stehen als schluessel=wert hinten in message.
//
// Jede Zeichenkette einer Zeile geht vor dem Schreiben durch den Schwärzer
// (internal/geheim). Ein Geheimnis kommt so auch dann nicht in eine Zeile,
// wenn eine Fehlermeldung oder eine Ausgabe der Box es zitiert.
package logs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Name ist der Logger-Name, wenn keiner gesetzt ist.
const Name = "werkstatt-dienst"

// Format liest VOLTPILOT_LOGGING_FORMAT: nur genau "json" schaltet um, jeder
// andere Wert bleibt bei Text (ein Tippfehler hindert den Dienst nicht am Start).
func Format(wert string) string {
	if wert == "json" {
		return "json"
	}
	return "text"
}

// Neu legt einen Logger an.
func Neu(w io.Writer, format string, level slog.Leveler) *slog.Logger {
	return slog.New(&handler{ausgabe: &ausgabe{w: w}, json: Format(format) == "json", level: level})
}

type ausgabe struct {
	mu sync.Mutex
	w  io.Writer
}

type handler struct {
	ausgabe *ausgabe
	json    bool
	level   slog.Leveler
	attrs   []slog.Attr
	gruppe  string
}

func (h *handler) Enabled(_ context.Context, l slog.Level) bool {
	min := slog.LevelInfo
	if h.level != nil {
		min = h.level.Level()
	}
	return l >= min
}

func (h *handler) WithAttrs(as []slog.Attr) slog.Handler {
	n := *h
	n.attrs = append(append([]slog.Attr(nil), h.attrs...), flach(h.gruppe, as)...)
	return &n
}

func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	n := *h
	if h.gruppe != "" {
		n.gruppe = h.gruppe + "." + name
	} else {
		n.gruppe = name
	}
	return &n
}

func flach(prefix string, as []slog.Attr) []slog.Attr {
	var out []slog.Attr
	for _, a := range as {
		a.Value = a.Value.Resolve()
		if a.Equal(slog.Attr{}) {
			continue
		}
		key := a.Key
		if prefix != "" {
			key = prefix + "." + key
		}
		if a.Value.Kind() == slog.KindGroup {
			out = append(out, flach(key, a.Value.Group())...)
			continue
		}
		out = append(out, slog.Attr{Key: key, Value: a.Value})
	}
	return out
}

func (h *handler) Handle(_ context.Context, r slog.Record) error {
	attrs := append([]slog.Attr(nil), h.attrs...)
	var rec []slog.Attr
	r.Attrs(func(a slog.Attr) bool { rec = append(rec, a); return true })
	attrs = append(attrs, flach(h.gruppe, rec)...)

	logger, vorgang := Name, ""
	var teile []string
	for _, a := range attrs {
		v := geheim.Schwaerze(wert(a.Value))
		switch a.Key {
		case "logger":
			logger = v
		case "request_id":
			vorgang = v
		default:
			teile = append(teile, a.Key+"="+zitiere(v))
		}
	}
	msg := geheim.Schwaerze(r.Message)
	if len(teile) > 0 {
		msg += " " + strings.Join(teile, " ")
	}
	zeit := r.Time
	if zeit.IsZero() {
		zeit = time.Now()
	}
	ts := zeit.UTC().Format("2006-01-02T15:04:05.000Z")
	var zeile []byte
	if h.json {
		obj := struct {
			Zeit    string `json:"@timestamp"`
			Level   string `json:"level"`
			Logger  string `json:"logger"`
			Message string `json:"message"`
			Vorgang string `json:"request_id,omitempty"`
		}{ts, stufe(r.Level), logger, msg, vorgang}
		b, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		zeile = append(b, '\n')
	} else {
		v := ""
		if vorgang != "" {
			v = " [" + vorgang + "]"
		}
		zeile = []byte(fmt.Sprintf("%s %-5s %s%s %s\n", ts, stufe(r.Level), logger, v, strings.ReplaceAll(msg, "\n", "\\n")))
	}
	h.ausgabe.mu.Lock()
	defer h.ausgabe.mu.Unlock()
	_, err := h.ausgabe.w.Write(zeile)
	return err
}

func wert(v slog.Value) string {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindTime:
		return v.Time().UTC().Format(time.RFC3339)
	case slog.KindAny:
		if e, ok := v.Any().(error); ok {
			return e.Error()
		}
		return fmt.Sprint(v.Any())
	default:
		return v.String()
	}
}

func zitiere(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\n\"=") {
		b, _ := json.Marshal(s)
		return string(b)
	}
	return s
}

func stufe(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "ERROR"
	case l >= slog.LevelWarn:
		return "WARN"
	case l >= slog.LevelInfo:
		return "INFO"
	case l >= slog.LevelDebug:
		return "DEBUG"
	default:
		return "TRACE"
	}
}
