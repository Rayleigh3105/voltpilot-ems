# Das Lastmanagement-Rig `test/e2e-ocpp.sh`: Docker-frei, und es misst

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 65).


Die Faelle L1-L12 des Konzepts (§6.2 + Datenfundament + Command-Gateway) gegen den ECHTEN Kern und ECHTE
OCPP-Ladesaeulen (`cmd/vp-ocpp-sim`) ueber ECHTE Websockets.

- **⚠ Jede Zusicherung liest, was eine Saeule ZIEHEN WUERDE**, abgeleitet aus
  den Ladeprofilen, die der Kern ihr wirklich installiert hat — nie eine
  Quittung. Der Simulator loest den OCPP-Profil-Stapel selbst auf
  (`internal/ocppsim`), also ist „das Budget wird gehalten" eine MESSUNG.
- **⚠ Bewusst OHNE Docker** (anders als die `e2e-*-compose.sh`-Rigs): hier
  laeuft alles als Prozess, das Rig ist also auf jedem Rechner mit Go
  reproduzierbar und braucht kein gebautes Image. Die Cloud-URL zeigt bewusst
  ins Leere — das Lastmanagement ist per Konstruktion offline-faehig, und das
  Rig zeigt genau das. **Diese Eigenschaft ist seit dem 26.08.2026
  auch eine CI-Eigenschaft und soll bleiben:** der Forgejo-Runner faehrt den Job
  selbst in einem Container am Docker-Socket des HOSTS, also funktioniert dort
  weder ein Bind-Mount aus dem Workspace noch eine Anfrage an einen
  veroeffentlichten Port. Ein docker-freies Rig ist von der ganzen Klasse nicht
  betroffen; das Compose-Rig musste dafuer umgebaut werden (naechster
  Abschnitt).
