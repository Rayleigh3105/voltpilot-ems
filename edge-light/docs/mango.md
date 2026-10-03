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

Zwei Lücken für den Pilot, beide am Gerät gefunden:

1. **Firewall:** Die go-e steht im Kundennetz, also auf der WAN-Seite des Mango. Die WAN-Zone weist eingehend alles ab, `install.sh` öffnet 8887 nicht. Nötig ist eine Regel nur für das Kundennetz bzw. die Ladesäule, z. B. `uci add firewall rule` mit `src=wan`, `proto=tcp`, `dest_port=8887`, `src_ip=<kundennetz>/24`, `target=ACCEPT`.
2. **Feste WAN-Adresse:** Der Mango bekam während des Tests per DHCP eine neue WAN-Adresse (.111 → .108); die go-e lief danach ins Leere (Zeitüberschreitung, kein einziges Paket am Mango). Vor dem Eintragen der OCPP-URL eine **DHCP-Reservierung** für den Mango im Kundenrouter anlegen.

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

WireGuard bleibt unverändert der Servicezugang. Die Box selbst verbindet sich nur **ausgehend** (HTTPS und MQTT-TLS 8883) und braucht den Tunnel für den Betrieb nicht.

## Pilotplan auf einem echten Mango

1. Auf einer Anlage mit Deye: **Home Assistant für diesen Logger abschalten** – der Logger bedient nur einen Client.
2. `df -h`, `free -m` notieren (Ausgangslage).
3. `edge-light/openwrt/install.sh root@<mango-ip>`, Dienst starten, `logread -f -e vp-edge-light`.
4. Auf `:8484` den Deye einrichten, „Verbindung testen", im Portal koppeln.
5. 48 h laufen lassen und festhalten: Speicher (`free -m`, `/proc/<pid>/status` VmRSS), CPU (`top`), Ladezeit nach Neustart, Lücken im Verlauf, Vergleich mit den bisherigen Home-Assistant-Werten.
6. Danach: go-e per OCPP an `ws://<mango>:8887/ocpp/<kennung>` anbinden, Kennung im Portal eintragen, Überschussladen beobachten. Vorher DHCP-Reservierung für den Mango und Firewall-Regel für 8887 aus dem Kundennetz (siehe [OCPP-Test](#ocpp-mit-einer-echten-go-e-03102026-box-ungekoppelt-keine-anschlussgrenze)).
