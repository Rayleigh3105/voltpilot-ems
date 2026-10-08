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
| BusyBox | 1.37.0; **kein `nohup`** und kein `timeout`, dafür `setsid` und `start-stop-daemon` |
| SSH (Dropbear) | **nur RSA** (`server-sig-algs=rsa-sha2-256`): ein Ed25519-Schlüssel wird abgewiesen. Ohne Root-Passwort lässt Dropbear jede Anmeldung zu – ein Schlüsseltest ist dann nicht aussagekräftig |

## Labortest am Gerät (`mango-labtest.sh`, 03.10.2026, ohne Deye, ohne Portal)

| | |
|---|---|
| Start bis Web-App | 0,35 s laut Protokoll (2 s inkl. SSH und Abfrage) |
| Prozess (VmRSS) | 15 MB direkt nach dem Start, 17,7 MB nach 2 min (VmHWM 17,7 MB), 6 Threads |
| RAM verfügbar | 64 MB vorher → 37–40 MB mit Programm im tmpfs und laufendem Prozess |
| CPU | 0,9 % im Leerlauf (26 Ticks in 30 s aus `/proc/<pid>/stat`; `top -n 1` zeigt hier nur 0 %) |
| Ports | 8484 und 8887 auf allen Schnittstellen, lokaler Bus nur `127.0.0.1:1883` |
| Protokoll | nur die erwartete Warnung „Portal nicht erreichbar“ (Kopplung wiederholt), Schicht 1 „keine Auswahl“ |

Noch offen: Messwerte und „Verbindung testen“ am echten Deye (der Logger war beim Test offline) sowie Last unter Betrieb.

### OCPP mit einer echten go-e (03.10.2026, Box ungekoppelt, keine Anschlussgrenze)

go-e Charger V4, Firmware 59.4, im Kundennetz (WAN-Seite des Mango), Freigabe lokal über `POST :8484/api/ocpp/chargers`, kein Fahrzeug angesteckt.

| | |
|---|---|
| Verbindung | `ws://<mango-wan-ip>:8887/ocpp/goe-300808`, verbunden und angenommen ca. 4 s nach Setzen von `ocppu` (wirkt sofort, kein Aus/Ein nötig) |
| BootNotification | `go-e` / `go-eCharger_V4` / `59.4`, Anschluss 1 `Available` |
| Befehle an die go-e | keine: `ocppdp`, `ocppmp`, `ocpptp` blieben leer, `alw`/`amp` unverändert (ohne Anschlussgrenze erwartet) |
| Prozess | VmRSS 19 MB (VmHWM 20 MB), 9 Threads, CPU ca. 2 % (inkl. Abfragen der Web-App) |
| Nebenwirkung | die go-e übernimmt das Heartbeat-Intervall der Box (300 s) **dauerhaft** in `ocpph` |

### go-e lesen (03.10.2026, dieselbe go-e, Edge Light mit `internal/goeapi`)

Auf `:8484` als Verbraucher eingetragen (`POST /api/sources`), gelesen über die HTTP-API v2 alle 5 s:

| | |
|---|---|
| Verbindung testen (über den Core) | `{"ok":true,"reading":{"load_kw":0}}` (kein Auto angesteckt) |
| Im Core | Quelle `ok`, `load_kw` 0 mit aktuellem Zeitstempel |
| Prozess | VmRSS 17,9 MB, 7 Threads, CPU ca. 1 % (29 Ticks in 30 s) |
| Offen | die Watt-Deutung von `nrg[11]` bei echter Ladung (braucht ein ladendes Auto) |

### Deye am WLAN des Mango (04.10.2026, SUN-12K-SG04LP3, Logger 2739957886)

Der Datenlogger erreichte das Kunden-WLAN wegen der Entfernung nur schlecht. Er hängt jetzt am WLAN des Mango (`VoltPilot.de-<geraete-id>`, WPA2, Passwort je Box). Folgen: die Solarman-App des Kunden läuft über das NAT des Mango weiter; Geräte im Kundennetz erreichen den Logger nicht mehr direkt; nur noch Edge Light spricht mit ihm (ein Client).