- **⚠ EIN LIEGENGEBLIEBENER PROZESS EINES ABGEBROCHENEN LAUFS VERGIFTET DEN
  NAECHSTEN - und zwar an einer Stelle, die nichts mit ihm zu tun hat.** Bricht
  ein Lauf mittendrin ab, kann seine `cleanup`-Falle einen `vp-netz-sim` oder
  einen zweiten Kern ueberleben lassen; der publiziert weiter auf den festen
  Bus-Port, und der naechste Lauf scheitert dann z. B. beim Einrichten
  („Budget ist 229.3 kW, erwartet 82,3") oder erst in L13, ohne dass am Code
  etwas falsch waere. **Vor einer Untersuchung deshalb IMMER zuerst
  `ps aux | grep -E '[v]p-(edge-core|ocpp-sim|netz-sim)'`** und notfalls
  `pkill -f 'vp-edge-core|vp-ocpp-sim|vp-netz-sim'`; erst danach ist ein
  Fehlschlag eine Aussage ueber den Code (real passiert, zwei Laeufe gekostet).
- **⚠ EIN EINGESCHWUNGENER ZUSTAND WIRD MIT `haelt` GEPRUEFT, NIE MIT DEM
  ERSTEN TREFFER** (CI-Ausfall L15b, 01.09.2026). Ein Regelkreis kann den
  richtigen Wert im Vorbeigehen treffen und ihn danach wieder verlieren; genau
  so hat die vergiftete Messwert-Paarung (siehe „Stufe 2") in CI GEFLACKERT
  statt jedes Mal zu fallen — die Saeule stand ein, zwei Sekunden auf 22 kW und
  fiel danach eine ganze Glaettungs-Minute auf 14 zurueck. `haelt <warte-s>
  <halte-s> …` wartet auf den Zustand UND verlangt, dass er ihn haelt; sie ist
  bewusst NICHT fatal, damit der Aufrufer vorher die Lage samt Zaehler
  ausdrucken kann.
- **⚠ EIN BLOCK LEBT NICHT VON DER ABKLINGZEIT DES VORIGEN.** L15c toetete den
  Netz-Zaehler und stellte danach die Anschlussgrenze um — das Budget haengt
  dann an der 30-s-Frische-Grenze, und wer sie verpasst, HAELT das zuletzt
  berechnete Budget des Vorgaenger-Blocks (249,3 statt 27 kW) und misst 60 s
  lang einen Zustand, den es nie gab. Der Zaehler bleibt jetzt an und der
  Standort wird EHRLICH umgestellt (`POST /set?house=…`), und die Zusicherung
  ueber die Aufteilung wartet zuerst auf den ZUSTANDSUEBERGANG des Budgets.
- **⚠ Das Rig prueft die ZUSAGE, nie die BESETZUNG.** WELCHE zwei Fahrzeuge
  bedient werden, entscheidet die Rotation; ein Rig, das eine bestimmte Saeule
  festnagelt, prueft einen Zufall und wird flakey (genau so beim ersten Lauf
  passiert). Geprueft wird deshalb: „genau zwei laden", „keiner haengt unter
  der Mindestleistung", „der Standort bleibt unter dem Budget", „der Wartende
  nennt seinen Grund".
- **L6 ist der Stufe-2-Beweis und er misst genauso.** Der simulierte
  Netz-Zaehler (`cmd/vp-netz-sim`) meldet den VERKNUEPFUNGSPUNKT auf dem
  lokalen Bus — Gebaeudelast plus das, was die Saeulen ziehen, und er LIEST
  ihren Zug ueber ihre Status-Endpunkte, wie ein echter Zaehler ihn sieht. Das
  Rig muss die beiden also nicht von Hand synchron halten, und es gibt keinen
  Test-Hebel: der Weg ist der echte (`edge/telemetry` -> `onLocalTelemetry` ->
  `agent.ocppObserve`). Geprueft wird die ganze Kette: das Budget folgt der
  Messung, ein Lastsprung im Gebaeude regelt die Fahrzeuge herunter UND der
  Verknuepfungspunkt bleibt unter der planbaren Leistung, der Zaehler faellt
  aus -> GEHALTEN statt freigegeben -> zusammengezogen auf das sichere Budget.
- **⚠ Der Lastsprung im Rig ist bewusst REALISTISCH gewaehlt** (20 -> 100 kW
  Gebaeude bei 2-s-Kadenz), nicht maximal: die Despike-Schwelle der Box haelt
  einen groesseren Sprung ein paar Messwerte lang zurueck, und dann prueft das
  Rig das Despike-Tor statt des Lastmanagements. Wer die Zahlen anhebt, misst
  etwas anderes als er glaubt.
- **L7-L9 sind der Stufe-4-Beweis, und sie messen an den SAEULEN.** Der
  Netz-Zaehler bekam dafuer genau zwei Dinge: eine NEGATIVE Gebaeudelast (so
  speist der Standort ein, waehrend nichts laedt — das ist die PV des Rigs) und
  ein optionales `battery_power_kw`. **⚠ Die Vorgabe des Batterie-Flags ist
  NaN, nicht 0:** eine gemessene Null ist die Aussage „der Speicher nimmt
  nichts", und genau die braucht „Auto vor Speicher"; nur ein ABWESENDER Kanal
  heisst unbekannt.
  - **L7** deckelt bei „Nur Sonnenstrom" auf den gemessenen Ueberschuss,
    waehrend die physische Bahn weit offen steht — und der Verknuepfungspunkt
    steht danach bei 0 kW: es wurde nachweislich kein Netzstrom gekauft.
  - **L8** legt die Prioritaet um und misst dieselbe Sonne zweimal:
    80 -> 120 kW an den Saeulen. **⚠ Der Zaehler bildet den Speicher NICHT
    nach, wie er auf die Klemme reagiert** — das Rig ist kein Physik-Simulator;
    es misst, wie viel die Box den AUTOS zugesteht.
  - **L9** uebersteuert GENAU EINEN Ladevorgang: er zieht aus der physischen
    Bahn hoch, der andere ist nicht mitfreigegeben (er behaelt hoechstens
    seinen Sonnen-Anteil, und wenn nichts mehr uebrig ist, PAUSIERT er mit
    genanntem Grund statt zu hungern), der Anschluss haelt, und die Ruecknahme
    stellt die Prioritaet des Kunden wieder her.
  - **L10** liest den echten, wegen der absichtlich toten Cloud-Verbindung noch
    nicht quittierten Disk-Spool: Boot/Status/Auth/Start/Stop/Meter/Diagnose/
    Firmware/GetConfiguration samt Vendorfeldern, `transactionData`, Stopgrund
    und den zwei nur durch L1-N/L2-N getrennten Messdimensionen sind vorhanden;
    `RIG-TAG` und der simulierte AuthorizationKey fehlen im Klartext.
  - **L11/L12** führen zusätzlich die vollständige Command-Fläche gegen den
    echten lokalen Websocket-Stack aus: persistentes Replay/Reconnect-Dedup,
    Deadline/Enrollment-Identität, Crash+umgekehrte gleichartige Antworten und
    ChangeConfiguration → CallResult → gezielter GetConfiguration-Readback.
  - **⚠ Grosszuegige Fristen mit Grund:** der Rest des Standorts wird als
    MAXIMUM ueber 60 s genommen, und waehrend die Fahrzeuge herunterfahren
    liest der Zaehler ihren Zug kurz zu hoch. Beides UNTERSCHAETZT den
    Ueberschuss — die Bahn ist konservativ, nie grosszuegig; geprueft wird der
    Zustand, in dem die Anlage zur Ruhe kommt.
- **⚠ Und L8 hat einen echten Defekt gefunden, den KEIN Unit-Test sehen
  konnte:** die Speicher-Arbitrierung las `battery_power_kw` aus der
  Messwert-Karte — aber `onLocalTelemetry` legt diesen Kanal dort BEWUSST NIE
  hinein (er ist ein interner Kanal, kein veroeffentlichter Messwert). Die
  Arbitrierung war damit auf JEDER echten Box tot, waehrend die Tests ihre
  Karte von Hand fuellten und gruen blieben. Der Wert wird seither als
  ARGUMENT uebergeben (`ocppObserve(ts, measurements, battKw)`), und
  `TestTheBatteryReachesTheSurplusSplitThroughTheRealTelemetryPath` faehrt
  dafuer den ECHTEN Weg. **Wer einen Kanal aus `measurements` liest, prueft
  zuerst, ob er dort ueberhaupt ankommt.**
- **⚠ Ein Testfall, der den VOLLEN Agenten braucht** (nur er hat die Gates des
  Telemetrie-Pfads), braucht einen KUENDBAREN Kontext fuer `startOcpp`:
  `Stop()` wartet auf die Goroutinen des Agenten, und die OCPP-Schleife endet
  allein an ihrem Kontext — mit `context.Background()` haengt der Test.
- **L4 ist der Totmann-Beweis und er dauert:** der Kern wird GETOETET, dann
  laeuft das TxProfile (120 s) ab und die Saeule faellt VON SELBST auf ihr
  Sicherheitsprofil. Die zweite Haelfte ist genauso wichtig — sie laedt
  WEITER: ein Totmann, der den Ladevorgang abwuergt, waere kein Schutz,
  sondern ein Ausfall.

