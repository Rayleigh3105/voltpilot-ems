# Der ZWEITE Trigger auf denselben Einmal-Schreib-Kern: der Portal-Downlink

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 60).


`internal/registerwrite` (rein) + `agent/register_write.go` (nur Verdrahtung).
Vertrag, Journal und Portal-Seite: root `AGENTS.md` „Register schreiben über
das Portal, Stufe 1". Was HIER gelten muss:

- **⚠ ES IST EIN ADAPTER, KEIN ZWEITER SCHREIBWEG.** Er ruft dieselbe POLITIK
  (`installerwrite.Admit` - Allowlist `0x00E7`, Wertdeckel 7000, Bestätigungs-
  Regel, `expected_before`) und denselben MECHANISMUS (`Agent.WriteOnce`) wie
  die `:8484`-Taste. Ein `installerwrite.AdmittedWrite` entsteht nirgendwo
  sonst und hat ausschliesslich unexportierte Felder - kein Adapter kann den
  Mechanismus auf ein Register seiner Wahl richten. Wer hier einen eigenen
  Schreibpfad einzieht, muss jedes Tor ein zweites Mal absichern.
- **⚠ Nur noch EINE Ablehnung ist STUMM: eine fremde Identität** (eine Antwort
  bestätigte einem falsch adressierten Absender die Existenz dieses Geräts).
  Alles andere wird BEANTWORTET - eine Ablehnung, die niemand sieht, ist ein
  Rätsel (die Canary-Soak-Lehre): eine nicht ausgeführte Lane antwortet
  `not_supported`, die Politik `refused_policy` mit dem deutschen Satz VERBATIM
  aus `Admit`. (`gate_disabled` gibt es seit dem Wegfall des Flags nur noch im
  Kontrakt - siehe oben.)
- **⚠ Ein VERFALLENER Auftrag wird seit dem 20.08.2026 BEANTWORTET, aber
  weiterhin NICHT AUSGEFÜHRT.** Die Ausführungssperre ist der EEPROM-Schutz
  gegen eine nachgelieferte QoS1-Nachricht; die frühere STILLE schützte nichts
  und versteckte die eine Ursache, die von der Cloud aus gar nicht sichtbar ist
  - zwei auseinandergelaufene Uhren. Die Antwort (`invalid_request`) nennt
  deshalb BEIDE Uhren (`registerwrite.ExpiredMessage`). Dieselbe Regel für eine
  kaputte FORM, dort aber nur, wo die Cloud die Antwort einordnen KANN
  (`Request.Answerable`: eigene Identität + gültige Kennung + bekannter Modus) -
  sonst wäre die Antwort Rauschen, das die Cloud ohnehin verwirft.
- **⚠ `installerWriteTimeout = 30 s` ist eine VERTRAGSGRÖSSE, keine interne
  Zahl** (`agent/installerwrite.go`). Die Cloud MUSS länger warten als die Box
  sich selbst gibt; sie tat es nicht (20 s), und damit lief das Portal-Lesen auf
  jeder Anlage ins Leere, deren Modbus-Warteschlange gerade belegt war - die
  Box antwortete korrekt, nur zu spät für die Cloud. Wer die 30 s ändert, ändert
  `voltpilot.register-write.{read,write}-timeout` mit (root `AGENTS.md`
  „Zeitfenster-Invariante", `RegisterWriteBudgetTest`).
- **Drei Sicherungen gegen ein Replay**, nicht eine: nicht-retained (Vertrag),
  das `requested_at`-Fenster (60 s, ab dem Stempel des Umschlags - nicht ab dem
  Empfang) und der `request_id`-Merker (gegen eine Doppelzustellung INNERHALB
  des Fensters). Auf einem EEPROM-Register ist jede davon einen Schreibzyklus
  wert.
- **⚠ Der teure Teil läuft in EINER eigenen Goroutine**, nicht auf dem
  Router-Faden des Links: paho ist mit `SetOrderMatters(true)` konfiguriert,
  ein blockierender Handler stallt also JEDEN anderen Downlink (Plan,
  Registry, Flows, OTA-Zuweisung, Freigabe) für die Dauer eines Schreibvorgangs.
  Synchron bleibt nur, was nichts kostet und nichts starten darf: Parsen,
  Identität, Verfall, Replay, Rate.
- **Die SELBSTKONFLIKT-SPERRE liest den Beleg, nicht eine Vermutung**
  (`registerOwnedByControl`): die Adressen des NEUESTEN Steuer-Rücklesens plus
  die Frage, ob die Steuerung überhaupt schreibt (Not-Aus + Zertifizierung, im
  KERN und im Rücklesen). Ohne Rücklesen wird NICHTS behauptet - ein erfundener
  Konflikt verweigerte einen legitimen Schreibvorgang.
- **D6:** ein LOKALER Schreibvorgang mintet sich in `recordInstallerWrite` seine
  eigene `request_id` - sonst wäre genau der Vorgang unkorrelierbar, den
  niemand in der Cloud sieht. Der Herzschlag trägt das Buch additiv
  (`registerWritesSummary`, höchstens 5 Einträge des letzten Tages), eine Box
  ohne Schreibvorgang sendet GAR KEINEN Block.
- Beweise: `internal/registerwrite` (14, inkl. der Kontrakt-Fixtures per PFAD
  und der drei Bedingungen von `Answerable`) · `agent/register_write_test.go`
  (8, darunter „der Pfad braucht keinen Armierungs-Schritt" samt Struktur-
  Wächter gegen ein wieder eingeführtes Konfigurations-Feld, „fremd bleibt
  stumm, verfallen wird beantwortet aber nie ausgeführt" und „eine kaputte Form
  wird beantwortet, wo die Cloud sie versteht") ·
  `internal/cloud/status_test.go`.

