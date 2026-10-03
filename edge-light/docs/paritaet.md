# Paritätsliste: der Weg zum vollständigen Umstieg

Diese Liste ist der Fahrplan, bis Edge Light alles kann, was die Docker-Box kann. Erst wenn **jede Zeile erledigt** ist und die bestehenden Prüfstände gegen Edge Light grün laufen, kann die Docker-Box umgestellt werden und Node-RED entfallen.

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
| Shelly lesen und schalten | ✅ |
| eByte-IO-Modul | ✅ |
| Lokale Web-App `:8484` (Betrieb, Einrichten) | ✅ |
| Modbus-Datenspiegel (Server-Seite) | ✅ · Lernblöcke lesen ⬜ (D) |
| Datenlöschung, Einspeisewächter, Lastspitzen-Wächter | ✅ Logik |

## B. Lesen (Schicht 1)

| Funktion | Node-RED heute | Edge Light |
|---|---|---|
| **Deye über Solarman V5** (string, micro, hybrid_1p, hybrid_3p; HV/LV-Skala, BMS-Block, SoC-Regeln, Spannungsschätzung) | `deye/*.js`, Tab „Wechselrichter (automatisch)" | ✅ Stufe 1 |
| **Verbindung testen: Deye** | `test-read.js` | ✅ Stufe 1 |
| Deye: geräte-eigene Exportgrenze (Tageslesung `0x00E7`) | Router-Zusatzblock | ⬜ |
| go-e lesen (Ladeleistung, Fahrzeugstatus) | `goe/goe-api.js` | ⬜ |
| Fronius Solar API | `fronius/solar-api.js` | ⬜ |
| SunSpec live (Fronius Eco, KACO-SunSpec; Modell-Erkennung) | `sunspec/*.js` | ⬜ |
| KOSTAL PLENTICORE | `kostal/*.js` | ⬜ |
| KACO HTTP, AISWEI NH3 | `kaco/*.js` | ⬜ |
| Generisches Modbus TCP | `modbus-tcp.js` | ⬜ |
| **Weitere Energiequellen** (Erzeuger, Netz-Zähler, Verbraucher – alle obigen Wege) | Tab „Energiequellen (automatisch)" | ⬜ (heute: Protokollhinweis) |
| Verbindung testen für alle obigen, Suche nach weiteren Wechselrichtern (Unit-IDs) | `test-read.js` | ⬜ (heute: benannte Ablehnung) |

## C. Steuern (Schicht 1) – nur mit Prüfstand

| Funktion | Node-RED heute | Edge Light |
|---|---|---|
| Deye: Fernsteuerung, ToU, Ladeseite, Wechselrichter-Automatik, Rücklesen | `inverter-control-routing.js`, `deye-charge-side.js`, `unplanned-load-native.js`, `readback-verify.js` | ⬜ 🔒 |
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
| Verbraucher-Regeln (reaktiv, Hysterese, Fristen) | `vp-consumer-policy`, `reactive-eval.js` | ⬜ |
| Selbstbau-Geräte lesen/schalten (`vp.modbus.read`, `vp.modbus.switch`, HTTP/MQTT lesen, SoC ableiten, Grenzschutz) | generierte Flows + Palette | ⬜ |
| **Kundenautomationen aus dem Flow-Editor** | flowc → Node-RED-Flows | ⬜ **größter Baustein**: eine Go-Laufzeit für den geschlossenen Knotenkatalog; der Vertrag muss dem Gerät dann den Flow-Graphen statt eines Node-RED-Artefakts liefern |
| Code-Knoten `vp.logic.function` (Kunden-JavaScript in der Sandbox) | Node-RED-`function` mit Wachhund | ⬜ **offene Entscheidung**: JS-Interpreter in Go (z. B. goja) oder den Knoten ablösen |
| Flow-Status je Knoten | `vp-node-status` | ⬜ (folgt der Flow-Laufzeit) |

## F. Betrieb

| Funktion | Docker-Box | Edge Light |
|---|---|---|
| Installation | `install.sh` (Docker Compose) | 🟡 OpenWrt-Loader (Pilot) |
| Updates mit signierter Kette, Rückfall, Selbsttest | Updater-Container | ⬜ Stufe 2 ([boot-und-updates.md](boot-und-updates.md)) |
| Node-RED-Editor als Servicezugang (`:1881`) | ja | **entfällt** – Ersatz für individuelle Verdrahtungen (`CUSTOM-INVERTER.md`) sind Selbstbau-Geräte und Automationen aus dem Portal. Bestandsanlagen mit Handverdrahtung vor einem Umstieg prüfen |

## Reihenfolge

Geordnet nach dem Nutzen für die Anlagen, die heute über den Mango angebunden sind (Deye + go-e):

| Stufe | Inhalt | Ergebnis |
|---|---|---|
| **1** ✅ | Fundament, Deye lesen + testen, OpenWrt-Loader (Pilot), MIPS-Build, Smoke-Test | Monitoring-Anlagen mit Deye laufen im Labor |
| **2** | Signierte Startkette, Verteilung der Programme (Cloud), CI-Build, Pilot auf einem echten Mango | Erster Kundeneinsatz möglich |
| **3** | go-e lesen, weitere Energiequellen (Deye, go-e, generisches Modbus), Exportgrenze | Monitoring + Überschussladen vollständig |
| **4** | Fronius (Solar API, SunSpec), KOSTAL, KACO lesen; Verbindungstests dafür | alle Lesewege |
| **5** | Probe-Kanal, Register schreiben, Messwerte-Bibliothek, Datenspiegel | Werkzeuge des Portals |
| **6** | Steuerung Deye und Fronius, nur mit Prüfstandsbelegen | Fahrplan wird ausgeführt |
| **7** | Verbraucher-Regeln, Flow-Laufzeit in Go (Vertragsentscheidung), Code-Knoten-Entscheidung | Automationen |
| **8** | Docker-Box auf `vp-edge-light` umstellen (ein Container), Node-RED entfernen | ein Programm für alle Boxen |

## Abschlusskriterium „komplett umschalten"

1. Jede Zeile oben ist ✅.
2. Die bestehenden Prüfstände laufen gegen Edge Light grün: `edge-app/test/e2e-compose.sh`, `e2e-v2-compose.sh`, `e2e-ocpp.sh`.
3. Jede Hardware-Freigabe (Deye, Fronius, go-e, Ladesäulen) ist mit Edge Light am Prüfstand wiederholt – eine Freigabe gilt für Code, der geprüft wurde.
4. Eine Bestandsanlage je Gerätetyp lief mindestens zwei Wochen parallel (Docker-Box und Edge Light lesend am selben Gerät ist wegen der Ein-Client-Logger **nicht** möglich – also nacheinander, mit Vergleich der Tagesverläufe).
