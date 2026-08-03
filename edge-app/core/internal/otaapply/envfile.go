package otaapply

// Der Image-Hebel: dieselben `.env`-Schluessel, die `update.sh apply_image_pin`
// setzt (VP_EDGE_CORE_IMAGE / VP_EDGE_NODERED_IMAGE).
//
// **Der Sidecar erfindet keinen zweiten Mechanismus.** Er benutzt genau den
// Hebel, den der beaufsichtigte Weg seit Stufe 2 benutzt - damit ist ein
// autonom angewandter Stand von einem von Hand angewandten nicht zu
// unterscheiden, und ein Mensch kann jederzeit mit `update.sh` uebernehmen.
//
// Rein und ohne Docker: hier wird nur eine Textdatei umgeschrieben.

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// EnvKeyForComponent nennt den `.env`-Schluessel EINER Komponente.
func EnvKeyForComponent(name string) (string, error) {
	switch name {
	case "core":
		return "VP_EDGE_CORE_IMAGE", nil
	case "nodered":
		return "VP_EDGE_NODERED_IMAGE", nil
	default:
		return "", fmt.Errorf("fuer die Komponente '%s' gibt es keinen Image-Schluessel", name)
	}
}

// digestRefRe ist dieselbe strenge Form wie im Manifest: ein Tag waere kein
// Pin. Was hier durchkommt, landet in einer Datei UND in einer
// docker-Kommandozeile.
var digestRefRe = regexp.MustCompile(`^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$`)

// ValidDigestRef prueft eine Referenz, bevor sie in die `.env` geschrieben wird.
func ValidDigestRef(ref string) bool { return digestRefRe.MatchString(ref) }

// ReadEnv liest eine `.env` in eine Abbildung. Eine fehlende Datei ist eine
// leere Abbildung, kein Fehler (eine frische Box hat keine Pins).
func ReadEnv(path string) (map[string]string, error) {
	out := map[string]string{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return nil, err
	}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = v
	}
	return out, sc.Err()
}

// SetEnv setzt (oder loescht, bei leerem Wert) Schluessel in einer `.env`.
//
// Alles Uebrige bleibt ZEICHENGLEICH stehen - Kommentare, Reihenfolge,
// fremde Schluessel. Das ist wichtig: in dieser Datei stehen das Node-RED-
// Passwort und die Portal-Adresse des Kunden, und ein Updater, der sie
// umformatiert, waere ein Datenverlust-Risiko ohne jeden Nutzen.
//
// Geschrieben wird tmp+rename mit 0600 (wie `update.sh env_set_pin`).
func SetEnv(path string, kv map[string]string) error {
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	var buf bytes.Buffer
	written := map[string]bool{}
	if len(existing) == 0 {
		buf.WriteString("# VoltPilot Edge-App - von vp-edge-updater angelegt (nur Image-Pin).\n")
	}
	sc := bufio.NewScanner(bytes.NewReader(existing))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		replaced := false
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			if k, _, ok := strings.Cut(trimmed, "="); ok {
				key := strings.TrimSpace(k)
				if v, want := kv[key]; want {
					replaced = true
					written[key] = true
					if v != "" {
						buf.WriteString(key + "=" + v + "\n")
					}
				}
			}
		}
		if !replaced {
			buf.WriteString(line + "\n")
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	// Neue Schluessel stabil sortiert anhaengen, damit zwei Laeufe mit
	// derselben Absicht dieselbe Datei erzeugen.
	var fresh []string
	for k, v := range kv {
		if !written[k] && v != "" {
			fresh = append(fresh, k)
		}
	}
	sort.Strings(fresh)
	for _, k := range fresh {
		buf.WriteString(k + "=" + kv[k] + "\n")
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".env.vp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
