# OCPP Command Gateway (Slices 11/12): Antwort ist nicht Wirkung

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 137).


Der vollständige CSMS→Station-Pfad liegt unter
`POST/GET/DELETE /api/v1/sites/{siteId}/ocpp/...`; Premium-Portalflächen sind
bewusst ein späterer Slice. Alle 20 OCPP-1.6-Aktionen aus Anhang A5 sind
aktionsspezifisch validiert. `DataTransfer` ist ausschließlich über die
geschlossene Registry `services/api/src/main/resources/ocpp/data-transfer-registry.json`
und dieselbe Vendor/Message-Bindung am Edge zulässig.

- **Migration sequencing:** Der Command-Gateway-Vertrag liegt fest auf
  `V20260846010000__ocpp_command_gateway.sql`: `V45` gehört zum
  `device_override`/Handeingriff aus PR 513, `V20260846000000` dem
  `site_suggestion_state` aus PR 515; `V47` ist für PR 514 und
  `V48`/`V48.01`/`V49` sind für PR 510 reserviert. Nach jeder Umbenennung muss
  der API-Lauf mit `./mvnw clean ...` starten, damit keine alte Kopie unter
  `target/classes/db/migration` Flyway täuscht.

- **Persistierte Choreografie:** `prepared -> sent -> CallResult/CallError ->
  accepted_waiting_effect -> effect_observed/effect_failed`. `Accepted` wird
  nie als Ausführung verkauft. Readbacks tragen exakt
  `readback-<action-correlation>`; Statuswirkungen binden Station, Connector,
  Transaktion/Zielzustand und müssen nach der Antwort liegen. Reset verlangt
  Disconnect gefolgt von Boot. D10-Fristen laufen auch im tenantlosen Scheduler
  über die eng begrenzte SECURITY-DEFINER-Funktion `expire_ocpp_actions`; ein
  vor dem Sendestatus abgestürztes `prepared` läuft ebenfalls aus.
- **One-shot am Edge:** das nicht-retained QoS1-Kommando enthält
  `requested_at`, `deadline_at`, `action_id`, Request-Hash und die vollständige
  Tenant/Site/Device-Identität. Der Edge vergleicht diese mit seiner Enrollment-
  Identität, validiert strikt und schreibt VOR dem ersten Stationsbyte das
  fsync+rename+directory-fsync Ledger `ocpp-command-ledger.json`. Identische
  Broker-Replays sind No-ops, Kollisionen fail-closed; ein Crash darf dadurch
  einen Befehl verlieren, aber niemals eine physische Aktion doppelt ausführen.
  **Die 4.096er-Grenze ist Backpressure, keine Verdrängung:** kein Eintrag wird
  vor seiner unveränderlichen Deadline entfernt, auch ein terminaler nicht;
  ist das Ledger nur mit solchen Live- oder Late-Response-Belegen gefüllt,
  lehnt die Edge weitere Commands mit `ledger_capacity` ab. Nach Deadline dürfen
  terminale Belege weg; ausstehende claimed/sent/readback-Belege bleiben für
  späte Stationsantworten noch 24 h korrelierbar und werden erst danach bereinigt.
  **Kapazitätsablehnungen sind ebenfalls restart-fest, aber konstant begrenzt:**
  statt einer durch neue `action_id`s unbeschränkt wachsenden Tombstone-Map hält
  dasselbe Ledger genau einen `capacity_block_until`-Watermark, das Maximum aller
  bisher kapazitätsbedingt abgelehnten Envelope-Deadlines. Solange er aktiv ist,
  wird jeder noch so unterschiedliche neue/replayte Command vor Claim und
  Stationsbyte abgelehnt und darf den Watermark nur nach hinten verlängern; am
  exakten Ablaufzeitpunkt sind alle darunter abgelehnten Envelopes selbst
  abgelaufen. Das ist bewusst fail-closed und tauscht bei Überlast Verfügbarkeit
  (globaler Command-Stopp bis höchstens zur höchsten zulässigen Deadline) gegen
  At-most-once-Sicherheit ohne Memory-/Disk-DoS. `ledger_capacity`-Feedback nutzt
  `action_id` plus unveränderliches `requested_at` als stabile Journalidentität:
  ein verlorenes PUBACK vervielfacht die Datei nicht, und nach Event-ACK wird
  dieselbe `event_id` erneut geliefert, sodass Cloud-Dedup exakt bleibt. Die
  Transaktionsgrenze liegt VOR diesem Business-Feedback: scheitert das
  Persistieren einer erstmaligen oder verlängernden Kapazitätssperre, entsteht
  KEIN `CommandRejected`-Event. `ErrCommandStorage` läuft bis zum Cloud-Link
  durch; dessen Paho-Client arbeitet für alle Topics mit manuellen ACKs und
  lässt genau diesen Command unbestätigt, während alle übrigen Downlinks nach
  ihrer bisherigen synchronen Verarbeitung ACKen. Damit darf eine Redelivery
  nach Storage-Erholung noch ausführen, ohne einem bereits terminal
  `edge_rejected` gemeldeten Ausgang zu widersprechen. **Persistente MQTT-
  Sessions brauchen ihre lokalen Routes vor dem Netzwerk-Connect:** Paho kann
  bei `CleanSession=false` ein brokerseitiges inflight DUP unmittelbar nach
  CONNACK und damit noch vor `OnConnect` zustellen. `cloud.New` registriert
  deshalb ausnahmslos alle aktivierten Downlink-Handler per `AddRoute`, bevor
  `Connect` möglich ist; `OnConnect` stellt getrennt und idempotent nur die
  QoS1-Subscriptions mit nil-Handler wieder her. Niemals einen Downlink-Handler
  zurück in `OnConnect` verschieben — ein sauberer Prozessneustart könnte sonst
  einen unbestätigten sicherheitsrelevanten Command bis zum nächsten
  Verbindungsabbruch liegen lassen.
  Der `action_id` ist zugleich der OCPP-wire-id; die Journal-Korrelation ist
  wire-identisch. Nach Neustart wird sie aus dem immutable CALL-Spool UND dem
  Command-Ledger aufgebaut, weil ein normaler Cloud-QoS1-ACK die bereits
  hochgeladene CALL-Datei vor der Stationsantwort löscht. Auch die zufällige
  Readback-wire-id wird vor dem Stationsbyte im selben Ledger gebunden; gleiche
  Aktionen und umgekehrt eintreffende Antworten bleiben dadurch exakt.
  `wire_id` wird zusätzlich im Cloud-Protokolljournal persistiert; eine
  CallResult/CallError-Zeile darf die Action nur fortschreiben, wenn externe
  Korrelation, logische Wire-Aktion UND diese UUID übereinstimmen.
