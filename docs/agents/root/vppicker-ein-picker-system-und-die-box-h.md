# VpPicker: EIN Picker-System, und die Box hat seine Vanilla-Fassung

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 23).


Konzept `data/vp-picker-system` (Captain-genehmigt 21.08.2026: „alle Picker … eigene Komponenten
erstellen wo man drin suchen kann. Ich will nichts Browser-Standard-Zeug. Bitte in der kompletten
Plattform umsetzen."), drei Wellen. Welle 1 baute die Portal-Basis (`frontend/portal/src/components/
VpPicker.tsx` + die reinen Regeln in `src/picker/*`), Welle 2 tauschte alle restlichen
Portal-Auswahl- und Datums-/Zeitfelder durch, **Welle 3 die `:8484`-Seiten der Box**. Seither trägt
weder das Portal noch die Box ein natives `<select>`, `type=date` oder `type=time`.

- **Die Box hat KEIN React und keine Bau-Kette** (`static/*` kommt direkt aus `//go:embed`), also ist
  ihr Picker eine eigenständige Vanilla-Fassung DERSELBEN Anatomie: `pickerregeln.js`
  (`window.VPPickerRegeln`, die reinen Regeln — Filtern, Gruppieren, Tastatur-Arithmetik, Ansage),
  `vppicker.js` (`window.VPPicker`, die Fläche) und `vppicker.css`. **Sie teilen KEINEN Code mit dem
  Portal** (verschiedene Laufzeiten), aber dieselben REGELN — derselbe Mensch bedient beide Flächen,
  und eine Liste, die auf der Box anders auf Pfeiltaste und Tippen reagiert als im Portal, ist genau
  der Bruch, den ein Picker-SYSTEM verhindern soll. **Wer die Regeln ändert, ändert beide Seiten.**
- **⚠ Die SUCH-TOLERANZ hat je Laufzeit genau EINE Quelle** — im Portal `src/picker/suche.ts`, auf
  der Box `modellsuche.js` (`pickerregeln.js` holt sie sich von dort). Eine zweite Toleranz auf
  derselben Fläche fände dieselbe Eingabe anders.
- Was die Box-Fassung im Einzelnen kann und welche vier Fallen sie kostete (Panel an `body`,
  Vorwahl wie ein `<select>`, Beschriftung erst beim Montieren, Wert im `data-value` statt in einem
  versteckten Feld): `edge-app/AGENTS.md` „DER PICKER DER BOX". Die always-open Modell-Liste des
  Wechselrichter-Formulars (`.picker*`) bleibt daneben bestehen — sie ist der dauerhaft offene
  primäre Weg zum Modell, kein Ausklapp-Feld.
- **Beweise:** Portal `VpPicker.test.tsx`/`src/picker/*.test.ts` · Box `jstest/ui.test.js` (+20,
  darunter der mutationsgeprüfte Wächter „Die Einrichten-Seite trägt KEIN natives Auswahlfeld mehr")
  + `web_test.go` (Montagepunkte, Skripte und Stile sind gepinnt — ohne sie bliebe die Auswahl still
  leer). Im echten Chrome bei 1440 und 375 durchgespielt: Bottom-Sheet, Tastatur-Durchstich ohne
  Maus, 0 px horizontaler Überlauf, 0 überstehende Elemente.
- **Edge-Änderung ⇒ sie reist mit dem nächsten Edge-Release** (eine laufende Box behält ihr Image).

