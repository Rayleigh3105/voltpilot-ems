# OCPP-Ladepunkte: das CSMS läuft auf der BOX (`internal/csms`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 63).


Stufe 0 des Lastmanagement-Konzepts (`data/vp-ocpp-lastmgmt-konzept-w4`,
Captain-Entscheide E1–E5). Die Box ist das **Central System** — die Ladesäulen
wählen SIE an, nicht umgekehrt. Der Grund ist der Konzept-Kern: die
Anschlussgrenze ist eine PHYSISCHE Grenze, ihr Wächter darf nicht am WAN
hängen. Die Cloud bekommt (wie überall) Sichtbarkeit, nie Steuerung.

- **⚠ HERSTELLERNEUTRAL ist eine Konstruktions-Eigenschaft, kein Versprechen**
  (Konzept §0, VERBINDLICH): die Identität einer Säule ist ihre
  **OCPP-ChargePointId** und sonst nichts. `vendor`/`model`/`firmware`/`serial`
  werden als SELBSTAUSKUNFT der Station aufgezeichnet und nur ANGEZEIGT — kein
  Code verzweigt auf sie. `TestVendorStringsNeverReachTheMechanism` nagelt das
  fest: zwei Stationen mit völlig verschiedenen Herstellerangaben erzeugen nach
  dem Ausblenden der Anzeige-Felder einen **byte-gleichen** Zustand.
  `DataTransfer` — die Tür, durch die Hersteller-Logik in ein CSMS kommt —
  antwortet deshalb ausdrücklich `UnknownVendorId`.
- **Die Bibliothek wohnt in GENAU zwei Dateien.** `lorenzodonini/ocpp-go` (MIT)
  wird ausschließlich in `internal/csms/ocppmap.go` (+ dem Options-Durchreichen
  in `csms.go`) importiert; alles darüber sieht nur einfache Go-Typen
  (`csms.Snapshot`). Ein Versions-Sprung oder der spätere 2.0.1-Adapter (E3:
  1.6J zuerst) ist damit eine Änderung INNERHALB dieses Pakets — das
  `DayAheadPriceSource`/`PlantRegistryClient`-Muster des Hauses.
- **⚠ Der `ocpp-go`-CLIENT hängt seine eigene Id an die Basis-URL an**
  (`ocppj.Client.Start`), eine ECHTE Säule wird dagegen mit der VOLLEN URL
  konfiguriert. Deshalb gibt es beides: `Endpoint(host)` (Basis, für den
  in-process-Testclient) und `EndpointFor(host, id)` (das Kopier-Feld der
  Einrichtungs-Fläche).
- **Pairing = Freigabeliste, nie TOFU.** Nur eine vom Betreiber EINGETRAGENE
  ChargePointId wird zugelassen, und zwar schon beim Websocket-Upgrade
  (`SetNewChargingStationValidationHandler`) — eine unbekannte Station erreicht
  keinen einzigen Handler und wird LAUT protokolliert. `Remove` ist ein
  Widerruf: die Verbindung wird gekappt und ein Wiederverbinden scheitert.
- **⚠ Ein Verbindungsabriss löscht die aufgezeichnete Sitzung NICHT.** Ein
  toter Socket sagt nichts darüber, was die Säule physisch tut; „alles gestoppt"
  wäre eine Behauptung, die niemand gemessen hat. Sicher ist das durch den
  OCPP-EIGENEN Totmann (die `duration` des TxProfile) — die Säule fällt von
  selbst auf ihr hinterlegtes Default zurück. Es wechselt nur `Connected`,
  worauf jede Fläche schlüsselt.
- **⚠ Transaktions-Ids werden PERSISTIERT** (`chargers.json` trägt neben der
  Freigabeliste den Zähler). Eine Box, die sie beim Neustart vergisst, vergibt
  eine Id neu, die eine Säule für eine LAUFENDE Sitzung noch hält.
