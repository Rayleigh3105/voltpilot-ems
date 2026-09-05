# FAHRZEUG-PROFILE: die Karte bringt ihre eigene Quellen-Bahn mit (P7)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 88).


Modell und Kontrakt stehen im Root-`CLAUDE.md` („Paket 7"). Hier die Box-Hälfte.

- **Es gibt KEINE neue Regel im Verteiler, und das ist der ganze Trick.**
  `lastmgmt.Session.Source`/`MinKw` waren schon je SITZUNG, und jede Regel dahinter fragt die
  SITZUNG statt der Station (`sessionPolicy`, `splitExempt`, `allowsMinimum`, `effectiveMin`).
  Die Station ist nur, was `ocppSessions` als Vorgabe hineinkopiert.
  `ocppApplyVehicleProfiles` (rein, `agent/ocpp_vehicle.go`) tauscht genau diese Vorgabe —
  Budget, Rotation, Mindestleistungs-Zugeständnis, Totmann und die K3-Brücke binden eine
  Zeile weiter unten unverändert.
- **⚠ Der Schlüssel ist der EIGENE Pseudonym der Box.** `csms.Session.TagRef` entsteht GENAU
  EINMAL bei `StartTransaction`, in der einen Komponente, die den Schlüssel hält; alles
  dahinter liest ihn statt des Klartexts (der Herzschlag meldet ihn, die Sitzungs-Bahn wird
  damit gesucht). Eine zweite Stelle, die einen IdTag hasht, wäre eine zweite Antwort auf
  dieselbe Frage — und beim ersten Auseinanderlaufen träfe das Profil eines Kunden still
  nicht mehr. **Der Bezug des OCPP-JOURNALS in der Cloud ist ein ANDERER Wert** (dort wird
  ein zweites Mal gepfeffert); ein daraus genommener Schlüssel trifft hier nie etwas.
- **⚠ Eine Sitzung OHNE Karte behält die Bahn der Säule.** Kein Vorgabe-Profil, kein
  „Standard-Fahrzeug": eine unbekannte Karte ist ein Kunde, der nicht entschieden hat.
  `min_kw` = 0 heißt „das Profil äußert sich nicht" und nimmt einer Säule ihre gepflegte
  Mindestleistung nie weg; ein Doppel-Eintrag gewinnt beim ERSTEN (Reihenfolge darf das
  Ergebnis nicht bestimmen).
- **Der Simulator kann seit P7 je Wagen eine KARTE zeigen** (`ocppsim.Vehicle.IdTag`,
  `POST /plug?…&tag=`). Leer = die eine Rig-Karte `RIG-TAG`, also verhalten sich alle
  Vor-P7-Fälle byte-gleich.
- **Beweise:** `agent/ocpp_vehicle_test.go` (8) ·
  `agent/ocpp_heartbeat_test.go TestTheHeartbeatCarriesThePseudonymAndNeverThePlaintextCard`
  (auf den SERIALISIERTEN Bytes, nicht auf einem Feld — ein künftiges Feld, das den IdTag
  trüge, käme durch eine Feld-Prüfung durch) · `internal/chargingcfg` (die drei Fixturen PER
  PFAD) · **Rig `test/e2e-ocpp.sh` L16a–d**: zwei Karten, zwei Steuerarten am selben
  Ladepark — und wenn die Wagen die PLÄTZE tauschen, wandert die Ladung mit der KARTE.

