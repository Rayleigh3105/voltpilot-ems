# Das Compose-Rig `test/e2e-compose.sh`: zwei Regeln, ohne die es in CI nicht laeuft

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 64).


Es beweist die ganze Kette (SunSpec-Sim -> Node-RED/vp-palette -> Kern -> Stand-in-Cloud
-> Fahrplan -> Sollwert -> Rueckmeldung -> Modbus-Datenspiegel) gegen ECHTE Container.
Seit dem 26.08.2026 (Forgejo-Lauf 281) haelt es zusaetzlich zwei Regeln ein, die der
containerisierte Runner erzwingt — Begruendung und die ganze Klasse stehen in der
Wurzel-`AGENTS.md` unter „Einen ROTEN CI-Lauf untersuchen".

- **⚠ KEIN Bind-Mount aus dem Arbeitsverzeichnis.** Der Daemon loest ihn gegen SEIN
  Dateisystem auf; laeuft der Job im Container, gibt es den Workspace-Pfad dort nicht.
  Der Stand-in-Broker traegt seine Konfiguration deshalb EINGEBACKEN
  (`test/Dockerfile.broker` — ein Build-Kontext wird gestreamt, ein Bind nicht), und
  der OTA-Sidecar mit seinem `.:/deploy` ist ueber ein nicht angefordertes `profiles:`
  aus dem Rig heraus (er ist kein Glied der bewiesenen Kette; dass er im GERAETE-Compose
  ohne Profil mitlaeuft, ist Sache von `test/install-selfcheck.sh`).
- **⚠ KEINE Anfrage an einen veroeffentlichten Port.** Jede HTTP- und jede
  Modbus-Anfrage laeuft in einem Seitenwagen INNERHALB des Compose-Netzes und erreicht
  die Dienste bei ihrem Namen (`core:8484`, `core:1502`). Die `ports:` bleiben nur, damit
  das Rig nie mit einem laufenden Stack kollidiert — benutzt werden sie nicht mehr.
- **Der Waechter laeuft VOR dem `up`**: das aufgeloeste Compose wird auf Bind-Mounts
  geprueft, und ein Treffer nennt Dienst, Quelle, Ziel und die REGEL. Mutationsgeprueft
  in beide Richtungen. Ohne ihn kostet der naechste Bind wieder zwei Untersuchungsrunden.

