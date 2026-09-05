# Eine Saeule kann auf einem EIGENEN Anschluss haengen (Cockpit Phase 1 / C1)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 84).


Konzept `data/vp-verbraucher-cockpit-k1` §8.4 Punkt 5, Captain-Entscheid E5.
Das Budget-Gesetz `budget = planbar - (Netzbezug - Ladeleistung)` gilt nur
HINTER dem Haus; eine Saeule mit eigenem Zaehler war bis hierher nicht
unterscheidbar und wurde deshalb faelschlich zurueckaddiert. Repo-weite Regeln
in `../AGENTS.md` „Cockpit Phase 1 / C1"; die Box-Seite in vier Punkten:

- **`csms.Charger.Connection`** (`ConnectionHaus`/`ConnectionEigen`) kommt
  AUSSCHLIESSLICH aus dem retained Konfigurations-Dokument — auf `:8484` gibt es
  dafuer keine Oberflaeche. Nie den rohen String vergleichen: `ConnectionOrHaus()`
  loest ihn auf, `OwnConnection()` fragt ihn. **Leer heisst `haus`** (die
  PATCH-Semantik und die sichere Lesart in einem).
- **⚠ `Snapshot.ChargingTotal` UEBERSPRINGT eine Saeule auf eigenem Anschluss** —
  sie war nie in der Netzmessung, kann die Summe also auch nicht unvollstaendig
  machen (`complete` bleibt unberuehrt). Das ist der EINE Rueckaddier-Ort, den
  `agent/ocpp.go` und `agent/ocpp_surplus.go` teilen; wer einen zweiten baut,
  baut das Loch neu.
- **⚠ `applyChargePoints` zieht den Anschluss auch auf einer SCHON BEKANNTEN
  Saeule nach** — die einzige Ausnahme von der Nie-ueberschreiben-Regel, weil es
  auf der Box nichts zu schuetzen gibt. Sagt das Portal nichts (`""`) oder
  dasselbe wie bisher, passiert GAR NICHTS (kein Schreibvorgang, kein Log je
  Zustellung des retained Dokuments).
- **⚠ Ein unbekanntes Wort ueberspringt den EINTRAG** (`chargingcfg.Parse`) und
  wird beim Anlegen abgelehnt (`csms.NormalizeAdd`) — nie auf `haus` aufgeloest:
  waere die Wahrheit `eigen`, fiele das Budget zu GROSS aus. Die Vorsicht liegt
  also im Ueberspringen; eine bekannte Saeule behaelt dann, was sie hat.
- Beweise: `internal/chargingcfg` (die Kontrakt-Fixture PER PFAD),
  `internal/csms/chargingtotal_test.go` (der Skip, und „ohne Angabe zaehlt es
  exakt wie vorher"), `agent/charging_config_test.go`.

