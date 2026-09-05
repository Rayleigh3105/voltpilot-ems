# Wer etwas ANDERES entwertet, nennt die Folge VORHER (`static/consequences.js`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 48).


Die Nebenwirkungs-Regel des Settings-Umbaus (E3; Ist-Analyse
`firstmate/data/vp-settings-ux-konzept/report.md` §4 „Wunde 2"): ein Bedienelement,
das anderswo einen **freigegebenen, bestätigten oder aufgezeichneten** Zustand
entwertet, nennt genau diese Folge in seiner eigenen Rückfrage - vorher.
Ausgelöst hatte es die Kalibrier-Korrektur: „Steuer-Vorzeichen umkehren" nahm die
Steuerungs-Freigabe zurück (`agent/calibration.go CalibrationCorrection`:
`ResetConfirmations` + `delete(a.calCert, family)`), ohne es zu sagen - fachlich
richtig, denn nach einer Vorzeichenänderung ist der Beweis wertlos, aber der
Knopf sagte nur „umkehren", und ohne Freigabe steuert der Fahrplan diesen
Wechselrichter nicht mehr.

`static/consequences.js` (`window.VPConsequences`) ist die EINE, reine
Textschicht dafür (kein DOM, kein fetch, kein Zustand); `ask()` ist die einzige
Stelle, an der daraus eine Rückfrage wird (`window.confirm`, das Bestandsmuster
aus `sources.js`). Regeln, die halten müssen:

- **Kein Text ⇒ keine Rückfrage.** Entwertet eine Aktion nachweislich nichts,
  liefert der Builder `null` und die Aktion läuft byte-gleich wie vorher durch -
  ein Dialog ohne Folge wäre Lärm, einer mit erfundener Folge eine Lüge.
- **⚠ Die Freigabe hat ZWEI Hälften, und nur EINE wird zurückgenommen.**
  `Snapshot.Certified` ist die VEREINIGUNG aus der flottenweiten Allowlist
  (`VP_CONTROL_CERTIFIED_FAMILIES`, per Default `sunspec` - und `sunspec` IST
  kalibrierbar) und der auf diesem Gerät per First-Light erteilten Freigabe;
  Korrektur und „Freigabe zurücknehmen" entfernen nur die zweite. Jede Aussage
  über eine Rücknahme keyt deshalb auf das additive
  **`Snapshot.DeviceCertified`** (`json:"device_certified"`,
  `agent.deviceCertified`), nie auf `certified`. Live nachgemessen: mit gesetzter
  Allowlist blieb `certified` nach der Korrektur wahr - die erste Fassung des
  Dialogs hätte dort eine Rücknahme versprochen, die ausbleibt.
- **Zwei Wege an dieselben Werte.** Das Wechselrichter-Formular
  (`inverter.js`) bearbeitet Vorzeichen/Leistungsskalierung/Schreib-Funktionscode/
  Fernsteuerung ebenfalls - dort setzt der Server aber NICHTS zurück. Deshalb
  unterscheidet `inverterChange` ehrlich: Modellwechsel = die Freigabe gilt für
  das bisherige Modell (Fahrplan steuert nicht mehr), gleiche Familie mit
  geänderten Steuerwerten = die Freigabe BLEIBT, ihr Nachweis ist nur veraltet.
  Dass ein Familienwechsel die Freigabe nicht mitnimmt, ist eine Beobachtung
  über den Bestand, keine Änderung daran - Backend unangetastet.
- Weitere Aufrufer: `calibration.js` (drei Korrekturen + „Freigabe
  zurücknehmen"), `curtail.js` (Abregelungs-Freigabe je Einheit), `sources.js`
  (eine freigegebene Fronius-Quelle zu löschen beendet ihre Abregelung).
- **`consequences.js` muss VOR seinen Konsumenten geladen werden**
  (`einrichten.html`); `static/*` ist `//go:embed`-ed - Kern nach jeder Änderung
  neu bauen.
- Beweise: `internal/web/jstest/ui.test.js` (reine Texte inkl. der
  Zwei-Hälften-Regel PLUS ein Klick-Test gegen den ECHTEN `calibration.js`-Pfad:
  Abbrechen POSTet nichts, Bestätigen führt aus, nicht-entwertende Knöpfe fragen
  nie) und `internal/web` `TestDevaluingActionsAskBeforeActing` (Struktur-Wächter:
  Modul wird ausgeliefert, Ladereihenfolge stimmt, jede entwertende Aufrufstelle
  fragt). Gegen das echte Binary nachgemessen (Deye hybrid_3p, `:8484`):
  Allowlist-Freigabe → keine Behauptung; First-Light-Freigabe → Abbrechen ändert
  am Server nichts, Bestätigen kippt das Vorzeichen UND leert
  `calibration-certified.json`.

