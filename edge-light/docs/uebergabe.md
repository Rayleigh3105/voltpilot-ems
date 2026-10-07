# Übergabe: Stand und nächste Schritte (07.10.2026)

Diese Datei ist der Einstieg für die nächste Arbeitssitzung – für Menschen und für einen KI-Assistenten. Sie fasst zusammen, was seit dem 03.10.2026 entschieden, gebaut und gemessen wurde. Alles Weitere steht in den verlinkten Dokumenten.

## Stand 07.10.2026: Edge Light ist auf `main`

- **Edge Light ist nach `main` gemergt** (ein Merge-Commit, keine Umschreibung). Edge-Light-Arbeit entsteht ab jetzt auf `main`; `feature/edge-light` bleibt stehen, bis er gelöscht wird. Beide Box-Arten bestehen dauerhaft nebeneinander (Entscheid 07.10.2026).
- **„Sonne + Speicher“ gibt auf Edge Light Speicherenergie frei**, seit #1449 als *beobachteter* Speicher: Der Deye des Piloten hat keine Gerätefreigabe, VoltPilot steuert ihn nicht, die Box beobachtet Ladestand und Speicherleistung. Stufe `frei_beobachtet`, das Auto bekommt Sonne plus Speicher bis zur Untergrenze; an der Untergrenze und bei gemessenem Netzbezug (Wirkungsprüfung) nimmt die Box die Freigabe zurück. Eine geplante Ladung senkt sie dabei nicht ab (kein Schreibhebel). Beleg im Simulator: `agent/ocpp_release_light_test.go` (Pilotfall), die Regeln in `agent/ocpp_release_observed_test.go`. Wirkung am Mango erst mit einem neuen Programm; dort läuft weiter `edge-light-g5af8b452d`. Offen bleibt, dass der Cloud-Fahrplan den Speicher als gesteuert plant (Handels-Viertelstunden geben nichts frei, siehe #1449 „Offener Punkt: Optimierer“).

## Stand 07.10.2026 (vormittags): `main` zusammengeführt, „Sonne + Speicher“

