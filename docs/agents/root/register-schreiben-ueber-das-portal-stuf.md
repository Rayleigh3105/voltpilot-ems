# Register schreiben über das Portal, Stufe 1 „Der Portal-Trigger"

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 96).


Konzept `data/vp-reg-schreib-konzept-p8` (Captain-Vorentscheidungen + D1–D6 vom 19.08.2026). Ein
Register einer Kundenanlage aus der Ferne beschreiben — der Auslöser ist das Deye-Installateur-
Register `0x00E7` von 33,0 auf 70,0 kW anzuheben, ohne Vor-Ort-Termin. **Diese Stufe ist der ZWEITE
TRIGGER auf denselben Einmal-Schreib-Kern**, den die Box seit `edge-app/core/internal/installerwrite`
besitzt (Politik `Admit` + Mechanismus `Agent.WriteOnce`, erster Trigger: die lokale `:8484`-Taste) —
**kein zweiter Schreibweg**, den man später getrennt absichern müsste (dieselbe Doktrin,
mit der der OTA-Pfad nur EINEN Apply-Kern hat).

- **Der Kontrakt ist EIGEN, nicht eine Probe-Erweiterung** (`docs/contracts/mqtt-register-write.schema.json`
  + 4 gültige/1 ungültige Fixture): der Probe-Kopf verspricht „no-persistence — er beantwortet eine
  Frage von JETZT", und seine Schreib-Ops tragen strukturell einen Auto-Aus. Hier ist das
  Stehenbleiben der Zweck und ein Journal Pflicht. Geteilt werden die REGELN (Identität,
  `requested_at`-Fenster, LAN-Whitelist, Ratenbegrenzung, Fehlerklassen), nicht die Topics —
  `ems/{t}/{s}/{d}/v2/register-write(-result)` im `v2/#`-Teilbaum, den die per-Gerät-ACL längst deckt
  (D-2, **keine Broker-Änderung**).
