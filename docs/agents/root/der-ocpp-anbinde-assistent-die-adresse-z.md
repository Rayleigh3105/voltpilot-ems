# Der OCPP-ANBINDE-ASSISTENT: die Adresse zum Kopieren, die Kennung aus dem Portal

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 150).


Scout `data/vp-geraeteseite-rev-b8` §8 + Captain-Entscheid **E1** (Geräteseiten
Stufe 3). Bis hierher waren „eine Säule anbinden" drei erklärende Sätze, die
ausdrücklich KEINE Adresse nennen konnten („die Box weiß nicht, unter welchem
Namen ihr LAN sie erreicht") und die Kennung nur auf `:8484` eintragen ließen.
Seit **D5** meldet die Box ihre eigene, BEWIESENE LAN-Adresse — damit sind beide
Hälften machbar. Alles ist additiv: eine ältere Box und ein älteres Portal
verhalten sich zeichengleich wie vorher.

- **⚠ DIE ALLOWLIST BLEIBT DIE ALLOWLIST — es wandert nur ihr PFLEGE-Ort.** Es
  entsteht KEIN Anlern-Fenster und kein TOFU: eine unbekannte Kennung weist die
  Box weiterhin ab und protokolliert sie. **Die FORM der API trägt diese Regel:**
  `POST /charging-config/charge-points` fügt GENAU EINE Kennung hinzu und
  `DELETE …/{chargePointId}` nimmt GENAU EINE zurück — es gibt bewusst KEIN PUT
  auf die Liste, denn das lüde dazu ein, einen Eintrag durch WEGLASSEN zu
  entfernen, also durch eine Handlung, die keiner Rückfrage begegnet.
  `Agent.applyChargePoints` überschreibt weiterhin keinen bestehenden Eintrag.
- **⚠ Seit dem 24.08.2026 ist eine Kennung ENTFERNBAR (Captain-Order „ebenso
  will ich die möglichkeit haben eingebene kennungen zu löschen"), und das
  REVIDIERT die frühere Add-only-Zusage bewusst.** Der Grund für sie war
  richtig — eine Rücknahme wirft die Säule beim nächsten Verbindungsaufbau vom
  Broker —, aber die Antwort darauf ist eine ausdrückliche Handlung mit
  Folgenliste, nicht eine fehlende Tür. Details: der Grabstein-Abschnitt unten.
- **Der Verteilweg ist das BESTEHENDE retained Dokument** (`charge_points[]`
  additiv im `mqtt-charging-config`-Kontrakt, `schema_version` bleibt 1.0),
  dieselbe PATCH-Semantik: abwesend heißt „das Portal äußert sich nicht".
  **⚠ Eine LEERE `charge_points`-Liste ist — anders als die leere Vorrang-Liste —
  KEINE Aussage** (die eine ersetzt eine Menge, die andere fügt hinzu), deshalb
  wird sie gar nicht erst gesendet. Auf der Box gilt: **die Allowlist wird VOR
  dem Vorrang angewandt**, sonst bekäme eine gerade eingetragene Säule den
  Vorrang desselben Dokuments erst beim nächsten Speichern.
- **Speicher `site_charge_point_allowlist`** (Migration `V20260834000000`,
  mandantengebunden mit RLS + FORCE — das sind Kundendaten, anders als
  `edge_release`). Bewusst eine EIGENE Tabelle statt Spalten an
  `site_charge_point_priority`: dort IST die Anwesenheit der Zeile die
  Vorrang-Aussage, eine Verschmelzung machte es unmöglich, eine Säule
  einzutragen OHNE ihr Vorrang zu geben. **Die App-Rolle bekommt weiterhin KEIN
  DELETE** — und das bleibt richtig, auch seit es eine Rücknahme gibt: die
  Rücknahme ist ein UPDATE (ein Grabstein), kein Löschen, das Recht sagt seither
  also „kann nicht VERGESSEN" statt „kann nicht entfernen". Der
  `ON DELETE CASCADE` beim Offboarding bleibt davon unberührt (an echtem
  Postgres 16 nachgemessen). Dieselbe Migration ergänzt
  `device_charging_budget` um `ocpp_port`/`ocpp_url_path`.
- **⚠ Der Endpunkt entsteht NUR aus GEMELDETEN Angaben, und jede fehlende wird
  BENANNT** (`frontend/portal/src/ladesaeuleAnbinden.ts` `endpunkt`): LAN-Adresse
  vorhanden UND **`lanSource === 'erreicht'`** (eine bloße Schnittstellen-Adresse
  sagt, wo die Box steckt, nicht dass dort etwas antwortet — ein Kopierfeld
  verspräche genau das) UND ein gemeldeter Anschluss (`ocpp_port`; der Ingest
  verwirft 0 und alles außerhalb 1..65535, siehe `ChargerStatusListener.optPort`).
  Fehlt eines, nennt die Fläche den WEG. Die Form ist
  `ws://<box>:<port><pfad>/<kennung>` — genau die, die `internal/csms` erwartet.
- **⚠ Es werden BEIDE Schreibweisen gezeigt** (mit und ohne Kennung): OCPP-J
  lässt beides zu, und welche eine Säule will, weiß nur ihr Handbuch. Eine
  Fläche, die nur eine zeigt, schickt die Hälfte der Kunden in einen
  Verbindungsfehler, den niemand erklären kann.
- **⚠ Eingetragen ≠ gemeldet.** Der Abschluss wird ausschließlich aus dem
  gelesen, was die Box über tatsächlich GESEHENE Säulen berichtet; ein Eintrag
  heißt nur, dass sie die Kennung annehmen WÜRDE. Umgekehrt gilt: eine Säule,
  die sich meldet, HAT ihre Kennung — auch wenn sie nur am Gerät eingetragen
  wurde und in der Portal-Liste fehlt (im Browser-Beweis aufgefallen).
- **Beweise:** Go `internal/chargingcfg` (+4, inkl. der Fixture
  `mqtt-charging-config.valid.saeulen-eintragen.json` PER PFAD) +
  `agent/charging_config_test.go` (+3: Reihenfolge, nie überschreiben, nie
  entfernen) · api `ChargingConfigPublisherTest` (11) +
  `ChargerStatusListenerTest` (18, inkl. der drei unmöglichen Anschlüsse) +
  `ChargerApiTest.aChargePointIsAdmittedFromThePortalAndTheEndpointComesFromTheBox`
  (echte DB + EMQX) · Portal `ladesaeuleAnbinden.test.ts` (21) +
  `LadesaeuleAnbinden.test.tsx` (8). Im echten Chrome bei 1440 und 375 an BEIDEN
  Wirten durchgespielt: 0 px horizontaler Überlauf, 0 überstehende Elemente.
- **Ops:** keine neue Pflicht-Variable — Publisher und Ingest reiten auf den
  schon gesetzten `voltpilot.provisioning.*` bzw.
  `VOLTPILOT_CHARGERS_MQTT_LISTENER_ENABLED`.