- **`main` ist in `feature/edge-light` gemergt** (ein Merge-Commit, keine Umschreibung). Damit sind die Cherry-Picks #1380, #1382, #1383, #1385 und #1395 erledigt (inhaltsgleich mit `main`), dazu kamen #1409 (Portal) und #1443 „Sonne + Speicher“. Auf dem Mango läuft unverändert `edge-light-g5af8b452d`; nichts eingespielt.
- **Programm `linux/mipsle`:** 14 614 743 B roh (13,9 MiB, unverändert, weil die Segmente auf 64 KiB aufgerundet werden), gzip -9 4 679 121 B (+14 KB gegenüber `733e5d3a4`). Flash und RAM bleiben im Budget von [mango.md](mango.md#speicherbudget).
- *(Überholt durch #1449, siehe oben.)* **„Sonne + Speicher“ gab auf Edge Light keine Speicherenergie frei.** Die Box meldete `speicherpfad` („VoltPilot führt den Speicher gerade nicht … ohne bestätigte Rückmeldung“), das Auto lud wie bei „Nur Sonne“. Grund: `BatteryReady` verlangt eine gehaltene Rücklesung (`edge/control/readback`), und die Go-Schicht 1 liest den Deye nur. An der Untergrenze wirkt die Regel trotzdem (Speicher zuerst, auch bei „Autos zuerst“). Das Portal bietet den Chip trotzdem an (Sperrgründe nur: keine PV, keine OCPP-Säule, kein Speicher, keine Kapazität). Beleg: `agent/ocpp_release_light_test.go`. Für eine Freigabe braucht es die Deye-Steuerung ([Paritätsliste](paritaet.md), C) oder eine Produktentscheidung, ob ein Speicher, den VoltPilot nicht steuert, als bereit gelten darf.

## Stand 05.10.2026: Pilot Anlage Dirolf (`edge-zay5sdd`)

- **Auf dem Mango läuft** `edge-light-g5af8b452d` (Spitze von `feature/edge-light`, seit 05.10.2026 11:37). Der Deye wird gelesen, die go-e (`goe-300808`, Firmware 59.4) ist per OCPP eingerichtet (Sicherheitsprofile angenommen).
- **Überschussladen „Nur Sonne“ am Auto geprüft (Teil 1):** ohne Sonne teilt die Box 0 kW zu, die go-e hält zurück (`SuspendedEVSE`, 0,00 kW). Vorher lud sie dauerhaft mit 6,8 kW (behoben mit #1380, #1382, #1383).
- **go-e auf 16 A** (`ama`/`amp`, vorher 10/11 A), mit Freigabe des Betreibers; die Variante ist 11 kW/16 A, das Kabel 32 A.
- **Phasenumschaltung 1p/3p** ([OCPP-Steuerung](../../docs/ocpp-control.md)): PR #1385 ist in `main`, auf `feature/edge-light` übernommen und auf dem Mango. Die go-e meldet `ConnectorSwitch3to1PhaseSupported=true`.
- **Feldtest einphasig, 05.10.2026 vormittags** (API/Portal mit #1385 deployt, „Laden auf einer Phase erlauben“ gedrückt, PV ~2 kW, Speicher 21–26 %):
  - Die Box schaltete die go-e um 09:28 auf eine Phase und teilte 1,56–1,84 kW zu. Die go-e nahm jedes Profil an, lud aber nicht (`modelStatus` 28 „OcppDoesntWant“): ihre Mindest-Ladestromstärke **`mca` stand auf 16 A**, die Box gab 8 A. Mit Freigabe des Betreibers auf 6 A gesetzt (`http://192.168.2.105/api/set?mca=6` vom Mango aus), danach lud sie einphasig mit 1,58 kW. **`mca` muss ≤ 6 A sein**, sonst ist jede Zuteilung unter 16 A wirkungslos – auch dreiphasig.
  - Danach **pendelte** das Laden: 11 Starts in 15 min, je 15–25 s Laden. Ursache war die Paarung von Netz- und Ladeleistung beim Anlaufen: die go-e misst alle 10 s und meldet sogar zu ihrem eigenen Zeitstempel zu wenig; die Box las 2,05 kW Überschuss als 0,94 kW. Eine erste Korrektur (`3e1c66524`, zeitgleich paaren) reichte im Feld nicht. **Behoben mit `fa9855eac`:** solange eine Säule nach eigenem Start oder Stopp einschwingt, bildet die Box kein Paar, und der Überschuss hält seinen letzten Messwert (höchstens 60 s) ([Details](../../docs/agents/edge/stufe-2-das-ladebudget-folgt-dem-gemesse.md)). Im Feld geprüft: die Box hielt ihre Zuteilung über drei Pausen der go-e hinweg.
  - **Die go-e unterbrach selbst:** einphasig meldete sie alle 20 s bis 3 min „PhaseSwitch“ (`modelStatus` 23) und öffnete das Schütz, obwohl die Box durchgehend eine Phase befahl (sekundengenau geprüft). `fup=false` änderte nichts (zurückgestellt auf `true`). Verdacht: jede Profil-Erneuerung begann mit der Uhr der Box und für eine nachgehende go-e in ihrer Zukunft, dazwischen galt ihr dreiphasiges Default-Profil. **`5af8b452d`:** Profile beginnen auf der Leitung 60 s in der Vergangenheit, das Ende bleibt gleich. Danach 18,5 min ununterbrochen dreiphasig geladen (11:38–11:57, 4,9–6,4 kW, Netz ≈ 0) – dreiphasig beweist den Verdacht nicht, dort ändert ein Rückfall auf das Default-Profil nichts. **Einphasig danach 5 min ohne eine eigene Unterbrechung** (11:58:44–12:03:41, bis 16 A); vorher kamen sie alle 20 s bis 3 min. Der Verdacht ist damit gestützt, eine längere einphasige Mitschrift steht noch aus. Mit „Schnell“ (Übersteuerung für die Ladung) schaltete die Box nach der 5-min-Pause auf drei Phasen, 11,04 kW, das Auto zog 16 A je Phase.
  - Bei jedem Start simuliert die go-e ein Abstecken (`modelStatus` 22), 10–20 s.
  - **Phasenwechsel im Feld:** bei 6,5–8,8 kW PV schaltete die Box auf drei Phasen; fiel die PV gleich danach unter 4,14 kW, blieb sie bis zu 5 min dreiphasig in Pause (Regel: mindestens 5 min zwischen zwei Umschaltungen, dreiphasig unter dem Minimum heißt Pause).
  - Eine **Verzögerung des Pausierens** bei „Nur Sonne“ (erst nach z. B. 2 min unter dem Minimum) ist zurückgestellt; sie würde das Versprechen „Nur Sonnenstrom“ aufweichen. Erst neu entscheiden, wenn einphasige Mitschriften ohne die go-e-Unterbrechungen noch häufige Stopps zeigen.
- **Noch offen:**
  1. Längeren einphasigen Ladetest (Überschuss 1,4–3,7 kW) mit `edge-light/test/ocpp-mitschrift.js` aufzeichnen: bleibt die go-e ohne eigenes „PhaseSwitch“? Wenn nicht: `psm=1` testen (fest einphasig, dreiphasig dann aus).
  2. go-e-Einrichtung: `mca` prüfen bzw. warnen, wenn größer als 6 A.
  3. Anzeige: das Portal zeigte die Wallbox nach einem Stopp noch mit 1,6 kW („Messwerte passen nicht zusammen“), die Box zeigt „lädt“ bei `SuspendedEVSE` mit 0 kW.
  4. Der Simulator (`ocppsim`) prüft nur das Ende eines Profils, keinen Beginn in der Zukunft – das go-e-Verhalten bildet er nicht ab.
- **Bekannt:**
  - Die go-e beantwortet die Rückfrage nach dem Ladeplan (`GetCompositeSchedule`) nicht; die Rücklesung bleibt „unbekannt“, die Wirkung zeigt die gemessene Leistung.
  - Die Statuszeile „Überschuss“ der Box nennt den Standort-Standard, nicht die Quelle des Ladepunkts; gerechnet wird richtig.
  - Nach einer Wahl „Sonne + Mindestleistung“ bleibt deren Wert am Ladepunkt stehen (API: `COALESCE`). Bei Steckern mit Phasenumschaltung zählt er nur noch bei „Sonne zuerst“.
- `feature/edge-light` trug #1380, #1382, #1383, #1385 und #1395 als Cherry-Picks; seit dem Merge vom 07.10.2026 kommen sie aus `main`.

### Zugang zum Pilot-Mango

| Weg | Adresse | Bedingung |
|---|---|---|
| Wartungstunnel (WireGuard `vpn.voltpilot.de:1001`, 10.10.1.0/24) | SSH `root@10.10.1.25` **Port 2222** | nur Schlüssel, **RSA** (Dropbear kennt kein Ed25519) |
| Web-App im Tunnel | `http://10.10.1.25:8484` | nur freigegebene Techniker-Adressen, bisher `10.10.1.5` |
| Vor Ort | WLAN `VoltPilot.de-zay5sdd`, `root@192.168.1.1` Port 22 | Host-Schlüssel prüfen (s. u.) |

Eingetragene Schlüssel (05.10.2026, am Gerät gelesen): `voltpilot-mango@desktop` (Max' Laptop, `10.10.1.5`) und `claude@CodeServer voltpilot-edge` (CodeServer, `10.10.1.26`, WireGuard im Userspace über `wireproxy`). Einen Zugang entzieht man mit dem Peer in wireguard-ui und der Zeile in `/etc/dropbear/authorized_keys`.

Ohne Freigabe in der Liste erreicht ein Rechner mit SSH-Zugang die Web-App über einen SSH-Tunnel: `ssh -p 2222 -L 8484:127.0.0.1:8484 root@10.10.1.25`, dann `http://localhost:8484`.

**Ein weiterer Rechner** braucht drei Dinge:
1. Einen eigenen Peer in wireguard-ui.
2. Seinen öffentlichen RSA-Schlüssel in `/etc/dropbear/authorized_keys` des Mango, eingetragen von einem Rechner, der schon Zugang hat, oder vor Ort.
3. Seine VPN-Adresse für die Web-App: `edge-light/openwrt/service-tunnel.sh root@10.10.1.25 web 10.10.1.5 <neue-ip>` (die Liste wird ersetzt; das Skript nutzt SSH, also mit `-p 2222` über einen Wrapper oder vor Ort mit `root@192.168.1.1`).

Ein **anderer GL.iNet-Router** nutzt ebenfalls 192.168.1.1 (WLAN „VoltPilot Energymanagement“). Der Mango hat den RSA-Host-Schlüssel `SHA256:9v/vmOZqCxM2vkV0IqYIjD3U3HL/Go44eeU83WTos8o`; bei einem anderen Schlüssel nicht verbinden. Die go-e (192.168.2.105, Kundennetz) ist nur aus dem Mango-WLAN erreichbar, nicht über den Tunnel.

**Neue Fassung einspielen:** `edge-light/scripts/build.sh mipsle`, `edge-light/openwrt/install.sh root@10.10.1.25` (SSH auf Port 2222, z. B. per Wrapper im `PATH`), dann `/etc/init.d/vp-edge-light restart`. Während des Neustarts gilt an der go-e die letzte Grenze noch bis zu 120 s.

### Werkzeuge für Feldtests

- `node edge-light/test/ocpp-mitschrift.js <datei.log> [http://10.10.1.25:8484]` schreibt alle 5 s eine Zeile: Messwerte, Zuteilung, Phasenzahl, Antwort der Säule.
- `edge-light/test/mango-gotest.sh <ziel> <paket> [-test.run …]` lässt Go-Tests auf dem Mango laufen, wenn sie lokal nicht starten (unter Windows blockiert die Anwendungssteuerung die Testprogramme). ⚠ **Nur ohne eingestecktes Auto:** Am 05.10. nahmen die Agenten-Tests der Box die CPU. Sie verlor dadurch rund 9 Minuten die Kontrolle über die go-e, und das Auto lud etwa 10–20 s ohne Grenze aus dem Netz. Das Skript bricht deshalb bei laufender Ladesitzung ab. Besser ist ein Linux-Rechner oder Docker (`edge-light/scripts/test.sh`).

## Ausgangslage und Ziel

- Einige Anlagen sind heute über **Home-Assistant-VMs auf eigenen Servern** angebunden. Beim Kunden steht ein **GL.iNet Mango (GL-MT300N-V2)**, der sich per **WireGuard** mit dem eigenen VPN verbindet und Zugriff auf die Geräte im Kundennetz gibt: **Deye-Datenlogger** und **go-e-Wallbox**.
- Gewünscht: **Anlagenmonitoring und PV-Überschussladen mit der go-e** über das VoltPilot-Portal, mit dem Mango als Edge-Gerät.
- Problem: Die Docker-Box (Go-Core + Node-RED + Updater, nur amd64/arm64) läuft nicht auf dem Mango (MIPS, 128 MB RAM, 16 MB Flash).
- **Entscheidung:** Edge Light – die Box als ein Programm ohne Docker und Node-RED. Seit 07.10.2026 (Produktentscheid) bestehen Edge Light und die Docker-Box **vorerst nebeneinander**, je nach Anwendungsfall: Edge Light für kleine Hardware und einfachere Anlagen, die Docker-Box für komplexere Anforderungen vor Ort. Die [Paritätsliste](paritaet.md) bleibt der Maßstab für den Funktionsumfang; ob die Docker-Box je umgestellt wird, ist offen.

## Entscheidungen

| Entscheidung | Begründung |
|---|---|
| Edge Light und die Docker-Box bestehen **vorerst nebeneinander** (07.10.2026; bis dahin: Edge Light als Nachfolger) | Je nach Anwendungsfall: kleine Hardware und einfachere Anlagen gegenüber komplexeren Anforderungen vor Ort. Edge Light bleibt der unveränderte Core plus Go-Schicht 1, also kein Sonderbau mit eigener Logik |
| **Ein Programm = unveränderter Core + Go-Schicht 1** | Alle Schutzregeln und Verträge des Cores gelten weiter |
| Die Go-Schicht 1 spricht über den **lokalen Bus** (dieselben Topics wie Node-RED) | Funktionen können einzeln von Node-RED nach Go umziehen ([architektur.md](architektur.md)) |
| Der Go-Code liegt in **`edge-app/core`**, nicht in `edge-light/` | Go erlaubt `internal/`-Pakete nur innerhalb des Moduls; eine Kopie wäre eine zweite Wahrheit |
| **Node-RED bleibt Quelle der Wahrheit**, Go-Zwillinge sind an **aus JS erzeugte Vektoren** gebunden | Kein stilles Auseinanderlaufen; JS-treue Rundung (`Math.round`) |
| Das Programm wird **bei jedem Start in den RAM geladen** | Der Flash ist zu klein für das unkomprimierte Programm |
| Überschussladen mit der go-e **über OCPP** (Core-Weg „Nur Sonnenstrom") | Folgt dem Überschuss stromgenau; der HTTP-Weg schaltet nur ab Schwelle mit Nennleistung |
| Keine Home-Assistant-Brücke | Projektbeschluss: nur eigene Gerätetreiber |

## Gebaut (Stufe 1) – damals Branch `feature/edge-light`, jetzt `main`

| Was | Wo |
|---|---|
| Programm `vp-edge-light` | `edge-app/core/cmd/vp-edge-light` |
| Gemeinsamer Programmrahmen mit `vp-edge-core` | `edge-app/core/internal/edgemain` (`vp-edge-core` ruft ihn jetzt auf, Verhalten unverändert) |
| Go-Schicht 1: Deye lesen, „Verbindung testen", Verbindungsstatus, eine Spur je Logger | `edge-app/core/internal/layer1` |
| go-e lesen (Stufe 3): Decoder | `edge-app/core/internal/goeapi` |
| Energiequellen in Schicht 1: go-e als Verbraucher lesen, „Verbindung testen" für go-e, andere Anbindungen je Quelle benannt | `edge-app/core/internal/layer1/sources.go`, `goe.go` |
| Solarman-V5-Protokoll | `edge-app/core/internal/solarmanv5` (+ Simulator `v5sim`) |
| Deye-Registerkarten und Dekodierung | `edge-app/core/internal/deyedecode` |
| Gemeinsame Vektoren (generiert) | `edge-app/nodered/deye/*-vectors.{gen.js,json,test.js}`, `edge-app/nodered/goe/goe-api-vectors.*` |
| Logger-Simulator (nur Tests) | `edge-app/core/cmd/vp-solarman-sim` |
| OpenWrt-Loader, procd-Dienst, UCI-Konfiguration, Installationsskript | `edge-light/openwrt/` |
| Bauen, Testen, Smoke-Test, Labortest | `edge-light/scripts/`, `edge-light/test/` |

**Belege:** gemeinsame Vektoren (23 Dekodier-, 50 Protokollfälle; go-e: 46 Fälle), fünf Mutationen erkannt (go-e: sieben), Integrationstest „Core liest go-e als Verbraucher", go-e am echten Mango gelesen ([mango.md](mango.md)), Integrationstest „unveränderter Core + Go-Schicht 1", MIPS-Programm unter qemu (Start 3 s, Messwerte korrekt, Verbindungstest ok), komplette Core-Suite grün (48 Pakete).

## Gemessen am echten Mango (Original-OpenWrt 25.12.5)

RAM 120 MB / ca. 65 MB verfügbar · `/tmp` 60 MB · Flash frei 9,4 MB (JFFS2) · `uclient-fetch`, `sha256sum`, `gunzip` vorhanden · HTTPS funktioniert · **kein root-Passwort gesetzt** · WireGuard auf dem Testgerät nicht aktiv. Programm: 13,8 MB, komprimiert 4,4 MB (gzip). Details: [mango.md](mango.md).

## Nächste Schritte

### 1. Sicherheit am Mango

```sh
passwd                                  # root-Passwort setzen
# besser: SSH-Schlüssel nach /etc/dropbear/authorized_keys und Passwort-Login abschalten
```

### 2. Labortest auf dem Mango (ca. 5 Minuten, kein Portal-Kontakt)

Vom eigenen Rechner aus, der den Mango per SSH erreicht:

```bash
git fetch && git checkout main
edge-light/scripts/test.sh                                   # alles grün?
edge-light/test/mango-labtest.sh <mango-ip>                   # nur Start + Messung
edge-light/test/mango-labtest.sh <mango-ip> <deye-ip> <logger-seriennummer> [modell-id]
edge-light/test/mango-labtest.sh stop <mango-ip>
```

- Vor dem Deye-Test **Home Assistant für diesen Logger abschalten** (der Logger bedient nur einen Client).
- Die Modell-ID steht im Katalog (`GET http://<mango-ip>:8484/api/inverter`), z. B. `sun-12k-sg04lp3` (hybrid_3p LV) oder `sun-30k-sg01hp3` (hybrid_3p HV).
- Ohne Deye ist das Skript am echten Mango gelaufen (03.10.2026, Messwerte in [mango.md](mango.md#labortest-am-gerät-mango-labtestsh-03102026-ohne-deye-ohne-portal)). Der Deye-Teil steht noch aus, weil der Logger beim Test offline war.
- Unter Windows (Git-Bash) nur mit LF-Dateien, siehe `.gitattributes`. Ohne gcc fehlt dort der Race-Detector, `test.sh` bricht dann bei Schritt 2 ab.

### 3. Pilot mit Loader und Portal

1. Root-Passwort setzen und einen **RSA**-Schlüssel hinterlegen (Dropbear kennt kein Ed25519).
2. `edge-light/scripts/build.sh mipsle`, dann `edge-light/openwrt/install.sh root@<mango-ip>` – legt die gepackte Kopie in den Flash; ein Download-Server ist nicht nötig (optional als zweites Argument `<base_url>`).
3. `/etc/init.d/vp-edge-light restart`, `logread -f -e vp-edge-light`. Am Mango geprüft: Start, Absturz, Neustart, kein Schreiben in den Flash ([mango.md](mango.md#lokale-kopie-im-flash-gebaut-am-gerät-geprüft-03102026)).
4. Auf `:8484` den Deye einrichten, die Box im Portal koppeln.
5. go-e per OCPP anbinden: in der go-e-App als OCPP-Server `ws://<mango-ip>:8887/ocpp/<kennung>` eintragen, die Kennung im Portal hinzufügen, Überschussladen „Nur Sonnenstrom" wählen. **Vorher** DHCP-Reservierung für den Mango im Kundenrouter und Firewall-Regel für 8887 aus dem Kundennetz – beides fehlt in `install.sh` (am Gerät gefunden, siehe [mango.md](mango.md#ocpp-mit-einer-echten-go-e-03102026-box-ungekoppelt-keine-anschlussgrenze)). Die Verbindung selbst ist mit einer echten go-e belegt.
6. 48 h beobachten (Pilotplan in [mango.md](mango.md)).

**Stand 04.10.2026:** Der Pilot-Mango läuft als Dienst aus der Kopie im Flash, liest den echten Deye (Logger am WLAN des Mango) und hat den Wartungstunnel (`10.10.1.25`, SSH 2222). Er ist beim Produktiv-Portal angemeldet (`edge-zay5sdd`) und wartet auf die Zuordnung zu einer Anlage. Noch offen: Tunnel-Test von einem anderen VPN-Gerät, Land `DE` im WLAN, Firewall-Regel/DHCP-Reservierung für OCPP.

⚠ Bis Stufe 2 nur auf Pilotanlagen: Die Echtheit des Programms hängt an HTTPS, nicht an einer Signatur.

### 4. Stufe 2 bauen ([boot-und-updates.md](boot-und-updates.md))

- Kleines Prüfprogramm `vp-light-boot` (Go, `internal/otaverify`) im Flash: prüft das signierte Release-Manifest gegen die eingebackene Wurzel.
- Vertrag `docs/contracts/ota-release-manifest.schema.json` additiv um Artefakt-Typ `binary` erweitern.
- Release-Lauf baut, signiert und verteilt die drei Programme; Portal-Route zum Ausliefern.
- Updates über die bestehende Zuweisung (`ems/…/v2/update`), Rückfall auf die zuletzt bestätigte Fassung.
- Die lokale Kopie im Flash ist gebaut (Stufe 1); Stufe 2 legt dort die zuletzt **bestätigte** Fassung ab und prüft sie wie den Download gegen die Signatur.
- CI: MIPS-Build (`GOARCH=mipsle GOMIPS=softfloat go build ./cmd/vp-edge-light`) als Prüfschritt aufnehmen und einmal von Hand anstoßen.

### 5. Stufe 3: Monitoring + Überschussladen vollständig

go-e lesen, weitere Energiequellen (Deye, go-e, generisches Modbus), geräte-eigene Exportgrenze des Deye. Danach weiter nach [paritaet.md](paritaet.md).

## Offene Entscheidungen

| Frage | Stand |
|---|---|
| HTTPS-Speicherort für Pilot und später | Pilot: nicht nötig (lokale Kopie im Flash); Stufe 2: Portal-Route vorgeschlagen |
| Kundenautomationen: Go-Laufzeit für den Flow-Katalog, Vertrag liefert dem Gerät dann den Flow-Graphen | Konzept nötig (Stufe 7) |
| Code-Knoten `vp.logic.function` (Kunden-JavaScript): JS-Interpreter in Go oder ablösen | offen |
| Node-RED-Editor als Servicezugang entfällt: Bestandsanlagen mit Handverdrahtung | vor dem Umstieg prüfen |

## Befund außerhalb von Edge Light

Der Node-RED-Knoten `vp-telemetrie` (`edge-app/nodered/vp-palette/nodes/vp-telemetrie.js`, Funktion `shape()`) lässt nur die Standardkanäle durch. Die BMS-Kanäle (`bms_*`) und `soc_source` des Deye erreichen den Core auf der Docker-Box deshalb nie, obwohl der Core sie ausdrücklich liest (`agent.go` `bmsChannels`). Bei CAN-gekoppelten Batterien fehlen sie dort. Vorschlag: `shape()` lässt `bms_*` (endliche Zahlen) und `soc_source` durch; Test in `vp-palette/test/` ergänzen. Edge Light gibt beide Felder bereits korrekt weiter.

## Falls der Mango nicht reicht: Hardware (Recherche Oktober 2026)

Wegen der Speicherknappheit sind 2-GB-Platinen stark teurer geworden; **1 GB reicht** (gemessen: VoltPilot-Stack mit Node-RED unter 150 MB, mit Docker und System ca. 350–450 MB).

| Gerät | Preis ca. |
|---|---|
| Raspberry Pi 4, 1 GB | ab 39,90 € (2 GB: ab 74,79 €) |
| Raspberry Pi 5, 1 GB | ab ca. 47 € (2 GB: ab 93,31 €) |
| NanoPi R3S-LTS, 1 GB, 2× LAN | 38 $ Platine / 45 $ mit Gehäuse (+ Import) |
| Fujitsu Futro S740 gebraucht (x86, 4 GB, eMMC) | ca. 35–45 € |

Speicher: mindestens 16 GB, besser 32 GB (Images ca. 1,3 GB, bei Updates bis 3–4 GB). Raspberry Pi 1/2/Zero (ARMv6/32 Bit) funktionieren nicht – die Images sind nur amd64/arm64.

## Prüfen vor jedem Commit

```bash
edge-light/scripts/test.sh            # Vektoren, Go-Tests mit Race-Detector, MIPS-Build
edge-light/test/qemu-smoke.sh         # MIPS-Programm unter Emulation
(cd edge-app/core && go test ./...)   # ganze Core-Suite; im Docker-Container das GANZE Repo einhängen,
                                      # sonst fehlen die Vertragsdateien unter docs/contracts
```

Ohne lokales Go nutzen die Skripte den Container `golang:1.24` und das Docker-Volume `vp-light-gocache` als Cache.