| | |
|---|---|
| Logger | 192.168.1.160 per DHCP-Reservierung (`dhcp.deye_logger`), Signal −70 dBm |
| Suche | UDP 48899 im LAN des Mango antwortet sofort mit IP, MAC und Seriennummer (hinter NAT im Kundennetz kam keine Antwort) |
| Verbindung testen | `ok`: PV 3,01 kW, Verbrauch 0,52 kW, Netz 0,01 kW, SoC 19 % (plausibel: ~2,5 kW in die Batterie) |
| Laufend | `inverter_link` up, alle 5 s; **BMS-Block kommt im Core an** (`bms_*`, Strom −45 A) – auf der Docker-Box filtert ihn `vp-telemetrie` heraus |
| Prozess | VmRSS 20,3 MB, 9 Threads, CPU 1,5 %, 42 MB RAM frei |
| Flash | `network.json` (zuletzt genutzte Adresse von `:8484`) wird höchstens 1×/min geschrieben, aber nur solange jemand `:8484` benutzt – für Stufe 2 in den RAM oder nur bei Änderung schreiben |
| Offen | Land im WLAN noch nicht gesetzt (`wireless.radio0.country=DE`) |

### Wartungstunnel (04.10.2026, `edge-light/openwrt/service-tunnel.sh`)

WireGuard ins Service-VPN `vpn.voltpilot.de:1001` (`10.10.1.0/24`, verwaltet mit WireGuard UI), Adresse des Piloten `10.10.1.25`. Im Betriebssystem, unabhängig von vp-edge-light:

| | |
|---|---|
| Pakete | `kmod-wireguard`, `wireguard-tools` (+ ~300 KB Flash); **danach netifd neu starten** – ein reload kennt das Protokoll noch nicht |
| Erreichbar aus dem Tunnel | nur SSH auf `10.10.1.25:2222` (zweite Dropbear-Instanz, `-s -g`: keine Passwort-Anmeldung) und Ping; `:8484`, `:8887`, Port 22 abgewiesen. Web-App per `ssh -p 2222 -L 8484:127.0.0.1:8484 root@10.10.1.25` |
| Neu verbinden | `persistent_keepalive 25`; cron: `wireguard_watchdog` jede Minute, Neustart der Schnittstelle ohne Handshake seit 10 min |
| Schlüssel | Pilot: aus der WireGuard-UI-Datei übernommen (der VPN-Server kennt ihn); Flotte: auf der Box erzeugen (`service-tunnel.sh … key`) und nur den öffentlichen Schlüssel eintragen |
| Web-App im Tunnel | nur für benannte Techniker-Adressen: `service-tunnel.sh <ziel> web 10.10.1.5` (Pilot: Max Laptop) → `http://10.10.1.25:8484`; alle anderen VPN-Geräte bleiben draußen |
| Belegt | Handshake, Ping zum VPN-Server 25 ms; von einem VPN-Gerät (10.10.1.5) aus: Hostschlüssel = der aus dem LAN, SSH 2222 nur mit Schlüssel, `:8484` ohne Freigabe gesperrt, mit Freigabe HTTP 200; Software-Update über den Tunnel eingespielt (04.10.2026) |

Das Service-VPN ist ein gemeinsames Netz, in dem auch Kundensysteme hängen (HA-VMs, Router). Deshalb im Tunnel nur Schlüssel-SSH; serverseitig sollten Boxen und Kundensysteme einander nicht erreichen.

### Wartungsserver aus dem Portal (Fernwartung, Entscheid E5)

Neue Boxen bekommen ihren Tunnel nicht mehr im alten Service-VPN, sondern auf dem eigenen Wartungsserver (Vorgabe `wartung.voltpilot.de:51820`). Das Portal führt Schlüssel, Adresse und Fernwartungsfenster; der Tunnel-Dienst auf der VM setzt sie um. Techniker erreichen eine Box nur in einem offenen Fenster. Grundlage: [Fernwartung](../../docs/fernwartung.md).

`service-tunnel.sh` richtet standardmäßig diesen Tunnel ein (`VP_SERVICE_ZIEL=wartung`); `VP_SERVICE_ZIEL=alt` bleibt für den Piloten bis zum Wechsel.

