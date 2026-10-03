# GL.iNet Mango (GL-MT300N-V2)

## Hardware

| | |
|---|---|
| Prozessor | MediaTek MT7628NN, MIPS 24KEc, 580 MHz, **ohne Gleitkomma-Einheit** |
| RAM | 128 MB DDR2 |
| Flash | 16 MB NOR |
| Netz | 1× WAN, 1× LAN (10/100 Mbit), WLAN 2,4 GHz |
| System | Original-OpenWrt (gemessen: 25.12.5, Paketverwaltung `apk`) |

## Gemessen am Gerät (Original-OpenWrt 25.12.5, 03.10.2026)

| | |
|---|---|
| RAM gesamt / verfügbar | 120 MB / **ca. 65 MB** (BusyBox-`free -m` zeigt kB) |
| `/tmp` (tmpfs, RAM) | 60 MB |
| Flash-Overlay gesamt / frei | 9,9 MB / **9,4 MB**, Dateisystem JFFS2 (komprimierend, verteilt den Verschleiß) |
| Werkzeuge des Loaders | `uclient-fetch`, `sha256sum`, `gunzip` vorhanden; HTTPS-Download funktioniert (TLS + Zertifikatsbündel im Image) |
| Root-Passwort | **keines gesetzt** – vor jedem Feldeinsatz `passwd` + SSH-Schlüssel |

## Gemessen ohne Gerät

| Messung | Ergebnis |
|---|---|
| Programmgröße `linux/mipsle`, softfloat, ohne Symbole | 13,8 MB (arm64: 12,4 MB) |
| … komprimiert | gzip -9: 4,4 MB · xz -9e: 3,0 MB |
| Start unter MIPS-Emulation | Web-App, lokaler Bus, OCPP-Server, Schlüsselerzeugung laufen; kein Absturz |
| Arbeitsspeicher des Cores (amd64, Simulator) | ca. 10 MB; Node-RED (entfällt) belegte 80–105 MB |
| Gleitkomma | Go bildet es auf MIPS in Software nach (`GOMIPS=softfloat`); die Last der Box (wenige Rechnungen pro Sekunde) ist dafür unkritisch – **auf echter Hardware zu bestätigen** |

## Speicherbudget

| Posten | ca. |
|---|---|
| verfügbar laut Gerät | 65 MB |
| Programm im tmpfs | − 14 MB |
| Prozess (Go-Laufzeit, Core, Schicht 1) | − 15–30 MB (Schätzung, beim Pilot messen), weich begrenzt über `GOMEMLIMIT=48MiB` |
| RAM-Verzeichnisse (Puffer bis 48 h, Ausgang, OCPP-Ereignisse) | wenige MB, wachsen bei langem Cloud-Ausfall |
| **Reserve** | **ca. 20–35 MB** |

Der Loader startet einen Download nur bei mindestens 40 MB freiem Speicher (`min_free_kb`).

## Notfall-Kopie im Flash (Vorschlag, noch nicht gebaut)

Mit 9,4 MB freiem Flash passt die komprimierte zuletzt bestätigte Fassung (4,4 MB gzip). Der Loader könnte sie entpacken, wenn beim Start kein Download gelingt (Stromausfall, Internet noch nicht zurück). Geschrieben würde sie nur nach einem bestätigten Update, also selten. Damit entfiele die Kehrseite des reinen RAM-Starts aus [boot-und-updates.md](boot-und-updates.md).

## Flash schonen

NOR-Flash verträgt Dauerschreiben schlecht. Deshalb liegen im RAM (`boot.sh`, `HOT_DIRS`):

- `buffer` – Messwert-Puffer (wird alle paar Sekunden geschrieben),
- `measurement-outbox` – Zusatzmesswerte vor dem Hochladen,
- `ocpp-journal` – OCPP-Ereignisse vor dem Hochladen.

Im Flash bleiben Identität, Zertifikat, Auswahl, Freigaben, Fahrplan-Cache (alle 15 min) und das OCPP-Befehlsbuch (Sicherheit: höchstens einmal ausführen, auch über einen Neustart).

**Folge:** Ein Stromausfall verliert Messwerte, die noch nicht in der Cloud sind, und noch nicht hochgeladene OCPP-Ereignisse. Bei einem Cloud-Ausfall puffert die Box weiter, solange sie läuft. Die Lücke wird heute nicht als solche gemeldet – das gehört in Stufe 2 (Lückenmeldung beim Start, wenn der Puffer leer statt erwartet gefüllt ist).

## Ports und WireGuard

| Port | Dienst | Hinweis |
|---|---|---|
| 8484 | lokale Web-App | LuCI bzw. die GL-Oberfläche belegen 80/443 |
| 8887 | OCPP für Ladesäulen | die go-e wählt `ws://<mango>:8887/ocpp/<kennung>` |
| 1883 | lokaler Bus | nur `127.0.0.1` sinnvoll; per Firewall nicht ins WAN |
| 502 | Modbus-Datenspiegel | standardmäßig aus |

WireGuard bleibt unverändert der Servicezugang. Die Box selbst verbindet sich nur **ausgehend** (HTTPS und MQTT-TLS 8883) und braucht den Tunnel für den Betrieb nicht.

## Pilotplan auf einem echten Mango

1. Auf einer Anlage mit Deye: **Home Assistant für diesen Logger abschalten** – der Logger bedient nur einen Client.
2. `df -h`, `free -m` notieren (Ausgangslage).
3. `edge-light/openwrt/install.sh`, Dienst starten, `logread -f -e vp-edge-light`.
4. Auf `:8484` den Deye einrichten, „Verbindung testen", im Portal koppeln.
5. 48 h laufen lassen und festhalten: Speicher (`free -m`, `/proc/<pid>/status` VmRSS), CPU (`top`), Ladezeit nach Neustart, Lücken im Verlauf, Vergleich mit den bisherigen Home-Assistant-Werten.
6. Danach: go-e per OCPP an `ws://<mango>:8887/ocpp/<kennung>` anbinden, Kennung im Portal eintragen, Überschussladen beobachten.