- **⚠ NICHT-RETAINED wiegt hier schwerer als anderswo:** eine retained Nachricht wird bei JEDEM
  Verbindungsaufbau erneut zugestellt — ein retained Schreib-Auftrag wäre ein EEPROM-Schreibzyklus je
  Reconnect. Die zweite Hälfte ist `requested_at` (die Box übernimmt den Stempel als Fensterbeginn,
  eine nachgelieferte Anfrage ist bei Ankunft verfallen), die dritte die `request_id`, die sich die
  Box als zuletzt ausgeführte merkt. **Es gibt NIRGENDS einen Nachhol-Speicher** (Captain-Entscheid 4:
  „nur live").
- **Drei Lanes im Vertrag, EINE ausgeführt.** `primary` führt Stufe 1 aus; `entity` und `lan` sind
  VOLLSTÄNDIG spezifiziert und werden validiert, aber mit `not_supported` beantwortet — die
  Probe-Kanal-Entscheidung wörtlich („ein Vertrag, der eine Form erst später kennt, hätte eine Box im
  Feld, die sie STILL verwirft statt sie zu benennen").
- **Zwei Routen + eine Lesesicht** (`SiteRegisterWriteController`, `/api/v1/sites/{id}/register-write`
  `/preview` · POST · `/history`): mandantenbezogen wie jede `/sites/**`-Route — **KEIN
  `@PreAuthorize`**, Authentifizierung + RLS sind der Zaun, fremde Anlage **404**. Es ist bewusst
  schon die KUNDEN-Route, obwohl in Stufe 1 nur die Plattform-Geräteseite sie rendert: Stufe 3 nutzt
  exakt dieselbe, eine zweite admin-gegatete Tür hätte später getrennt abgesichert werden müssen.
  Die Rollen unterscheiden nur die REICHWEITE (wessen Anlagen), nie die Register.
- **⚠ Jede POLITIK gehört der BOX.** Der api validiert die FORM (Adresse/Wert 0..65535, Registerart)
  und löst auf, WER gefragt wird — ob die Adresse freigegeben ist (Stufe 1: nur `0x00E7`, Wert
  0 < raw ≤ 7000), ob das Ziel im Kunden-LAN steht und ob die laufende Steuerung das Register gerade
  besitzt, entscheidet das Gerät. Eine zweite Politik hier wäre eine zweite Wahrheit über ein LAN,
  das der api nie gesehen hat. **Die EINE Regel, die cloud-seitig lebt, ist die Notiz-Pflicht (D5):**
  bei Registerklasse `netz_compliance` — in Stufe 1 also bei `0x00E7` — ist die Notiz Pflicht, für
  jede Herkunft; sie steht hier, weil die KLASSE hier entschieden wird. Reine Warnung, **kein
  Bestätigungs-Häkchen** (D3).
- **⚠ `RegisterKnowledge` ist in Stufe 1 auf die ADRESSE hart verdrahtet.** Die volle
  Warnklassen-Taxonomie (ein Daten-Verzeichnis nach dem `entitytypes/catalog.json`-Muster) kommt in
  Stufe 2 und muss dann JE FAMILIE sprechen: auf `hybrid_1p` ist die Einspeisegrenze ein ANDERES
  Register mit ANDERER Skala (`0x00F5`, Skala 1) — und genau das schreibt dort unser eigener
  Steuerpfad. Folgenlos, solange die Box eine solche Familie ohnehin ablehnt (`AllowedFamily`).
- **Das Journal ist die Papier-Spur, und es sind ZWEI Zeilen je Vorgang** (`register_write_event`,
  Migration `V20260827000000`; RLS + FORCE, App-Rolle SELECT+INSERT, UPDATE/DELETE REVOKED — das
  `rule_event`/`site_forecast_model_choice`-Muster; ⚠ das BIGSERIAL braucht sein eigenes
  `GRANT USAGE ON SEQUENCE`): `angefordert` trägt WER/WOHIN/WAS samt der **verbatim getippten
  Begriffe** (`address_input`/`value_input`/`note` — steht später die Frage „ich habe 231 getippt,
  nicht 0x00E7", zeigt das Journal die exakte Zeichenkette), `quittung`/`keine_quittung` trägt das
  Ergebnis. Eine UPDATE-Spalte wäre ein nachträglich änderbares Journal, also keins. Verbunden über
  `request_id` — denselben Schlüssel, unter dem die Box ihr eigenes Audit führt (zwei unabhängige
  Bücher, kreuz-prüfbar). Jeder INSERT ist `ON CONFLICT (request_id, event) DO NOTHING`, damit eine
  QoS1-Doppelzustellung und der D6-Herzschlag keine zweite Zeile erzeugen.
- **⚠ Die Reihenfolge ist tragend: erst VERÖFFENTLICHEN, dann protokollieren** (die OTA-Apply-Doktrin).
  Scheitert schon das Veröffentlichen (503), entsteht KEINE Zeile, die eine Anforderung behauptet,
  die es nie gab; gelingt es, steht die Anforderungs-Zeile — auch wenn die api danach abstürzt. Ein
  Schreibvorgang ist damit nie spurlos. **Eine VORSCHAU protokolliert gar nichts**: sie ändert nichts,
  und ein Protokoll der Lesungen würde die Schreibvorgänge begraben, für die es das Journal gibt
  (dieselbe Entscheidung wie im Box-Audit).
- **⚠ Der Quittungs-Zuhörer persistiert UNABHÄNGIG vom wartenden Request-Thread** (anders als der
  Probe-Zuhörer, der nichts speichert): der Aufruf hat nach Sekunden aufgegeben und „Zustand
  unbekannt" gesagt — trifft die Quittung später doch ein, ist das Journal der Ort, an dem sie
  sichtbar wird. **Schweigen ist NIE „nicht geschrieben"** (die PR-280-Lehre); der Ausgang heißt
  wörtlich `unbekannt`, und die Oberfläche verlangt vor einem erneuten Schreibvorgang eine neue
  Ist-Lesung.
- **Der vierte Strom `register`** wird zur LESEZEIT in `GET /sites/{id}/command-history` eingemischt
  (`CommandLogReader.registerEntries`) — **KEINE Doppel-Speicherung**, die Wahrheit steht genau
  einmal im Journal. Punkt-Ereignisse (`kind='ereignis'`, `eventKind='register_geschrieben'`), und
  ⚠ ihre `id` ist NEGATIV, weil die beiden Ströme aus zwei Sequenzen kommen und die Fläche darauf
  schlüsselt. Ein älteres Portal kennt das Strom-Wort nicht und lässt die Zeile wortlos aus.
- **⚠ Der Cloud-Kill-Switch `voltpilot.register-write.enabled` ist im CODE per Vorgabe AN** — eine
  argumentierte Abweichung von der Konzept-Empfehlung („Vorgabe false im Code, true in BEIDEN
  Composes"). Ein per Vorgabe ausgeschaltetes Flag muss im gitops-Repo nachgezogen werden, und genau
  diese Klasse hat schon einmal einen stillen Produktions-Ausfall gekostet (die OTA-Listener-Falle).
  Der Verzicht kostete in den Stufen 1/2 nichts, weil die eigentliche Scharfschaltung fail-closed auf
  dem GERÄT sass (`VP_INSTALLER_WRITE_ENABLED`, damals Vorgabe AUS): eine nicht armierte Box
  antwortete `gate_disabled`. **⚠ Seit der Captain-Korrektur vom 20.08.2026 gibt es dieses
  Geräte-Flag GAR NICHT MEHR (D2 KORRIGIERT — ersatzlos entfernt), dieser Schalter ist damit der
  EINZIGE plattformweite Hebel — und er wirkt im DIENST statt an der Route: abgeschaltet refüsieren
  nur die zwei SCHREIBENDEN Schritte mit 503 und deutschem Grund, während der VERLAUF lesbar
  bleibt** (siehe den Stufe-3-Abschnitt).
  Publisher/Zuhörer reiten auf `voltpilot.provisioning.*` (derselbe Broker wie Probe/Provisionierung/
  OTA) — kein weiteres Transport-Flag. Fristen: `voltpilot.register-write.{read,write}-timeout`.
- **⚠ DIE ZEITFENSTER-INVARIANTE: das Warte-Budget der CLOUD muss GRÖSSER sein als die Schranke, mit
  der die BOX ihre eigene Runde begrenzt (Produktionsvorfall 20.08.2026, Pilsting/Herzogau).** Die
  Box bindet EINEN Bus-Rundlauf an `installerWriteTimeout = 30 s`
  (`edge-app/core/internal/agent/installerwrite.go`) — so lange DARF ein Lesen dauern, weil der
  Node-RED-Knoten hinter der EINEN Warteschlange je (Host, Port) erst den laufenden Poll abwarten
  muss. Die Vorschau wartete aber **20 s**: auf jeder Anlage, deren Wechselrichter-Bus gerade belegt
  war, gab die api auf, BEVOR das Gerät antworten konnte — die Box antwortete nachweislich korrekt
  (lokal nachgestellt: 22 s, Ist-Wert 3300 = 33,0 kW), die Korrelation war da längst vergessen, und
  die Oberfläche BESCHULDIGTE die Anlage („hat den Ist-Wert nicht rechtzeitig gemeldet"), obwohl
  genau sie geliefert hatte. Der lokale `:8484`-Knopf funktionierte durchgehend, weil sein
  HTTP-Handler die vollen 30 s abwartet — dieser Widerspruch (lokal geht es, aus dem Portal nie) war
  der eigentliche Hinweis und blieb zwei Runden lang ungedeutet. Vorgaben seither **PT40S / PT60S**, in
  `application.yml` mit `VOLTPILOT_REGISTER_WRITE_{READ,WRITE}_TIMEOUT` überschreibbar (vorher stand
  die Zahl NUR als `@Value`-Default im Code — ein Operator konnte sie ohne Redeploy nicht einmal
  sehen). **Wer eine der beiden Zahlen anfasst, fasst beide an**; `RegisterWriteService.BOX_ROUND_TRIP`
  ist die notierte Geräte-Schranke, `RegisterWriteBudgetTest` nagelt sie an der AUSGELIEFERTEN Datei
  fest (mutationsgeprüft: mit PT20S fällt er um), `RegisterWriteReasonWiringTest` beweist
  container-frei, dass der Dienst danach den RICHTIGEN der drei Sätze wählt, und der Dienst WARNT
  beim Start, wenn ein konfiguriertes Budget darunter liegt. Ein zu kleines Budget ist nicht „etwas ungeduldig", sondern
  ein Feature, das auf einer belegten Anlage NIE funktioniert — und weil eine schnelle Test-Attrappe
  immer in Millisekunden antwortet, fällt es in keinem Testlauf auf.
- **⚠ Ein Timeout beim LESEN ist keine unbekannte Schreibwirkung.** Ein
  Probelauf (`Apply=false`) sendet per Konstruktion keinen Schreibrahmen und
  darf deshalb sagen „Es wurde nichts geschrieben“; nur nach einem echten
  Schreibauftrag bleibt der Zustand bei Schweigen unbekannt. Die Edge bildet
  beide Sätze in `Agent.WriteOnce` getrennt, und das Portal normalisiert alte
  Edge-Antworten in `geraetRegister.abrufFehler`, damit ein reiner Leseversuch
  nie wieder „nicht sicher, ob geschrieben wurde“ anzeigt.
- **⚠ SCHWEIGEN HAT DREI URSACHEN, UND SIE DÜRFEN NIE DENSELBEN SATZ TRAGEN** (derselbe Vorfall,
  Auftrag 3). Vorher trug jeder Ausgang „Die Anlage hat den Ist-Wert nicht rechtzeitig gemeldet" —
  in zwei von drei Fällen eine Falschaussage. Die reine, Docker-frei geprüfte
  `registerwrite/RegisterWriteSilence` (das `Tagesprotokoll`/`FleetPflege`-Muster) trennt sie:
  **(a)** der Auftrag ging gar nicht hinaus → 503 mit „das liegt an VoltPilot, nicht an Ihrer
  Anlage"; **(b)** das Gerät meldet sich nicht (nie gesehen bzw. `lastSeenAt` älter als das
  5-Minuten-Fenster) → es wird benannt, samt Dauer; **(c)** das Gerät hat geantwortet, nur ZU SPÄT →
  „die vorige Anfrage traf X Sekunden zu spät ein … erneut versuchen". **⚠ Die Reihenfolge ist eine
  Aussage:** eine verspätete Antwort SCHLÄGT die Telemetrie-Frische — sie kommt aus genau diesem
  Pfad, während `lastSeenAt` eine ganz andere Kette misst, und ein Gerät, das nachweislich
  geantwortet hat, darf nie „meldet sich nicht" heißen. Getragen wird (c) von
  `RegisterWriteRegistry`, das eine aufgegebene Anfrage nicht mehr VERGISST, sondern als AUFGEGEBEN
  markiert (3 min) und eine später eintreffende Quittung als `Delivery.LATE` erkennt.
- **⚠ Der Quittungs-Zuhörer protokolliert den AUSGANG der Korrelation** (`LATE`/`UNKNOWN` laut,
  `DELIVERED` still) und der Publisher nennt das GERÄT samt Lane. Beides fehlte, und genau deshalb
  war der Prod-Log mehrdeutig: er zeigte fünf „veröffentlicht"-Zeilen und danach nichts — aus dieser
  Stille war „nie geantwortet" von „zu spät geantwortet" nicht zu unterscheiden, und auf welchem
  Geräte-Pfad der Auftrag lag, stand nirgends. Wer einen Antwort-Pfad baut, protokolliert seinen
  Ausgang; Stille ist kein Beleg.
- **⚠ Auf der BOX ist nur noch EINE Ablehnung stumm: eine fremde Identität.** Ein VERFALLENER
  Auftrag wird weiterhin NICHT AUSGEFÜHRT (das schützt das EEPROM vor einer nachgelieferten
  QoS1-Nachricht), aber seit dem 20.08.2026 BEANTWORTET (`invalid_request`, die Nachricht nennt
  BEIDE Uhren) — eine Antwort kostet keinen Schreibzyklus, und aus der Cloud ist Stille
  ununterscheidbar von einem toten Gerät, womit eine auseinandergelaufene Uhr strukturell unsichtbar
  war. Dasselbe für eine kaputte FORM, dort aber nur, wo die Cloud die Antwort überhaupt einordnen
  KANN (`registerwrite.Request.Answerable`: eigene Identität + gültige Kennung + bekannter Modus).
  Kontrakt-Wortlaut in `docs/contracts/mqtt-register-write.schema.json` (`x-semantics.expiry`,
  `x-meanings.invalid_request`) mitgezogen.
- **⚠ DAS LETZTE GLIED WAR DIE SLOT-VERGABE AUF DER BOX — und die Kette der Zeitfenster war
  GERISSEN (Produktionsvorfall 20.08.2026, 20:08-20:10Z, Box edge-45gz7da; Fix im PR
  `fm/vp-regread-slot-p9`).** Nach dem Adress-Fix nahm die Box den Auftrag an („lesen, lane primary,
  register 231") und meldete 30 s später `timeout` — auf einer kerngesunden Anlage. Zwei Ursachen,
  beide reproduziert: (1) am Wechselrichter-Bus gab es KEINE Warteschlange — der Einmal-Auftrag
  und der Steuer-Executor teilten sich EINE Absichts-Fahne, die der Steuer-Executor am Ende jeder
  Runde löschte, und wer den Socket freigab, entließ ihn ins Rennen statt ihn zu übergeben; (2)
  **der Knoten durfte länger arbeiten als der Kern wartete** (12 s Warten + 25 s Socket = 37 s
  gegen `installerWriteTimeout` = 30 s), seine spätere korrekte Antwort fiel also in einen längst
  vergessenen Wartenden. Die Box-Hälfte (Reservierung + Übergabe, Steuer-Vorrang unangetastet,
  die neuen Zahlen) steht in `edge-app/AGENTS.md` „Der EINE Wechselrichter-Socket hat seit dem
  20.08.2026 eine WARTESCHLANGE"; **cloud-seitig ändert sich NICHTS** — PT40S/PT60S bleiben, und
  `RegisterWriteBudgetTest` pinnt weiterhin die obere Hälfte der Kette
  (`Knoten 15 s + 12 s ≤ Kern 30 s < Cloud PT40S`). **Der Vormittag war nur deshalb schnell, weil
  die Anlage damals nicht steuerte — der Unterschied war die LAST, nie der Auslöser.**
- **⚠ Ein ANGENOMMENER Auftrag endet seither IMMER mit genau EINEM Ergebnis** (derselbe PR): für
  einen der beiden Aufträge stand im Box-Protokoll gar keine Ergebnis-Zeile, und aus der Cloud ist
  das ununterscheidbar von „nie angekommen". `agent.runRegisterWrite` ist jetzt eine Hülle
  (`answer`-Closure + `defer` mit `recover`), die einen antwortlosen Zweig, eine doppelte Antwort
  und einen PANIC abfängt und ehrlich quittiert — „jeder Zweig antwortet" ist damit eine
  Eigenschaft des CODES statt einer, die man sich Zeile für Zeile erlesen muss.
- Beweise dieser Runde: rein `RegisterWriteSilenceTest` (8) · `RegisterWriteRegistryTest` (5) ·
  `RegisterWriteReasonWiringTest` (4, die WAHL des Grundes im Dienst) · `RegisterWriteBudgetTest`
  (1, mutationsgeprüft) ; Testcontainers `RegisterWriteApiTest.aLateAnswerIsRecognisedAndTheNext
  AttemptSaysSoInsteadOfBlamingThePlant` (echtes EMQX: erster Anlauf nennt das stumme Gerät, die
  verspätete Quittung wird erkannt, der zweite Anlauf sagt „zu spät" — und eine Vorschau bleibt
  auch dann spurlos) ; Go `internal/registerwrite` (+3) + `agent/register_write_test.go` (+1) ;
  portal `RegisterWriteDrawer.test.tsx` (+1).
- **Der BOX-KONSUMENT ist der zweite ADAPTER, kein zweiter Pfad.** `edge-app/core/internal/registerwrite`
  (rein: Parsen, Identität, Verfall, Lane, Rate, Selbstkonflikt — das
  `internal/probe`-Muster) + `agent/register_write.go` (nur Verdrahtung) reichen an GENAU die zwei
  Schichten weiter, die die `:8484`-Taste benutzt: `installerwrite.Admit` (POLITIK) und
  `Agent.WriteOnce` (MECHANISMUS). Ein `AdmittedWrite` entsteht nirgendwo sonst, seine Felder sind
  unexportiert — es gibt strukturell keinen Weg an der Allowlist vorbei.
- **⚠ STUMM sind genau ZWEI Ablehnungen:** eine fremde Identität (eine Antwort bestätigte einem
  falsch adressierten Absender die Existenz dieses Geräts) und ein verfallener Auftrag (die
  Portal-Route hat längst aufgegeben, und eine nachgelieferte QoS1-Nachricht kostete sonst einen
  weiteren EEPROM-Zyklus). Alles andere wird BEANTWORTET — eine Ablehnung, die niemand sieht, ist
  ein Rätsel (die Canary-Soak-Lehre des OTA-Pfads). Dazu ein `request_id`-Merker als DRITTE
  Sicherung neben „nicht retained" und dem Fenster: eine Doppelzustellung INNERHALB des Fensters
  schreibt nie zweimal.
- **⚠ Die SELBSTKONFLIKT-SPERRE ist BELEGT, nicht geraten:** `registerwrite.ControlOwns` prüft die
  Adressen des NEUESTEN Steuer-Rücklesens (`state.ControlInfo.Registers[].Addr`) — also genau die
  Register, die unser eigener Executor gerade schreibt — UND ob die Steuerung überhaupt läuft
  (Not-Aus + Zertifizierung, im Kern und im Rücklesen). Auf `hybrid_3p` gehört `0x00E7` dazu, sobald
  der Plan abregelt (der ToU-Pfad schreibt die Einspeise-Kappe dorthin) und solange eine ToU-Sitzung
  ihren Installateurs-Snapshot hält — die zwei Fälle, in denen ein „übernommen ✓" still
  zurückgedreht würde. Bei INAKTIVER Steuerung sind dieselben Register frei.
- **D6: die lokalen Schreibvorgänge erreichen das Journal** (`cloud.RegisterWritesSummary` im
  Herzschlag → `RegisterWriteUplinkListener` → dieselben zwei Journal-Zeilen mit `source='geraet'`,
  `origin='geraet'`). Ein lokaler Schreibvorgang **mintet sich seine eigene `request_id`**, sonst
  wäre genau der Vorgang unkorrelierbar, den niemand in der Cloud sieht. Gemeldet wird das GANZE
  Buch (auch portal-getriggerte Einträge): der eindeutige Index macht die Wiederholung zum No-op,
  und ging eine Quittung verloren, füllt das Buch der Box die Lücke. Der Zuhörer reitet
  ausdrücklich auf `voltpilot.provisioning.enabled` statt auf einem eigenen, per Vorgabe
  ausgeschalteten Flag (die gitops-Falle) — das Feature ist als EINE Einheit an oder aus.
- **Portal:** die reine `src/registerWrite.ts` ist die EINE Textschicht (Warnklassen, Eingabe-Regeln,
  Vorschau, Beleg, Journal-Satz); `components/RegisterWriteDrawer.tsx` rendert die Zwei-Schritt-
  Strecke (Ist lesen → Vorschau → Haus-`ConfirmDialog` mit Folgenliste → Beleg + Verlauf), gehostet
  von der Plattform-Geräteseite als ruhiger Experten-Abschnitt „Register (Experte)". **Ein Knopf,
  der strukturell nichts bewirken kann, wird nicht angeboten** (`registerZugang` — eine gedruckte,
  noch nicht verbundene Aufkleber-ID nennt stattdessen den Grund). Der vierte Strom `register` der
  Befehle-Seite formuliert seinen Satz aus DERSELBEN `journalSatz` — zwei Formulierungen über
  denselben Vorgang wären zwei Wahrheiten. ⚠ Ein nacktes Hex-Wort (`E7`) wird NIE geraten, weil
  „231" dann mehrdeutig wäre.
- **Beweise:** rein `RegisterKnowledgeTest` (7) · `RegisterWritePublisherTest` (5, die Umschläge
  gegen die Kontrakt-Fixtures PER PFAD) · `RegisterWriteResultListenerTest` (7, u. a. „eine Quittung
  wird auch dann protokolliert, wenn niemand mehr wartet", „ein Probelauf nie", „ein erfundenes
  Fehlerwort erreicht keinen Kunden") · Testcontainers `RegisterWriteApiTest` (6, echtes
  EMQX + DB + Keycloak: die ganze Reise Vorschau→Bestätigen→Beleg mit verbatim Eingaben, die
  Notiz-Pflicht ohne einen einzigen Byte auf dem Draht, die Vorschau ohne Spur, Schweigen =
  `unbekannt` samt verspäteter Quittung, der vierte Strom, der Mandanten-Zaun und die
  Admin-Herkunft über den Umschalter) + `RegisterWriteUplinkListenerTest` (7, der D6-Ingest) ·
  Go `internal/registerwrite` (11, inkl. der Kontrakt-Fixtures PER PFAD) +
  `agent/register_write_test.go` (7: die Reise durch den GETEILTEN Kern, die zwei stummen
  Ablehnungen, das geschlossene Tor, die Selbstkonflikt-Sperre schon in der Vorschau, GENAU ein
  Versuch, der D6-Block) + `cloud/status_test.go` · Portal `registerWrite.test.ts` (23) +
  `RegisterWriteDrawer.test.tsx` (8) + `befehle.test.ts` (+4) + `GeraetSeite.test.tsx` (+2).