| | Wartungsserver (`wartung`) | altes Service-VPN (`alt`) |
|---|---|---|
| Schnittstelle, Schlüssel | `wg_wartung`, `/etc/wireguard/vp-wartung.key` (auf der Box erzeugt) | `wg_service`, `/etc/wireguard/vp-service.key` |
| Gegenstelle | `VP_SERVICE_ENDPOINT` (`wartung.voltpilot.de`), Port 51820, Server-Schlüssel `VP_SERVICE_PUBKEY` aus dem Portal (Pflicht) | `vpn.voltpilot.de:1001`, fester Server-Schlüssel |
| Adresse | im Portal zugeteilt, Box-Netz `10.10.16.0/20` | in WireGuard UI vergeben, `10.10.1.0/24` |
| Erlaubtes Netz auf der Box | nur Techniker-Netz `10.10.32.0/24` | `10.10.1.0/24` |
| SSH | eigene Dropbear-Instanz `vp_wartung`, Port 2222, nur Schlüssel | Instanz `vp_service` |

Für eine neue Box:

1. `edge-light/openwrt/service-tunnel.sh root@192.168.1.1 key` gibt öffentlichen Schlüssel und Box-Referenz aus.
2. Im Portal unter **Geräte › Fernwartung › Tunnel-Schlüssel hinterlegen** eintragen. Das Portal teilt die Adresse zu und zeigt die fertige Befehlszeile.
3. Die Befehlszeile ausführen, mit der Box als Ziel.

Beide Tunnel können nebeneinander laufen: Die Zone `service` umfasst alle Tunnel-Schnittstellen, und jede bekommt ihre eigene Dropbear-Instanz und ihren eigenen Wächter. `service-tunnel.sh <ziel> abbauen <schnittstelle>` entfernt einen Tunnel vollständig und verweigert das, solange die SSH-Sitzung über genau diesen Tunnel läuft. `service-tunnel.sh <ziel> status` zeigt beide.

Geprüft mit `edge-light/test/service-tunnel-probe.sh` gegen OpenWrt 24.10 im Container (procd, netifd, fw4, Dropbear, cron, Kernel-WireGuard): Altbestand, neuer Tunnel daneben, Wiederholbarkeit, Schutz beim Abbauen, alten Tunnel abbauen, Web-Freigabe. Der Mango läuft mit 25.12; der Handshake mit einem echten Server ist dort noch nicht belegt.

### Wechsel des Piloten auf den Wartungsserver (beaufsichtigt, noch nicht ausgeführt)

Der Pilot (`edge-zay5sdd`, heute `10.10.1.25` im alten VPN) wechselt erst, wenn der Wartungsserver steht. Der alte Tunnel bleibt bis zum letzten Schritt bestehen, so ist die Box jederzeit über einen Weg erreichbar. „Beaufsichtigt" heißt: ein Mensch führt jeden Schritt aus und prüft das Ergebnis, und jemand kommt im Notfall vor Ort an den Mango (WLAN `VoltPilot.de-zay5sdd`, `root@192.168.1.1`).

**Voraussetzungen:**

- Die VM steht, die API kennt den Server-Schlüssel, und im Portal steht „Tunnel-Dienst holt ab".
- Für den Rechner des Technikers gibt es einen Zugang im Portal, und er ist als zweites WireGuard-Profil neben dem alten VPN eingerichtet.
- In `~/.ssh/config` zwei Namen für dieselbe Box: `mango-alt` (`HostName 10.10.1.25`, `Port 2222`, `User root`) und `mango-neu` (die neue Adresse, `Port 2222`, `User root`).

**Schritte:**

1. Über den alten Tunnel den neuen Schlüssel erzeugen: `edge-light/openwrt/service-tunnel.sh mango-alt key`. Der alte Schlüssel bleibt unberührt.
2. Im Portal Schlüssel und Referenz `edge-zay5sdd` hinterlegen; das Portal nennt die Adresse im Box-Netz.
3. Über den alten Tunnel den neuen einrichten: die Befehlszeile aus dem Portal, mit `mango-alt` statt `root@<box>`. Danach laufen beide Tunnel.
4. Im Portal ein Fenster öffnen: Box `edge-zay5sdd`, der eigene Zugang, 1 Stunde, Grund „Wechsel auf den Wartungsserver".
5. Über den neuen Weg prüfen: `ssh mango-neu`. Der Host-Schlüssel muss `SHA256:9v/vmOZqCxM2vkV0IqYIjD3U3HL/Go44eeU83WTos8o` sein, sonst abbrechen. Dann `edge-light/openwrt/service-tunnel.sh mango-neu status` (Handshake auf `wg_wartung`).
6. Nur wenn Schritt 5 gelingt: über den **neuen** Weg den alten Tunnel abbauen: `edge-light/openwrt/service-tunnel.sh mango-neu abbauen wg_service`.
7. Fenster im Portal schließen oder ablaufen lassen. Die Web-App im Tunnel bei Bedarf neu freigeben: `service-tunnel.sh mango-neu web <techniker-adresse>`.
8. Optional und von Hand durch den Kapitän: den Peer des Piloten in WireGuard UI auf `vpn.voltpilot.de` entfernen. Die Fernwartung ändert dort nichts.