- **Der Messwert-Parser ist rein und kennt die Fallen** (`meter.go`,
  Vektor-Tests): ein FEHLENDES `measurand` IST das Energieregister
  (Spec-Vorgabe), eine fehlende Einheit ist W bzw. Wh (nie „kilo"), ein
  PRO-PHASE-Wert ist nicht die Summe (ein unphasierter Wert gewinnt immer,
  sonst werden genau L1+L2+L3 summiert), und ein unbrauchbarer Wert wird
  VERWORFEN und GEZÄHLT, nie als 0 gespeichert. **Die SoC-Bandbreite ist hier
  `[0,100]`, nicht `(0,100]` wie beim Batterie-Wechselrichter** — ein Auto
  kommt legitim mit 0 % an, während dort die 0 „Logger erreicht das Gerät
  nicht" hieß.
- **⚠ Flags: `VP_OCPP_ENABLED` ist seit dem 24.08.2026 ein OPT-OUT (Vorgabe AN,
  Captain-Order „ich will das auf der Box OCPP immer angeschalten ist
  automatisch, ohne .env brauch ich nicht"), `VP_OCPP_PORT` bleibt 8887.** Ein
  ausdrückliches `false` gewinnt weiterhin (das `VP_OTA_PRUNE`-Muster). Die
  frühere Begründung „eine Box ohne Ladepunkt zahlt nichts" war eine
  RESSOURCEN-Aussage, keine Sicherheits-Aussage — der Preis ist ein
  Websocket-Listener auf einer LAN-Schnittstelle, und das TOR war nie dieses
  Flag, sondern die Freigabeliste (eine unbekannte Kennung wird beim
  Verbindungsaufbau abgewiesen und protokolliert). Bewusst UNABHÄNGIG von
  `VP_CONTROL_ENABLED`/`VP_CONSUMER_CONTROL_ENABLED`: die zwei sperren SCHREIB-
  Pfade auf ein Gerät, dieser einen SERVER, den Stationen anwählen — **und an
  dieser Unabhängigkeit hat sich NICHTS geändert**, die lebende Zuteilung bleibt
  hinter beiden.
- **⚠ LAN-only ist Umgebung, nicht Code:** die Bibliothek bindet `:port` auf
  allen Schnittstellen (keine Bind-Adresse wählbar) — die Grenze sind
  Compose-Port-Mapping + Host-Firewall, genau wie bei `:8484` und dem
  Node-RED-Editor, plus die Freigabeliste.
- **Scope-Zaun (E4): Lastmanagement pur.** `Authorize` akzeptiert JEDEN Tag —
  es gibt keine Abrechnung, kein Eichrecht, kein Roaming und keine
  Nutzerverwaltung, auf die sich eine Entscheidung stützen könnte, und ein
  erfundenes „Invalid" hielte ein Kundenauto aus einem Grund an, den wir
  erfunden haben. Sitzungen sind BETRIEBS-, keine Abrechnungsdaten.

### OCPP-Datenjournal (Slice 10): unter dem Typ-System, vor der ersten Platte

- **`csms/journal.go` sitzt am Websocket-Rand und sieht ALLES:** der Wrapper in
  `ocppmap.go` protokolliert Call, CallResult und CallError in beide Richtungen,
  bevor ein typisierter Handler ein unbekanntes/fehlerhaftes Ereignis verlieren
  könnte. Connect/Disconnect werden als interne Events ergänzt. Die Library-
  Kapsel bleibt trotzdem intakt: `journal.go` importiert `ocpp-go` nicht.
- **⚠ Privacy gilt VOR dem ersten `WriteFile`:** `idTag`/`parentIdTag` werden
  mit dem gerätespezifischen, 0600-geschützten `ocpp-privacy.key` zu stabilen
  `tagref_*`; `AuthorizationKey` und secret-/password-/token-artige Vendor-Keys,
  Diagnose-/Firmware-URLs und untypisierte `DataTransfer.data` werden redigiert.
  Der völlig unstrukturierte `CallError.error_description` wird immer auf den
  festen Anwesenheitsmarker `[redacted-call-error-description]` reduziert;
  selektives Erkennen wäre für URL-Token/idTag/Vendor-Secrets nicht vollständig.
  `privacySafeProtocolError` erzwingt denselben Marker auch im funktionalen
  Callback-/Status-/Log-Pfad von `ocpp-go`, nicht nur im Wire-Journal.
  `location` ist NUR bei Diagnose/Firmware eine URL — bei `MeterValues` ist
  `Outlet`/`EV` eine unverzichtbare Messdimension und darf nie redigiert werden.
- **Der Spool ist crashfest und geordnet:** eine atomisch umbenannte Datei je
  Event unter `data/ocpp-journal`; erst ein erfolgreicher MQTT-QoS1-Publish auf
  `ems/{t}/{s}/{d}/v2/ocpp-events` löscht genau diese Datei. Der Upload-Loop in
  `agent/ocpp.go` ist reine Sichtbarkeit und stellt keinen Downlink/Command-Pfad
  bereit. `Journal.Close` ist die Lifecycle-Barriere gegen verspätete
  Disconnect-Callbacks beim Shutdown. Davor blockiert `transport.stop` neue
  Reconnects und drainiert zugelassene WebSockets begrenzt auf
  `commandSocketWriteWait + 1s`; im Normalpfad sind danach Register und Pumps
  leer, bei einer nicht kooperierenden Dependency übernimmt der synchronisierte
  `Server.Stop` als bounded Fallback (niemals eine unbegrenzte Stop-Schleife).
  Auch `StopConnection` selbst darf nicht inline in der Deadline-Schleife
  liegen: genau ein Close-Worker versucht alle Sockets einmal, die Hauptroutine
  prüft unabhängig ihre monotone Frist, ruft dann den synchronisierten Fallback
  auf und joint den Worker wiederum begrenzt. So kann ein Mutex-stauender Close
  weder die Frist umgehen noch pro Poll neue Shutdown-Goroutinen erzeugen.
  Der Core pinnt dazu den ersten
  offiziellen post-v0.19-Upstream-Stand mit per-Socket-Mutex: v0.19.0 hatte
  sowohl `writePump.error` gegen `errC`-Close als auch `StopConnection` gegen
  `cleanupConnection`/`closeC` ungeschützt. Diese Reihenfolge und den Pin nicht
  auf v0.19.0 oder `Stop()`-direkt zurückbauen.
- **Ein voller Spool darf nie wie Vollständigkeit aussehen:** Kapazitäts-
  Evictions und Event-Write-/Rename-/Encode-Fehler landen im separaten,
  atomischen `data/ocpp-journal-gaps.json` mit monotonem Gesamtzähler und
  Event-/Zeitbereich. `Next()` liefert den stabilen `JournalGap` vor normalen
  Events; erst sein QoS1-ACK entfernt ihn. Neue Drops während eines in-flight
  Gaps beginnen eine neue Generation, sodass ein ACK nie ungesehene Verluste
  mitlöscht. `PurgeProtocolEventsThrough` entfernt bewusst gelöschte Events
  ohne einen falschen Verlustbeleg zu erzeugen. Beim All-Data-Purge werden auch
  korruptes JSON, nicht lesbare Dateien und Events ohne dekodierbaren Zeitstempel
  konservativ gelöscht; ein Remove-/Gap-Ledger-Commitfehler bleibt retrybar.
  `agent/purge.go` persistiert deshalb die Cloud-Löschabsicht mit
  `local_cleanup_pending=true` VOR dieser falliblen Bereinigung, wiederholt sie
  beim nächsten Start vor dem Cloud-Reconnect und sendet denselben Zeitstempel
  nach Reconnect erneut. Nie lokale Teil-Löschung ohne restart-festen Cloudauftrag.
- **Das GetConfiguration-Inventar ist absichtlich VOLLSTÄNDIG:**
  `CapabilityKeys()` ist wieder die gezielte, lasttragende Abfrage der vier
  Smart-Charging-Sicherheitswerte. NACH installierten Schutzprofilen fragt
  `InventoryKeys()` best-effort mit leerer OCPP-Keyliste (= alle Schlüssel).
  Eine Säule, die die Vollabfrage verweigert, bleibt damit sicher commissioned;
  bei Erfolg bewahrt das Wire-Journal readonly, unknownKey,
  SupportedFeatureProfiles und Vendor-Keys. Es entsteht keine neue Aktion.

