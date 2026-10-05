# Übergabe: Stand und nächste Schritte (05.10.2026)

Diese Datei ist der Einstieg für die nächste Arbeitssitzung – für Menschen und für einen KI-Assistenten. Sie fasst zusammen, was seit dem 03.10.2026 entschieden, gebaut und gemessen wurde. Alles Weitere steht in den verlinkten Dokumenten.

## Stand 05.10.2026: Pilot Anlage Dirolf (`edge-zay5sdd`)

- **Auf dem Mango läuft** `edge-light-gff8746978` (Spitze von `feature/edge-light`). Der Deye wird gelesen, die go-e (`goe-300808`, Firmware 59.4) ist per OCPP eingerichtet (Sicherheitsprofile angenommen).
- **Überschussladen „Nur Sonne“ am Auto geprüft (Teil 1):** ohne Sonne teilt die Box 0 kW zu, die go-e hält zurück (`SuspendedEVSE`, 0,00 kW). Vorher lud sie dauerhaft mit 6,8 kW (behoben mit #1380, #1382, #1383).
- **go-e auf 16 A** (`ama`/`amp`, vorher 10/11 A), mit Freigabe des Betreibers; die Variante ist 11 kW/16 A, das Kabel 32 A.
- **Phasenumschaltung 1p/3p** ([OCPP-Steuerung](../../docs/ocpp-control.md)): PR #1385 ist in `main`, auf `feature/edge-light` übernommen und auf dem Mango. Die go-e meldet `ConnectorSwitch3to1PhaseSupported=true`.
- **Noch offen:**
  1. API und Portal mit #1385 deployen.
  2. Im Portal am Ladepunkt „Wallbox Garage“ unter „AC-Anschluss und Phasengrenzen“ den Knopf **Laden auf einer Phase erlauben** drücken; das geht mit eingestecktem Auto.
  3. Feldtest mit Sonne: einphasig ab 1,4 kW Überschuss, dreiphasig ab 4,1 kW, 60 s Wartezeit, mindestens 5 min zwischen zwei Umschaltungen. Steigender Überschuss wirkt erst nach einer Minute (Minimum der letzten 60 s), fallender sofort.
- **Bekannt:**
  - Die go-e beantwortet die Rückfrage nach dem Ladeplan (`GetCompositeSchedule`) nicht; die Rücklesung bleibt „unbekannt“, die Wirkung zeigt die gemessene Leistung.
  - Die Statuszeile „Überschuss“ der Box nennt den Standort-Standard, nicht die Quelle des Ladepunkts; gerechnet wird richtig.
  - Nach einer Wahl „Sonne + Mindestleistung“ bleibt deren Wert am Ladepunkt stehen (API: `COALESCE`). Bei Steckern mit Phasenumschaltung zählt er nur noch bei „Sonne zuerst“.
- `feature/edge-light` trägt #1380, #1382, #1383 und #1385 als Cherry-Picks; ein späterer Merge von `main` bringt dieselben Änderungen.

### Zugang zum Pilot-Mango

| Weg | Adresse | Bedingung |
|---|---|---|
| Wartungstunnel (WireGuard `vpn.voltpilot.de:1001`, 10.10.1.0/24) | SSH `root@10.10.1.25` **Port 2222** | nur Schlüssel, **RSA** (Dropbear kennt kein Ed25519) |
| Web-App im Tunnel | `http://10.10.1.25:8484` | nur freigegebene Techniker-Adressen, bisher `10.10.1.5` |
| Vor Ort | WLAN `VoltPilot.de-zay5sdd`, `root@192.168.1.1` Port 22 | Host-Schlüssel prüfen (s. u.) |

Ohne Freigabe in der Liste erreicht ein Rechner mit SSH-Zugang die Web-App über einen SSH-Tunnel: `ssh -p 2222 -L 8484:127.0.0.1:8484 root@10.10.1.25`, dann `http://localhost:8484`.

**Ein weiterer Rechner** braucht drei Dinge:
1. Einen eigenen Peer in wireguard-ui.
2. Seinen öffentlichen RSA-Schlüssel in `/etc/dropbear/authorized_keys` des Mango, eingetragen von einem Rechner, der schon Zugang hat, oder vor Ort.
3. Seine VPN-Adresse für die Web-App: `edge-light/openwrt/service-tunnel.sh root@10.10.1.25 web 10.10.1.5 <neue-ip>` (die Liste wird ersetzt; das Skript nutzt SSH, also mit `-p 2222` über einen Wrapper oder vor Ort mit `root@192.168.1.1`).

Ein **anderer GL.iNet-Router** nutzt ebenfalls 192.168.1.1 (WLAN „VoltPilot Energymanagement“). Der Mango hat den RSA-Host-Schlüssel `SHA256:9v/vmOZqCxM2vkV0IqYIjD3U3HL/Go44eeU83WTos8o`; bei einem anderen Schlüssel nicht verbinden. Die go-e (192.168.2.105, Kundennetz) ist nur aus dem Mango-WLAN erreichbar, nicht über den Tunnel.

**Neue Fassung einspielen:** `edge-light/scripts/build.sh mipsle`, `edge-light/openwrt/install.sh root@10.10.1.25` (SSH auf Port 2222, z. B. per Wrapper im `PATH`), dann `/etc/init.d/vp-edge-light restart`. Während des Neustarts gilt an der go-e die letzte Grenze noch bis zu 120 s.

### Werkzeuge für Feldtests

- `node edge-light/test/ocpp-mitschrift.js <datei.log> [http://10.10.1.25:8484]` schreibt alle 5 s eine Zeile: Messwerte, Zuteilung, Phasenzahl, Antwort der Säule.
- `edge-light/test/mango-gotest.sh <ziel> <paket> [-test.run …]` lässt Go-Tests auf dem Mango laufen, wenn sie lokal nicht starten (unter Windows blockiert die Anwendungssteuerung die Testprogramme). Die Grenzen stehen im Skriptkopf.

## Ausgangslage und Ziel

- Einige Anlagen sind heute über **Home-Assistant-VMs auf eigenen Servern** angebunden. Beim Kunden steht ein **GL.iNet Mango (GL-MT300N-V2)**, der sich per **WireGuard** mit dem eigenen VPN verbindet und Zugriff auf die Geräte im Kundennetz gibt: **Deye-Datenlogger** und **go-e-Wallbox**.
- Gewünscht: **Anlagenmonitoring und PV-Überschussladen mit der go-e** über das VoltPilot-Portal, mit dem Mango als Edge-Gerät.
- Problem: Die Docker-Box (Go-Core + Node-RED + Updater, nur amd64/arm64) läuft nicht auf dem Mango (MIPS, 128 MB RAM, 16 MB Flash).
- **Entscheidung:** Edge Light – die Box als ein Programm ohne Docker und Node-RED. **Ziel ist volle Gleichwertigkeit**, danach soll auch die Docker-Box darauf umgestellt werden ([paritaet.md](paritaet.md)).

## Entscheidungen

| Entscheidung | Begründung |
|---|---|
| Edge Light ist der **Nachfolger** der Docker-Box, kein Sonderbau | Eine dauerhaft zweite Variante wäre doppelte Pflege |
| **Ein Programm = unveränderter Core + Go-Schicht 1** | Alle Schutzregeln und Verträge des Cores gelten weiter |
| Die Go-Schicht 1 spricht über den **lokalen Bus** (dieselben Topics wie Node-RED) | Funktionen können einzeln von Node-RED nach Go umziehen ([architektur.md](architektur.md)) |
| Der Go-Code liegt in **`edge-app/core`**, nicht in `edge-light/` | Go erlaubt `internal/`-Pakete nur innerhalb des Moduls; eine Kopie wäre eine zweite Wahrheit |
| **Node-RED bleibt Quelle der Wahrheit**, Go-Zwillinge sind an **aus JS erzeugte Vektoren** gebunden | Kein stilles Auseinanderlaufen; JS-treue Rundung (`Math.round`) |
| Das Programm wird **bei jedem Start in den RAM geladen** | Der Flash ist zu klein für das unkomprimierte Programm |
| Überschussladen mit der go-e **über OCPP** (Core-Weg „Nur Sonnenstrom") | Folgt dem Überschuss stromgenau; der HTTP-Weg schaltet nur ab Schwelle mit Nennleistung |
| Keine Home-Assistant-Brücke | Projektbeschluss: nur eigene Gerätetreiber |

## Gebaut (Stufe 1) – Branch `feature/edge-light`

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
git fetch && git checkout feature/edge-light
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