**Rückweg:** Bis Schritt 6 ist nichts verloren. Kommt der neue Tunnel nicht, baut man ihn über den alten wieder ab: `service-tunnel.sh mango-alt abbauen wg_wartung`. Nach Schritt 6 ohne funktionierenden neuen Tunnel hilft nur noch der Zugang vor Ort. Die SSH-Schlüssel in `/etc/dropbear/authorized_keys` bleiben beim Wechsel gleich, sie sind weiterhin die zweite Schranke.

Zwei Lücken für den Pilot, beide am Gerät gefunden:

1. **Firewall:** Die go-e steht im Kundennetz, also auf der WAN-Seite des Mango. Die WAN-Zone weist eingehend alles ab, `install.sh` öffnet 8887 nicht. Nötig ist eine Regel nur für das Kundennetz bzw. die Ladesäule, z. B. `uci add firewall rule` mit `src=wan`, `proto=tcp`, `dest_port=8887`, `src_ip=<kundennetz>/24`, `target=ACCEPT`.
2. **Feste WAN-Adresse:** Der Mango bekam während des Tests per DHCP eine neue WAN-Adresse (.111 → .108); die go-e lief danach ins Leere (Zeitüberschreitung, kein einziges Paket am Mango). Vor dem Eintragen der OCPP-URL eine **DHCP-Reservierung** für den Mango im Kundenrouter anlegen.

## Gemessen ohne Gerät

| Messung | Ergebnis |
|---|---|
| Programmgröße `linux/mipsle`, softfloat, ohne Symbole | 13,8 MB (arm64: 12,4 MB); 07.10.2026 nach dem Merge von `main`: 13,9 MiB (14 614 743 B), gzip -9 4 679 121 B |
| … komprimiert | gzip -9: 4,4 MB · xz -9e: 3,0 MB |
| Start unter MIPS-Emulation | Web-App, lokaler Bus, OCPP-Server, Schlüsselerzeugung laufen; kein Absturz |
| Arbeitsspeicher des Cores (amd64, Simulator) | ca. 10 MB; Node-RED (entfällt) belegte 80–105 MB |
| Gleitkomma | Go bildet es auf MIPS in Software nach (`GOMIPS=softfloat`); die Last der Box (wenige Rechnungen pro Sekunde) ist dafür unkritisch – **auf echter Hardware zu bestätigen** |

## Speicherbudget

| Posten | ca. |
|---|---|
| verfügbar laut Gerät | 65 MB |
| Programm im tmpfs | − 14 MB |
| Prozess (Go-Laufzeit, Core, Schicht 1) | − 15–30 MB (ohne Gerät gemessen: 16–18 MB; mit Deye und go-e beim Pilot nachmessen), weich begrenzt über `GOMEMLIMIT=48MiB` |
| RAM-Verzeichnisse (Puffer bis 48 h, Ausgang, OCPP-Ereignisse) | wenige MB, wachsen bei langem Cloud-Ausfall |
| **Reserve** | **ca. 20–35 MB** |

Der Loader startet einen Download nur bei mindestens 40 MB freiem Speicher (`min_free_kb`).

## Lokale Kopie im Flash (gebaut, am Gerät geprüft 03.10.2026)

`install.sh` legt das Programm gepackt nach `/usr/share/vp-edge-light/` (4,4 MB gzip + `.sha256` des ungepackten Programms, auf dem Gerät nachgeprüft). Der Loader nimmt: Download (nur mit `base_url`) → die schon geladene Fassung im RAM → die lokale Kopie. Geschrieben wird die Kopie nur bei einer Installation, also selten. Flash danach: 4,9 MB frei.

