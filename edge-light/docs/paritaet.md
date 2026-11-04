# Paritätsliste: was Edge Light im Vergleich zur Docker-Box kann

Diese Liste ist der Maßstab dafür, was Edge Light kann und was ihm gegenüber der Docker-Box noch fehlt. Beide Edge-Arten bestehen vorerst nebeneinander, je nach Anwendungsfall: Edge Light für kleine Hardware und einfachere Anlagen, die Docker-Box für komplexere Anforderungen vor Ort (Produktentscheid 07.10.2026). Ob die Docker-Box je auf Edge Light umgestellt wird und Node-RED entfällt, ist offen; die Stufe 8 und das [Abschlusskriterium](#abschlusskriterium-komplett-umschalten) beschreiben nur, was dafür gelten müsste.

Legende: ✅ läuft in Edge Light · 🟡 teilweise · ⬜ offen · 🔒 braucht Prüfstand mit echter Hardware

## A. Was der Go-Core schon heute kann (keine Portierung nötig)

Diese Funktionen laufen in Edge Light ab dem ersten Tag, weil sie im Core stecken:

| Funktion | Stand |
|---|---|
| Kopplung (Referenz, CSR, Zertifikat), mTLS-Cloud-Verbindung, Abgleich der Identität | ✅ |
| Store-and-forward-Puffer, Telemetrie- und Statusmeldungen an die Cloud | ✅ (Puffer auf dem Mango im RAM, siehe [mango.md](mango.md)) |
| Fahrplan empfangen, Schutzgrenzen (Nennband, SoC, §14a, EEG-Solarladen), Eigenverbrauchs-Rückfall | ✅ Logik · 🟡 Ausführung braucht eine Wechselrichter-Steuerung (C) |
| Arbitrierung der Wünsche, Entitäten-Registry, Topologie | ✅ |
| **OCPP-Server, Lastmanagement, PV-Überschussladen „Nur Sonnenstrom", „Jetzt voll laden"** | ✅ 🔒 (Ladesäulen-Typ noch `simulator_only`) |
| go-e **steuern** (HTTP-API v2, Phasenumschaltung) | ✅ 🔒 (Typ `wallbox` noch `simulator_only`) |
| „Sonne + Speicher“ (Speicherenergie über der Untergrenze fürs Auto) | 🟡 ohne Speichersteuerung als beobachteter Speicher (`frei_beobachtet`, #1449): Untergrenze, „Speicher zuerst“ an der Grenze und die Wirkungsprüfung wirken; der Wechselrichter muss die Wallbox im Eigenverbrauch selbst decken · ⬜ Ladungsabsenkung einer geplanten Ladung und die gesteuerte Stufe `frei` brauchen die Wechselrichter-Steuerung (C) |
| Shelly lesen und schalten | ✅ · „Verbindung testen“ läuft im Core (`agent.shellyTest`, zwei Anfragen: Erkennung und Zustand aus einer Antwort) und besteht am VoltPilotGATE gegen den Shelly Pro 3 im WLAN (0,6–7,2 s je Test, 31.10.2026); das Portal wartet darauf 12 s (`ProbeService.TEST_TIMEOUT`). Ein Shelly ohne Leistungsmessung meldet im Test seinen Schaltzustand (`relay_on` in `samples`): bis edge-light-g70cc2059e kam er mit leerem `reading` an, und das Portal zeigte „Die Prüfung ist fehlgeschlagen“ · 🔒 Ende zu Ende im Portal offen bis zum Update der Box. Ein Heizstab über mehrere Ausgänge (Ausgangsmenge, Stufen 1/2/3 Phasen, [Vertrag](../../docs/contracts/v2/heizstab-shelly.md)) schaltet der Core in Edge Light und Docker-Box gleich: eine Lesung für alle Ausgänge, erst AUS dann EIN, Totmann je Ausgang, bestätigte Stufe in Rücklesung und Herzschlag, „nach Stromausfall“ im Test (`ausgaenge`) · im Portal über die Gerätesuche „Alle Ausgänge zusammen – z. B. Heizstab mit drei Phasen“ (Paket 4) als ein Gerät vom Typ `heating-rod`; einen einzelnen Ausgang als eigenes Gerät bietet das Portal nicht mehr an (die Box kann ihm keine Rolle zuordnen und meldet ein solches Bestandsgerät als abgelehnt, statt den ganzen Push zu verwerfen) |
| eByte-IO-Modul | ✅ |
| Lokale Web-App `:8484` (Betrieb, Einrichten) | ✅ |
| Modbus-Datenspiegel (Server-Seite) | ✅ · Lernblöcke lesen ⬜ (D) |
| Datenlöschung, Einspeisewächter, Lastspitzen-Wächter | ✅ Logik |
| **Gerätesuche** („Geräte suchen“ im Portal, [Vertrag](../../docs/contracts/v2/mqtt-geraetesuche.md)): Suchmodul und Erkenner im Core (`internal/geraetesuche/suche`) | ✅ gebaut, gegen Simulatoren geprüft · ✅ Suchmodul am VoltPilotGATE belegt (Abnahme 5a/5b und Läufe in #1611/#1612, 30.10.2026: Deye hinter Solarman-Logger, Shelly Pro 3, FRITZ!Box, TP-Link-Zugangspunkt; nur als Pilot von Hand, DP-6 A) · 🔒 Abnahme Ende zu Ende über das Portal offen bis nach dem Deploy. Edge Light sieht mehr als die Docker-Box: UDP-Anstoß + ARP-Tabelle (nur aktive Nachbarn werden angesprochen), mDNS, SSDP, Speedwire (SMA-Zähler) und die eingebaute Herstellerliste der Funkmodule; der offene Auftrag bleibt im RAM (kein Flash). Solarman-Logger nur über die Logger-Spur der Schicht 1. SunSpec, Fronius, KACO/AISWEI, KOSTAL und WAGO meldet es als „mit dieser Box noch nicht anbindbar“, bis die Lesewege aus B/D da sind; Huawei meldet es seit dem Huawei-Leser (B) als übernehmbar. Am GATE kommen die Antworten auf mDNS/SSDP an (Unicast auf einen kurzlebigen Quellport, conntrack sieht sie als neu), aber nur, weil die Zone `wan` `input=ACCEPT` hat; wird sie gehärtet, braucht die Gerätesuche eine Regel für UDP von `wan` mit Quellport 5353/1900. Speedwire hört mit (`wege` enthält `speedwire`), mit einem SMA-Zähler ist es noch nicht belegt |
| OCPP „klopft an“ (abgewiesene Ladesäulen 24 h im Herzschlag, [Vertrag](../../docs/contracts/ocpp-klopft-an.md)) | ✅ (Core) |
| Fähigkeiten und Update-Backend je Box-Art: `supports[]` ohne die Palette-Wörter (`measurement_config_per_component`, `erzeuger_registerbild`, `anlagensteuerung_quelle`), `update.backend` `light` | ✅ |

## B. Lesen (Schicht 1)

| Funktion | Node-RED heute | Edge Light |
|---|---|---|
| **Deye über Solarman V5** (string, micro, hybrid_1p, hybrid_3p; HV/LV-Skala, BMS-Block, SoC-Regeln, Spannungsschätzung) | `deye/*.js`, Tab „Wechselrichter (automatisch)" | ✅ Stufe 1 |
| **Verbindung testen: Deye** | `test-read.js` | ✅ Stufe 1 |
| Deye: geräte-eigene Exportgrenze (Tageslesung `0x00E7`) | Router-Zusatzblock | ⬜ |
| go-e lesen (Ladeleistung als Verbraucher; Fahrzeugstatus nur dekodiert, wie in Node-RED) | `goe/goe-api.js` | ✅ Stufe 3 (`internal/goeapi`, gemeinsame Vektoren; am echten go-e V4 geprüft) |
| **Huawei SUN2000 + LUNA2000** über den eigenen Modbus-TCP-Server (PV von der DC-Seite, Netz nur mit Smart Power Sensor, SoC nach `socPlausible`, Batterieleistung nur auf den lokalen Bus; beide Vorzeichen-Klappen) | `huawei/huawei-decode.js`, Knoten „Huawei SUN2000 lesen“ | ✅ 04.11.2026 (`internal/huaweidecode` + `internal/modbustcp`, 37 gemeinsame Vektoren; eine Sitzung je Takt, Spur je `ip:port`, weil der Dongle nur einen Modbus-Client duldet) · 🔒 am echten SUN2000 noch nicht gelesen (Kundenanlage, Go-live Woche ab 09.11.2026) |
| **KACO Powador-Altgeräte seriell** (KACOs RS485-ASCII-Protokoll, Kommando `0`, über einen transparenten RS485-zu-Ethernet-Wandler) | `kaco/kaco-serial-decode.js`, Knoten „KACO seriell lesen“ | ✅ 04.11.2026 (`internal/kacoserial`, 58 gemeinsame Vektoren inkl. Framing; ein TCP-Rohsocket je Zyklus, Spur je Wandler) · 🔒 am echten Powador 3200 noch nicht gelesen; die Protokoll-Hypothese (Serie 00) entscheidet sich am Gerät, ein fremdes Kommando-Byte wird benannt statt geraten |
| Fronius Solar API | `fronius/solar-api.js` | ⬜ |
| SunSpec live (Fronius Eco, KACO-SunSpec; Modell-Erkennung) | `sunspec/*.js` | ⬜ |
| KOSTAL PLENTICORE | `kostal/*.js` | ⬜ |
| KACO HTTP, AISWEI NH3 | `kaco/*.js` | ⬜ |
| Generisches Modbus TCP | `modbus-tcp.js` | ⬜ |
| **Weitere Energiequellen** (Erzeuger, Netz-Zähler, Verbraucher – alle obigen Wege) | Tab „Energiequellen (automatisch)" | 🟡 go-e als Verbraucher, Huawei als Erzeuger oder Netz-Zähler, Powador als Erzeuger (mehr als die Docker-Box, deren Quellen-Executor `kaco_serial`/`huawei_modbus` noch nicht kennt); jede andere Anbindung wird je Quelle im Protokoll benannt |
| Verbindung testen für alle obigen, Suche nach weiteren Wechselrichtern (Unit-IDs) | `test-read.js` | 🟡 go-e, Huawei, Powador ✅ (Huawei/Powador unterscheiden `unreachable`/`no_answer`/`invalid_response` ehrlicher als `test-read.js`, das jede Störung als `invalid_response` meldet; ein fremdes KACO-Kommando-Byte kommt als Satz an); übrige: benannte Ablehnung der Schicht 1 (sofort, z. B. Fronius 0,2 s am VoltPilotGATE) |

## C. Steuern (Schicht 1) – nur mit Prüfstand

| Funktion | Node-RED heute | Edge Light |
|---|---|---|
| Deye: Fernsteuerung, ToU, Ladeseite, Wechselrichter-Automatik, netzseitiger Drossel-Slot, Rücklesen | `inverter-control-routing.js`, `deye-charge-side.js`, `deye-grid-target.js`, `unplanned-load-native.js`, `readback-verify.js` | ⬜ 🔒 |
| Fronius: Abregelung (Model 123, FC16-Block), Speicher (Model 124, geplant) | `sunspec/curtail*.js` | ⬜ 🔒 |
| SunSpec-Simulator / generisches Modbus schreiben | Steuer-Executor | ⬜ |
| KOSTAL, KACO (vorbereitet, gesperrt) | Steuer-Adapter | ⬜ 🔒 |

## D. Werkzeuge und Kanäle

| Funktion | Node-RED heute | Edge Light |
|---|---|---|
| Probe-Kanal (Register einmal lesen, aus dem Portal) | `vp-modbus-probe` | ⬜ |
| Schalt-Test (Freigabe-Assistent) | `vp-modbus-switch-test` | ⬜ |
| Register schreiben (Portal und `:8484`) | `vp-installer-write-*`, `vp-register-write` | ⬜ |
| Messwerte-Bibliothek (Zusatzmesswerte nach Katalog) | `measurements/*.js`, `vp-measurements` | ⬜ |
| Modbus-Datenspiegel: Lernblöcke lesen | `vp-register-want/raw` | ⬜ |

## E. Automationen und Regeln

| Funktion | Node-RED heute | Edge Light |
|---|---|---|
| Verbraucher-Regeln (reaktiv, Hysterese, Fristen) | `vp-consumer-policy`, `reactive-eval.js` | ✅ Go-Zwilling `internal/verbraucherregel`: dasselbe flowc-Artefakt, dieselben Bus-Topics, je Schritt derselbe Wunsch ([Vektoren](../../docs/contracts/v2/verbraucherregel-vectors.json)); Überschuss aus `edge/telemetry` in Vektoren und `laufzeit_test.go`, die Fahrzeug-Regel Ende zu Ende mit dem echten Programm in `test/verbraucherregel-probe.sh`. Ausgeführt wird der Wunsch vom Core wie bei jedem Verbraucher; ein Verbraucher, dessen Schaltweg nur in Node-RED liegt (Selbstbau-Geräte, Zeile unten), bleibt davon ausgenommen. Zeitfenster, Preisfenster und Fristen brauchen keinen Regel-Knoten: sie kommen über Fahrplan und Registry-Push in den Core und liefen auf Edge Light schon vorher. Fähigkeit `verbraucherregeln`: eine Edge Light, die sie nicht meldet, bekommt „Solar-Überschuss“ an Schaltlast, SG-Ready und einem Heizstab ohne Ausgangsmenge gesperrt mit Grund (`SteuerartSatz.GRUND_BOX_OHNE_REGELN`), statt dass die Wahl still steht |
| Heizstab „Solar-Überschuss in Stufen“ (Heizstab-Regler, [Vertrag](../../docs/contracts/v2/heizstab-regler.md)) | – (im Core, kein Flow) | ✅ 🔒 im Core für beide Box-Arten (Überschuss mit Eigenlast, Vorrang zum Speicher, Haltezeit, Mindestlauf/-pause, Schaltgrenze, ohne Cloud weiter, Zustand auf der Platte) · die Cloud sendet den Block an jede Box mit `heizstab_regler` (Typ `heating-rod` seit 04.11.2026 `certified`, ohne Prüfstandslauf) · „Günstige Stunden“, „Feste Zeiten“ und „Fertig bis“ laufen über Fahrplan und Registry-Push im Core und sind an jeder Box frei (die Sperre aus #1671 stand auf der falschen Annahme, sie bräuchten den Regel-Compiler) |
| Selbstbau-Geräte lesen/schalten (`vp.modbus.read`, `vp.modbus.switch`, HTTP/MQTT lesen, SoC ableiten, Grenzschutz) | generierte Flows + Palette | ⬜ |
| **Kundenautomationen aus dem Flow-Editor** | flowc → Node-RED-Flows | ⬜ **größter Baustein**: eine Go-Laufzeit für den geschlossenen Knotenkatalog; der Vertrag muss dem Gerät dann den Flow-Graphen statt eines Node-RED-Artefakts liefern |
| Code-Knoten `vp.logic.function` (Kunden-JavaScript in der Sandbox) | Node-RED-`function` mit Wachhund | ⬜ **offene Entscheidung**: JS-Interpreter in Go (z. B. goja) oder den Knoten ablösen |
| Flow-Status je Knoten | `vp-node-status` | ⬜ (folgt der Flow-Laufzeit) |

## F. Betrieb

| Funktion | Docker-Box | Edge Light |
|---|---|---|
| Installation | `install.sh` (Docker Compose) | 🟡 OpenWrt-Loader (Pilot) |
| Updates mit signierter Kette, Rückfall, Selbsttest | Updater-Container | ✅ gebaut (Konzept vp-edge-light-update, K1–K5): Zuweisung im Portal wie bei der Docker-Box, Programm prüft und lädt, Loader tauscht, wacht 10 min / 3 Starts und nimmt zurück, eine bestätigte Fassung im Flash ([boot-und-updates.md](boot-und-updates.md)) · belegt im Container (`boot-update-probe.sh`, `labor/labor-probe.sh`) · 🔒 Laborbeweis P1–P11 an der Labor-Mango und erstes Portal-Update auf `edge-tgjn9gd` offen ([Labor](../labor/README.md), [Nachrüsten](nachruesten.md)) |
| Node-RED-Editor als Servicezugang (`:1881`) | ja | **entfällt** – Ersatz für individuelle Verdrahtungen (`CUSTOM-INVERTER.md`) sind Selbstbau-Geräte und Automationen aus dem Portal. Bestandsanlagen mit Handverdrahtung vor einem Umstieg prüfen |

## Reihenfolge

Geordnet nach dem Nutzen für die Anlagen, die heute über den Mango angebunden sind (Deye + go-e):

| Stufe | Inhalt | Ergebnis |
|---|---|---|
| **1** ✅ | Fundament, Deye lesen + testen, OpenWrt-Loader (Pilot), MIPS-Build, Smoke-Test | Monitoring-Anlagen mit Deye laufen im Labor |
| **2** | Signierte Startkette, Verteilung der Programme (Cloud), CI-Build, Pilot auf einem echten Mango | Erster Kundeneinsatz möglich |
| **3** | go-e lesen, weitere Energiequellen (Deye, go-e, generisches Modbus), Exportgrenze | Monitoring + Überschussladen vollständig |
| **4** 🟡 | Fronius (Solar API, SunSpec), KOSTAL, KACO lesen; Verbindungstests dafür · Huawei und KACO Powador (seriell) ✅ seit 04.11.2026 (Kundenanlage mit Edge Light) | alle Lesewege |
| **5** | Probe-Kanal, Register schreiben, Messwerte-Bibliothek, Datenspiegel | Werkzeuge des Portals |
| **6** | Steuerung Deye und Fronius, nur mit Prüfstandsbelegen | Fahrplan wird ausgeführt |
| **7** | Verbraucher-Regeln, Flow-Laufzeit in Go (Vertragsentscheidung), Code-Knoten-Entscheidung | Automationen |
| **8** | offen (07.10.2026): Docker-Box auf `vp-edge-light` umstellen (ein Container), Node-RED entfernen | ein Programm für alle Boxen |

## Abschlusskriterium „komplett umschalten"

1. Jede Zeile oben ist ✅.
2. Die bestehenden Prüfstände laufen gegen Edge Light grün: `edge-app/test/e2e-compose.sh`, `e2e-v2-compose.sh`, `e2e-ocpp.sh`.
3. Jede Hardware-Freigabe (Deye, Fronius, go-e, Ladesäulen) ist mit Edge Light am Prüfstand wiederholt – eine Freigabe gilt für Code, der geprüft wurde.
4. Eine Bestandsanlage je Gerätetyp lief mindestens zwei Wochen parallel (Docker-Box und Edge Light lesend am selben Gerät ist wegen der Ein-Client-Logger **nicht** möglich – also nacheinander, mit Vergleich der Tagesverläufe).
