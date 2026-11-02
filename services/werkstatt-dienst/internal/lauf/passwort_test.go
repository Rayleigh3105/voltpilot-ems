package lauf_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// boxAttrappe ist eine Box, die ein Passwort über die Standardeingabe nimmt
// (wie passwd) und – wie es eine echte Ausgabe tun könnte – zurückgibt.
type boxAttrappe struct{ empfangen bytes.Buffer }

func (b *boxAttrappe) passwd(ein io.Reader) string {
	_, _ = io.Copy(&b.empfangen, ein)
	z := strings.SplitN(b.empfangen.String(), "\n", 2)[0]
	return "New password: " + z + "\nRetype password: " + z + "\npasswd: password for root changed by root"
}

// Ein bekanntes Passwort geht durch einen ganzen Lauf: als Geheimnis erzeugt,
// über die Standardeingabe an die Box gegeben, von der Box zurückgegeben, als
// Log-Angabe, in einer Fehlermeldung, im Beleg. Danach steht es weder in einer
// Log-Zeile (Text und JSON) noch im Protokoll (Belege) noch in den Metriken –
// angekommen ist es aber bei der Box.
func TestBekanntesPasswortStehtNieInLogOderBeleg(t *testing.T) {
	const bekannt = "Kq7v-Rt9w-Zx3m-Hb2n" // 19 Zeichen, sicher länger als geheim.MindestLaenge
	for _, format := range []string{"text", "json"} {
		t.Run(format, func(t *testing.T) {
			var logbuf bytes.Buffer
			log := logs.Neu(&logbuf, format, nil)
			dir := t.TempDir()
			ablage, err := protokoll.NeueAblage(dir)
			if err != nil {
				t.Fatal(err)
			}
			reg := metriken.Neu()
			r := lauf.NeuerLaeufer(ablage, log, reg)
			box := &boxAttrappe{}
			pw := geheim.Neu(bekannt)
			defer pw.Vergessen()

			l := lauf.Neu(time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC), "2026-11-mango-1", "mango")
			schritte := []lauf.Schritt{
				{Kennung: "passwort", Titel: "Root-Passwort setzen", Tun: func(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
					aus := box.passwd(strings.NewReader(pw.Offenbaren() + "\n" + pw.Offenbaren() + "\n"))
					// Unvorsichtiger Code: das Geheimnis als Angabe und als Wert im Text.
					k.Log.Info("Passwort gesetzt", "passwort", pw, "roh", fmt.Sprintf("%v/%s/%q/%+v", pw, pw, pw, struct{ P geheim.Geheim }{pw}))
					k.Log.Info("Ausgabe der Box: " + aus)
					return protokoll.Beleg{}.Mit("ausgabe", aus).Mit("passwort", pw.String()), nil
				}},
				{Kennung: "notfall", Titel: "Notfall-Schlüssel", Tun: func(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
					// Eine Fehlermeldung, die das Passwort im Klartext zitiert.
					return protokoll.Beleg{}.Mit("ausgabe", "ssh: Permission denied für "+bekannt),
						errors.New("Anmeldung mit " + bekannt + " abgewiesen")
				}},
			}
			if z := r.Fahre(context.Background(), l, map[string]string{"hinweis": "kein " + bekannt}, schritte); z != lauf.Angehalten {
				t.Fatalf("Zustand %s, erwartet angehalten", z)
			}
			if !strings.Contains(box.empfangen.String(), bekannt) {
				t.Fatal("das Passwort ist nicht bei der Box angekommen: der Test prüft dann nichts")
			}

			var mbuf bytes.Buffer
			_ = reg.Schreibe(&mbuf)
			var proto bytes.Buffer
			_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
				if err == nil && !d.IsDir() {
					b, _ := os.ReadFile(p)
					proto.Write(b)
				}
				return nil
			})
			stand := fmt.Sprintf("%+v", l.Stand())
			for name, inhalt := range map[string]string{"Log": logbuf.String(), "Protokoll": proto.String(), "Metriken": mbuf.String(), "Stand": stand} {
				if strings.Contains(inhalt, bekannt) {
					t.Errorf("%s enthält das Passwort:\n%s", name, inhalt)
				}
				// Teilstücke einer Zeile zählen auch: kein Viertel des Passworts.
				if strings.Contains(inhalt, bekannt[:10]) {
					t.Errorf("%s enthält einen Teil des Passworts", name)
				}
			}
			if !strings.Contains(logbuf.String(), geheim.Ersatz) || !strings.Contains(proto.String(), geheim.Ersatz) {
				t.Errorf("der Ersatz %q fehlt: wurde überhaupt geschwärzt?\nLog:\n%s\nProtokoll:\n%s", geheim.Ersatz, logbuf.String(), proto.String())
			}
			if proto.Len() == 0 || !strings.Contains(proto.String(), `"art":"schritt_belegt"`) {
				t.Fatalf("Protokoll leer oder ohne Beleg:\n%s", proto.String())
			}
		})
	}
}