- **Edge-Ablehnung ist ein Ergebnis:** Payload-/Schema-/Identitäts-/Deadline-,
  Offline- und Sendefehler erzeugen ein dauerhaftes `CommandRejected`-Event,
  das die API als `edge_rejected` statt als irreführenden Timeout speichert.
  Scheitert erst der Folge-Readback, bleibt die ursprüngliche Annahme wahr und
  der Ausgang wird stattdessen als `effect_failed` erklärt.
  Positive ChangeConfiguration/SendLocalList/Profile-Antworten lösen einen
  gezielten Readback aus; `RebootRequired` startet niemals automatisch Reset.
  RemoteStart-Wirkung verlangt zusätzlich denselben privacy-safe `idTag`-Beleg
  wie der exakte outbound CALL. SetChargingProfile vergleicht Connector,
  Einheit, Dauer/Zeitraum und sämtliche Perioden/Limits; ClearChargingProfile
  bleibt ohne persistierten Vorher-/Nachherbeleg ehrlich `effect_failed` statt
  einen unveränderten CompositeSchedule als Erfolg zu verkaufen.
- **Races/Idempotenz:** Zustand+Audit mutieren in einer Transaktion und unter
  Row-Lock/CAS; `sent` kann Antwort oder Cancel nicht zurückdrehen. Tenantweite
  Idempotency-Keys werden per transaction advisory lock serialisiert und an
  Ziel, Aktion, Connector/Transaktion und kanonischen Payload-Hash gebunden.
  Kollidierende laufende Reset/Boot- und Profile-Mutationen sind ausgeschlossen.
  DELETE kann nur echtes `prepared` abbrechen und liefert 204; nach Übergabe
  liefert es ehrlich 409. Späte Antworten/Wirkungen behalten den terminalen
  Ausgang und erzeugen explizite `late_response`/`late_effect`-Auditzeilen.
- **D4/D9:** Operator = Alltag, site-admin/admin = Betrieb, platform-admin =
  Hard Reset/Firmware/Diagnoseziel/DataTransfer. Hard Reset, Full LocalList und
  Firmware verwenden servererzeugte, fünf Minuten gültige, akteur-/ziel-/
  payloadgebundene Intents. Fremdfirmware verlangt einen zweiten
  Plattformoperator; normale Firmware muss Location+SHA-256+Signatur exakt in
  `ocpp_firmware_artifact` treffen. Firmware-/Diagnoseziele sind kurzlebig
  kryptografisch presigned HTTPS; URLs/Tags/Secrets werden vor BEIDEN
  Postgres-Kopien redigiert.
  ChangeConfiguration bleibt auch für Anlagenadmins eine geschlossene
  Standard-Key-Allowlist; `AuthorizationKey`, Secrets und freie Vendor-Keys
  können über diesen Remote-Pfad niemals geschrieben werden.
- **Audit ist append-only und begrenzt:** die App-Rolle besitzt weder UPDATE/
  DELETE auf Audit noch DELETE auf dem kaskadierenden Action-Parent. Nur
  `purge_ocpp_action_history` darf abgeschlossene Action+Audit-Historie nach
  90 Tagen und abgelaufene Intents nach einem Tag entfernen. Die einzige
  vorzeitige Ausnahme ist eine ausdrücklich bestätigte Kunden-Datenlöschung:
  `purge_ocpp_action_scope` verlangt den gesetzten Tenant und genau EINE
  Site-/Device-Grenze; `SeriesRepository` nutzt sie, ohne der App-Rolle
  allgemeines DELETE auf Lifecycle/Audit zu geben.
- Verträge: `mqtt-ocpp-command.schema.json`, `mqtt-ocpp-events.schema.json` und
  die OCPP-Action-Pfade in `openapi.yaml`. Beweise: API
  `OcppActionRepositoryTest`/`OcppCommandValidatorTest` plus RLS-/Listener-Tests;
  Edge `commands_test.go`, `journal_test.go`, `smartcharging_test.go` und das
  lokale `edge-app/test/e2e-ocpp.sh` (keine Live-Station).

