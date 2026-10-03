# Übergabe: Stand und nächste Schritte (03.10.2026)

Diese Datei ist der Einstieg für die nächste Arbeitssitzung – für Menschen und für einen KI-Assistenten. Sie fasst zusammen, was in der Sitzung vom 03.10.2026 entschieden, gebaut und gemessen wurde. Alles Weitere steht in den verlinkten Dokumenten.

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
| Solarman-V5-Protokoll | `edge-app/core/internal/solarmanv5` (+ Simulator `v5sim`) |
| Deye-Registerkarten und Dekodierung | `edge-app/core/internal/deyedecode` |
| Gemeinsame Vektoren (generiert) | `edge-app/nodered/deye/*-vectors.{gen.js,json,test.js}` |
| Logger-Simulator (nur Tests) | `edge-app/core/cmd/vp-solarman-sim` |
| OpenWrt-Loader, procd-Dienst, UCI-Konfiguration, Installationsskript | `edge-light/openwrt/` |
| Bauen, Testen, Smoke-Test, Labortest | `edge-light/scripts/`, `edge-light/test/` |

**Belege:** gemeinsame Vektoren (23 Dekodier-, 50 Protokollfälle), fünf Mutationen erkannt, Integrationstest „unveränderter Core + Go-Schicht 1", MIPS-Programm unter qemu (Start 3 s, Messwerte korrekt, Verbindungstest ok), komplette Core-Suite grün (48 Pakete).

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
- Das Skript ist **noch nicht gegen echte Hardware gelaufen**. Messwerte danach in [mango.md](mango.md) eintragen: Startzeit, VmRSS, freier RAM, CPU.

### 3. Pilot mit Loader und Portal

1. Entscheiden, wo das Programm per HTTPS liegt (eigener Server reicht): `<base_url>/latest/vp-edge-light-linux-mipsle` + `.sha256`.
2. `edge-light/scripts/build.sh mipsle`, Dateien hochladen.
3. `edge-light/openwrt/install.sh root@<mango-ip> <base_url>`, dann `/etc/init.d/vp-edge-light start`, `logread -f -e vp-edge-light`.
4. Auf `:8484` den Deye einrichten, die Box im Portal koppeln.
5. go-e per OCPP anbinden: in der go-e-App als OCPP-Server `ws://<mango-ip>:8887/ocpp/<kennung>` eintragen, die Kennung im Portal hinzufügen, Überschussladen „Nur Sonnenstrom" wählen.
6. 48 h beobachten (Pilotplan in [mango.md](mango.md)).

⚠ Bis Stufe 2 nur auf Pilotanlagen: Die Echtheit des Programms hängt an HTTPS, nicht an einer Signatur.

### 4. Stufe 2 bauen ([boot-und-updates.md](boot-und-updates.md))

- Kleines Prüfprogramm `vp-light-boot` (Go, `internal/otaverify`) im Flash: prüft das signierte Release-Manifest gegen die eingebackene Wurzel.
- Vertrag `docs/contracts/ota-release-manifest.schema.json` additiv um Artefakt-Typ `binary` erweitern.
- Release-Lauf baut, signiert und verteilt die drei Programme; Portal-Route zum Ausliefern.
- Updates über die bestehende Zuweisung (`ems/…/v2/update`), Rückfall auf die zuletzt bestätigte Fassung.
- **Notfall-Kopie im Flash** (4,4 MB gzip passt): startet die Box nach einem Stromausfall auch ohne Internet.
- CI: MIPS-Build (`GOARCH=mipsle GOMIPS=softfloat go build ./cmd/vp-edge-light`) als Prüfschritt aufnehmen und einmal von Hand anstoßen.

### 5. Stufe 3: Monitoring + Überschussladen vollständig

go-e lesen, weitere Energiequellen (Deye, go-e, generisches Modbus), geräte-eigene Exportgrenze des Deye. Danach weiter nach [paritaet.md](paritaet.md).

## Offene Entscheidungen

| Frage | Stand |
|---|---|
| HTTPS-Speicherort für Pilot und später | offen (Pilot: eigener Server; Stufe 2: Portal-Route vorgeschlagen) |
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