| Test am Mango | Ergebnis |
|---|---|
| Start aus der Kopie | entpackt, Prüfsumme bestätigt, Web-App nach 11 s |
| Absturz (`kill -9`) | procd startet nach 10 s neu, die Fassung im RAM wird wiederverwendet (kein erneutes Entpacken), wieder da nach 16 s |
| Neustart des Mango | Dienst startet von selbst 123 s nach dem Kernel (procd selbst ist nach ~100 s fertig), dieselbe Geräte-ID |
| Flash im Betrieb | 3 min ohne eine einzige geschriebene Datei (`find /overlay/upper -newer`) |
| Fehler aus Stufe 1 | `boot.sh` lief mit `set -u` und brach in `/lib/functions.sh` ab (`IPKG_INSTROOT`) – behoben |

## Flash schonen

NOR-Flash verträgt Dauerschreiben schlecht. Deshalb liegen im RAM (`boot.sh`, `HOT_DIRS`):

- `buffer` – Messwert-Puffer (wird alle paar Sekunden geschrieben),
- `measurement-outbox` – Zusatzmesswerte vor dem Hochladen,
- `ocpp-journal` – OCPP-Ereignisse vor dem Hochladen,
- `ota` – der Core schreibt `ota/core-signal.json` **alle 2 s**; Stufe 1 hält dort nichts Dauerhaftes (Stufe 2 muss Trust-Set und `current.json` in den Flash legen).

Im Flash bleiben Identität, Zertifikat, Auswahl, Freigaben, Fahrplan-Cache (alle 15 min) und das OCPP-Befehlsbuch (Sicherheit: höchstens einmal ausführen, auch über einen Neustart).

**Folge:** Ein Stromausfall verliert Messwerte, die noch nicht in der Cloud sind, und noch nicht hochgeladene OCPP-Ereignisse. Bei einem Cloud-Ausfall puffert die Box weiter, solange sie läuft. Die Lücke wird heute nicht als solche gemeldet – das gehört in Stufe 2 (Lückenmeldung beim Start, wenn der Puffer leer statt erwartet gefüllt ist).

## Ports und WireGuard

| Port | Dienst | Hinweis |
|---|---|---|
| 8484 | lokale Web-App | LuCI bzw. die GL-Oberfläche belegen 80/443 |
| 8887 | OCPP für Ladesäulen | die go-e wählt `ws://<mango>:8887/ocpp/<kennung>` |
| 1883 | lokaler Bus | nur `127.0.0.1` sinnvoll; per Firewall nicht ins WAN |
| 502 | Modbus-Datenspiegel | standardmäßig aus |

WireGuard bleibt der Servicezugang, künftig zum Wartungsserver (UDP 51820, [oben](#wartungsserver-aus-dem-portal-fernwartung-entscheid-e5)). Die Box selbst verbindet sich nur **ausgehend** (HTTPS, MQTT-TLS 8883 und der Tunnel) und braucht den Tunnel für den Betrieb nicht.

## Pilotplan auf einem echten Mango

1. Auf einer Anlage mit Deye: **Home Assistant für diesen Logger abschalten** – der Logger bedient nur einen Client.
2. `df -h`, `free -m` notieren (Ausgangslage).
3. `edge-light/openwrt/install.sh root@<mango-ip>`, Dienst starten, `logread -f -e vp-edge-light`.
4. Auf `:8484` den Deye einrichten, „Verbindung testen", im Portal koppeln.
5. 48 h laufen lassen und festhalten: Speicher (`free -m`, `/proc/<pid>/status` VmRSS), CPU (`top`), Ladezeit nach Neustart, Lücken im Verlauf, Vergleich mit den bisherigen Home-Assistant-Werten.
6. Danach: go-e per OCPP an `ws://<mango>:8887/ocpp/<kennung>` anbinden, Kennung im Portal eintragen, Überschussladen beobachten. Vorher DHCP-Reservierung für den Mango und Firewall-Regel für 8887 aus dem Kundennetz (siehe [OCPP-Test](#ocpp-mit-einer-echten-go-e-03102026-box-ungekoppelt-keine-anschlussgrenze)).
