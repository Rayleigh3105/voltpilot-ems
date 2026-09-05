# Stufe 4: „Jetzt voll laden" kommt als EINMAL-Freigabe aus dem Portal (`internal/chargingboost`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 75).


Der Konsument von `ems/{t}/{s}/{d}/v2/charging-boost` (Kontrakt
`docs/contracts/mqtt-charging-boost.schema.json`). Er fügt **keinen neuen
Mechanismus** hinzu: er ruft `Agent.OcppBoost` — genau das, was die
`:8484`-Taste ruft.

- **⚠ NICHT-RETAINED, und `requested_at` ist die zweite Hälfte.** Eine retained
  Übersteuerung würde bei JEDEM Verbindungsaufbau erneut zugestellt und wäre
  keine Einmal-Freigabe; weil die Box eine DAUERHAFTE Sitzung hält, darf der
  Broker sie zusätzlich nachliefern — also übernimmt die Box den Stempel als
  Beginn ihres Fensters (`chargingboost.Window`, 2 min) statt des
  Empfangs-Zeitpunkts. Eine nachgelieferte Freigabe ist bei der Ankunft
  ABGELAUFEN und wird abgelehnt statt ausgeführt (das OTA-Apply-Muster).
- **Vier Ablehnungen, alle stumm zum Broker und laut im Protokoll:** fremde
  Identität (Topic == Payload), abgelaufenes Fenster, fremde Vertragsversion,
  unlesbare Bytes. `ExpiredMessage` nennt BEIDE Uhren — eine auseinander
  gelaufene Uhr ist sonst strukturell unsichtbar.
- **Die POLITIK bleibt auf der Box:** ob es diesen Stecker gibt, ob dort eine
  Sitzung läuft und wie lange die Freigabe höchstens gilt
  (`lastmgmt.BoostMaxDuration`, 4 h), entscheidet `Agent.OcppBoost` — die Cloud
  nennt nur Stecker, Wunsch und Dauer. `cancel: true` nimmt sie zurück.
- **⚠ SEIT P3b TRÄGT DERSELBE UMSCHLAG ZWEI RICHTUNGEN** (`action: voll|pause`,
  Entscheid E5): `pause` = „Laden pausieren", der Session-Deckel 0. Es ist
  KEIN zweiter Mechanismus - dieselbe `Agent.OcppBoost`, dieselbe
  Transaktions-Bindung, dieselbe Rücknahme (`cancel` gilt beiden). Im Speicher
  hält `boostStore` je Stecker EINE Zuweisung MIT ihrer Richtung, die zwei
  können sich also nie überlagern; `ocppApplyBoosts` stempelt daraus entweder
  `Session.BoostUntil` oder `Session.PauseUntil`.
  - **ABWESEND heißt `voll`** (`chargingboost.Parse`) - die
    Kompatibilitäts-Zusage: eine Cloud vor P3b erteilt exakt den Boost von
    vorher. Ein UNBEKANNTES Wort verwirft die GANZE Nachricht: die sichere
    Richtung ist hier weder „voll" (schaltete etwas ein) noch „pause"
    (stoppte etwas), also gar nichts.
  - **Der Grund heißt `handeingriff`** (`lastmgmt.ReasonManual`) und wird in
    `Decide` VOR dem K3-Deckel geprüft - beide pausieren nur, die Reihenfolge
    entscheidet also allein das WORT, und ein Stopp des Kunden muss nach ihm
    benannt sein.
  - **`:8484` ZEIGT die Pause und bietet den RÜCKWEG, nie die Pause selbst**
    (`state.OcppConnector.HandPaused` → `ocpp.js` `handPaused`; der
    Zustands-Satz kommt aus dem durchgereichten `reason_text`). Pausieren ist
    eine Portal-Handlung - eine zweite lokale Tür bräuchte eine zweite
    Folgen-Karte und einen zweiten Bestätigungs-Text.
- Beweise: `internal/chargingboost` (die Form + die drei Kontrakt-Fixtures per
  PFAD) · `agent/charging_boost_test.go` (der Durchlauf durch den GETEILTEN
  Kern, die vier Ablehnungen, die Rücknahme; P3b: pausiert und gibt zurück,
  der Nachbar bleibt unberührt, Abstecken beendet und das nächste Fahrzeug
  erbt nicht, ein Umschlag OHNE `action` ist weiterhin der alte Boost).

