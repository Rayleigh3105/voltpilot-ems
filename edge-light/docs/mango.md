# GL.iNet Mango (GL-MT300N-V2)

## Hardware

| | |
|---|---|
| Prozessor | MediaTek MT7628NN, MIPS 24KEc, 580 MHz, **ohne Gleitkomma-Einheit** |
| RAM | 128 MB DDR2 |
| Flash | 16 MB NOR |
| Netz | 1× WAN, 1× LAN (10/100 Mbit), WLAN 2,4 GHz |
| System | Original-OpenWrt (gemessen: 25.12.5, Paketverwaltung `apk`) |
| Gehäuse | Für die nackte Platine gibt es ein 3D-gedrucktes Gehäuse mit VoltPilot-Logo (liegend, an der Wand, Clip für die Hutschiene als Zubehör): [Modell, Druckdateien, Druck- und Montageanleitung](../gehaeuse/glinet-gl-mt300n-v2/README.md); dort steht auch das [Maßmodell der Platine](../gehaeuse/glinet-gl-mt300n-v2/docs/massmodell.md) |

## Gemessen am Gerät (Original-OpenWrt 25.12.5, 03.10.2026)

| | |
|---|---|
| RAM gesamt / verfügbar | 120 MB / **ca. 65 MB** (BusyBox-`free -m` zeigt kB) |
| `/tmp` (tmpfs, RAM) | 60 MB |
| Flash-Overlay gesamt / frei | 9,9 MB / **9,4 MB**, Dateisystem JFFS2 (komprimierend, verteilt den Verschleiß) |
| Werkzeuge des Loaders | `uclient-fetch`, `sha256sum`, `gunzip` vorhanden; HTTPS-Download funktioniert (TLS + Zertifikatsbündel im Image) |
| Root-Passwort | **keines gesetzt**. Vor dem Verlassen der Werkstatt setzen: [Werkstatt-Regel](#bevor-eine-box-die-werkstatt-verlässt) |
| BusyBox | 1.37.0; **kein `nohup`**, kein `timeout`, kein `diff` (Vergleiche mit `cmp -s` oder `sha256sum -c`), und **`nc` kennt kein `-w`** (gibt dann nur die Hilfe aus und sendet nichts). Dafür `setsid` und `start-stop-daemon`; Proben wie [unten](#proben-von-der-box-busybox-unter-2512) |
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
| SSH | Port 2222, nur Schlüssel, nur aus dem Tunnel: die Instanz der [Fenster-Schlüssel](#fenster-schlüssel-auf-der-box) (`/etc/init.d/vp-wartung`) | UCI-Instanz `vp_service`, nur dauerhafte Schlüssel |
| Web-App `:8484` im Tunnel | frei für das ganze Techniker-Netz, sobald der Tunnel eingerichtet ist (Regel `Allow-Service-Web-Wartung`) | nur je Adresse: `service-tunnel.sh <ziel> web <adresse>` |
| Server von der Box aus | `10.10.32.1`. Die Box sendet nur ins Techniker-Netz; `10.10.16.1`, die Server-Adresse ihres eigenen Netzes, erreicht sie **nicht** | – |

Für eine neue Box:

1. `edge-light/openwrt/service-tunnel.sh root@192.168.1.1 key` gibt öffentlichen Schlüssel und Box-Referenz aus.
2. Im Portal unter **Geräte › Fernwartung › Tunnel-Schlüssel hinterlegen** eintragen. Das Portal teilt die Adresse zu und zeigt die fertige Befehlszeile.
3. Die Befehlszeile ausführen, mit der Box als Ziel. Sie richtet den Tunnel, SSH auf 2222 mit Fenster-Schlüsseln und die Web-App auf 8484 ein. Ein weiterer Aufruf je Techniker ist nicht nötig, und kein Techniker-Schlüssel muss auf die Box. Die letzten Zeilen sagen, wer sich anmelden darf und ob der Wartungsserver schon Schlüssel ausgibt.
4. Prüfen: `service-tunnel.sh <ziel> status` zeigt den Handshake, `Web-App 8484 im Tunnel: Techniker-Netz 10.10.32.0/24`, `SSH 2222 ausserhalb der Tunnel: abgewiesen` und `Fenster-Schluessel: Abholer laeuft` mit der letzten gültigen Antwort des Servers. Von der Box aus antwortet `ping 10.10.32.1`.
5. Im Portal ein Fenster öffnen, für einen Zugang mit SSH-Schlüssel. Solange es offen ist, erreicht der Techniker `ssh -i ~/.ssh/id_rsa_voltpilot -p 2222 root@<adresse>` und `http://<adresse>:8484`. Das Portal zeigt an der Box „Box verbunden“ und am Fenster „Alles bereit“, sobald die Box den Schlüssel abgeholt hat ([Rückmeldung](../../docs/fernwartung.md#rückmeldung-des-tunnel-dienstes)).
6. Die [Werkstatt-Regel](#bevor-eine-box-die-werkstatt-verlässt) abarbeiten, bevor die Box verpackt wird.

Das Skript meldet sich mit `ssh` an der Box an. `VP_SSH_KEY=~/.ssh/<schlüssel>` vor dem Aufruf nennt die Schlüsseldatei; ohne die Variable entscheidet `~/.ssh/config`.

Beide Tunnel können nebeneinander laufen: Die Zone `service` umfasst alle Tunnel-Schnittstellen, und jede bekommt ihre eigene Dropbear-Instanz und ihren eigenen Wächter. `service-tunnel.sh <ziel> abbauen <schnittstelle>` entfernt einen Tunnel vollständig und verweigert das, solange die SSH-Sitzung über genau diesen Tunnel läuft. `service-tunnel.sh <ziel> status` zeigt beide.

#### Bevor eine Box die Werkstatt verlässt

**Werkstatt-Regel:** Keine Box verlässt die Werkstatt ohne Root-Passwort und ohne Anmeldeprobe über Portal und Tunnel. Eine Box, bei der die Anmeldung erst beim Kunden scheitert, ist nur noch mit einer Fahrt dorthin erreichbar.

| # | Schritt | Woran man es sieht |
|---|---|---|
| 1 | **Root-Passwort setzen:** an der Box `passwd`. Das Passwort gehört in die Passwortablage, nicht in dieses Repository | danach verlangt `ssh root@192.168.1.1` (Port 22, LAN) ein Passwort oder einen Schlüssel. Ohne Passwort lässt die Mango im LAN jeden ohne beides hinein |
| 2 | **Dauerhafter Schlüssel:** genau einer, der [Notfall-Schlüssel](#dauerhafte-schlüssel-ein-notfall-schlüssel) | `wc -l < /etc/dropbear/authorized_keys` nennt `1` |
| 3 | **Tunnel einrichten** (Schritte 1 bis 4 oben) | `service-tunnel.sh <ziel> status`: Handshake, `SSH 2222 ausserhalb der Tunnel: abgewiesen`, `Fenster-Schluessel: Abholer laeuft` mit einer gültigen Antwort |
| 4 | **Anmeldeprobe über Portal und Tunnel:** im Portal ein Fenster für den eigenen Zugang öffnen (15 Minuten, Grund „Werkstatt-Probe“) und sich von einem Techniker-Gerät anmelden, das **keinen** dauerhaften Schlüssel auf der Box hat: `ssh -i ~/.ssh/id_rsa_voltpilot -o IdentitiesOnly=yes -p 2222 root@<adresse>` | im Portal am Fenster „Alles bereit“; die Anmeldung gelingt; auf der Box nennt `logread -e dropbear \| grep 'Pubkey auth' \| tail -1` den Fingerabdruck aus dem Portal |
| 5 | **Host-Schlüssel notieren:** den Fingerabdruck, den `ssh` bei der ersten Anmeldung zeigt, zur Box-Referenz ins Übergabeprotokoll | beim Kunden bestätigt der Techniker ihn nicht mehr blind |
| 6 | **Fenster schließen** und den Versuch wiederholen | die Sitzung endet, der neue Versuch endet mit `Connection timed out`; im Portal steht kein offenes Fenster mehr; auf der Box nennt `logread -e vp-wartung \| grep 'Sitzung beendet'` die Sitzung von eben |

Scheitert Schritt 4, sagt das Portal am Fenster, woran: „Box nicht verbunden“ (Tunnel, Schritt 3), „Schlüssel noch nicht abgeholt“ (Abholer oder Schlüsselausgabe des Servers), „Kein SSH-Schlüssel am Zugang“ (im Portal hinterlegen) oder „Stand unbekannt“ (der Tunnel-Dienst meldet nicht). Die Box bleibt in der Werkstatt, bis die Probe gelingt.

#### Dauerhafte Schlüssel: ein Notfall-Schlüssel

Entscheid des Kapitäns (K2 a, 08.10.2026), für die Pilotphase: Auf jeder Box liegt **genau ein** dauerhafter Schlüssel, ein Notfall-Schlüssel des Kapitäns. Jeder Techniker meldet sich sonst mit seinem Fenster-Schlüssel an. Nach einigen Monaten Betrieb wird neu entschieden, ob auch dieser eine entfällt.

**Warum einer bleibt:** Ein Fehler im neuen Weg (Portal, Wartungsserver, Abholer) sperrte sonst alle aus Boxen aus, die beim Kunden stehen. **Warum nur einer:** Ein dauerhafter Schlüssel umgeht die Schranke „kein Fenster, kein Schlüssel“. Öffnet ein Fehler der Server-Firewall den Port, kommt damit hinein, wer so einen Schlüssel hat; in der Probe ist das belegt (`wartung-anmeldung-probe.sh`, Schritt 3). Der Netzweg bleibt auch für ihn ans Fenster gebunden.

**Zielzustand je Box:**

- `/etc/dropbear/authorized_keys` hat genau eine Zeile: den öffentlichen Teil des Notfall-Schlüssels, RSA mit 3072 oder 4096 Bit (die Mango nimmt nur RSA an).
- Der private Teil ist mit einem Kennwort geschützt und liegt **getrennt**: nicht auf dem Laptop, mit dem der Kapitän täglich arbeitet, nicht auf der Arbeitsmaschine, nicht auf dem Wartungsserver und nicht in diesem Repository. Gedacht ist ein Datenträger im Tresor, dazu eine zweite Kopie an einem anderen Ort.
- Ein Schlüssel für alle Boxen. Sein Fingerabdruck (`ssh-keygen -lf`) steht in der Passwortablage, damit sich an jeder Box prüfen lässt, dass genau er dort liegt.
- Er wird nur benutzt, wenn der Weg über das Portal nicht geht, und jede Benutzung wird notiert.

**Der Weg dorthin, je Box, als Schritte für den Kapitän.** Nichts davon ist ausgeführt; an keinem Gerät wurde dafür etwas geändert.

1. **Einmal, vor der ersten Box:** den Notfall-Schlüssel auf einem Rechner erzeugen, der danach nicht der Aufbewahrungsort ist: `ssh-keygen -t rsa -b 4096 -C voltpilot-notfall -f voltpilot-notfall` mit Kennwort. Die Datei `voltpilot-notfall` (privat) auf die beiden Datenträger legen und vom Rechner löschen; `voltpilot-notfall.pub` und den Fingerabdruck behalten.
2. **An der Box anmelden,** über einen Weg, der heute geht, und die Sitzung offen lassen, bis Schritt 5 gelungen ist.
3. **Den Notfall-Schlüssel dazulegen,** noch nichts entfernen: die Zeile aus `voltpilot-notfall.pub` ans Ende von `/etc/dropbear/authorized_keys`. Im Tunnel gilt sie nach spätestens einer Minute.
4. **Mit dem Notfall-Schlüssel anmelden,** in einem offenen Fenster, in einer zweiten Sitzung: `ssh -i <datenträger>/voltpilot-notfall -o IdentitiesOnly=yes -p 2222 root@<adresse>`. Gelingt das nicht, bei Schritt 3 bleiben.
5. **Erst dann die übrigen Zeilen entfernen:** in der Sitzung aus Schritt 4 `/etc/dropbear/authorized_keys` auf die eine Zeile kürzen. Prüfen: `wc -l < /etc/dropbear/authorized_keys` nennt `1`, und der Fingerabdruck, den das Log der Box zur Anmeldung aus Schritt 4 nennt (`logread -e dropbear | grep 'Pubkey auth' | tail -1`), ist der des Notfall-Schlüssels (am eigenen Rechner: `ssh-keygen -lf voltpilot-notfall.pub`).
6. **Gegenprobe:** Mit einem der entfernten Schlüssel endet die Anmeldung im offenen Fenster mit `Permission denied (publickey)`; mit dem Fenster-Schlüssel aus dem Portal gelingt sie.
7. **Notieren:** Box, Datum, welche Schlüssel entfernt wurden.

| Box | Dauerhafte Schlüssel heute | Was der Wechsel braucht |
|---|---|---|
| Labor-Mango `edge-5t2dcy6` | einer: der der Arbeitsmaschine (`voltpilot-edge`, am Gerät gelesen am 09.10.2026) | Notfall-Schlüssel und das Wort des Kapitäns. Danach erreicht die Arbeitsmaschine die Box über Port 22 nicht mehr mit ihrem Schlüssel; Proben an der Labor-Box laufen dann über ein Fenster oder das Root-Passwort |
| Pilot `edge-zay5sdd` | zwei, am Gerät gelesen am 05.10.2026: Laptop des Kapitäns und CodeServer ([Übergabe](uebergabe.md#zugang-zum-pilot-mango)) | zusammen mit dem [beaufsichtigten Wechsel](#wechsel-des-piloten-auf-den-wartungsserver-beaufsichtigt-noch-nicht-ausgeführt), nach dessen Schritt 6. Vor dem Kürzen muss die Anmeldung mit dem Notfall-Schlüssel über den neuen Tunnel gelungen sein |
| jede neue Box | keiner | in der Werkstatt nur den Notfall-Schlüssel eintragen ([Werkstatt-Regel](#bevor-eine-box-die-werkstatt-verlässt)) |

Port 22 im LAN nimmt dieselbe Datei: Auch vor Ort gilt danach nur der Notfall-Schlüssel oder das Root-Passwort.

#### Was die Box im Tunnel selbst prüft

Entscheid des Kapitäns vom 09.10.2026: Die Web-App ist im offenen Fenster für alle Techniker frei, nicht mehr je Techniker-Adresse. Die Schranke ist das Fenster am Wartungsserver.

| Die Box prüft | Die Box prüft nicht |
|---|---|
| Das Paket kam durch den Tunnel. Dessen einzige Gegenstelle ist der Wartungsserver, und WireGuard nimmt von ihm nur Absender aus dem Techniker-Netz an | welcher Techniker es ist |
| Ziel ist SSH 2222, die Web-App 8484 oder ein Ping; alles andere weist die Zone `service` ab, und nichts wird ins Kundennetz weitergeleitet | ob ein Fenster offen ist und wie lange noch |
| SSH: nur mit einem Schlüssel aus der Schlüsseldatei im RAM. Darin stehen die dauerhaften Schlüssel der Box und, solange ein Fenster offen ist, der Schlüssel des Technikers aus dem Portal | Web-App: keine Anmeldung. Wer durchkommt, bedient sie |

- **Ob und wie lange** ein Techniker eine Box erreicht, entscheidet allein der Wartungsserver, je Paar aus Techniker und Box und mit Ablaufzeit. Ohne Fenster verwirft er den Verkehr.
- **Zum Techniker-Netz gehört auch der Server selbst** (`10.10.32.1`). Wer dort root ist, erreicht die Web-App jeder verbundenen Box auch ohne Fenster.
- **Die frühere Liste je Adresse** hat nur unterschieden, welcher Techniker mit offenem Fenster die Web-App erreicht. Ohne Fenster kam auch damals niemand durch, und jeder neue Zugang hätte auf jeder Box nachgetragen werden müssen.
- **Engere Wahl:** `VP_SERVICE_WEB=zu` vor der Befehlszeile richtet den Tunnel ohne die Web-App ein. Dann bleibt `service-tunnel.sh <ziel> web <adresse> …` für einzelne Adressen oder `ssh -p 2222 -L 8484:127.0.0.1:8484 root@<adresse>`.
- **Im alten Service-VPN gibt es die Freigabe für das Netz nicht**, dort hängen auch Kundensysteme. Die Regel hängt am Absender `10.10.32.0/24`, den die Box nur über `wg_wartung` annimmt; ein zweiter Tunnel in der Zone bekommt damit nichts geöffnet.

#### Fenster-Schlüssel auf der Box

Entscheid des Kapitäns vom 09.10.2026, Schritt 3 von [Fernwartung, Anmeldung an der Box](../../docs/fernwartung.md#anmeldung-an-der-box-fenster-schlüssel). Die Box holt im offenen Fenster den SSH-Schlüssel ab, der im Portal am Techniker-Zugang steht. Kein Techniker-Schlüssel muss dafür je auf die Box.

| Auf der Box | Aufgabe |
|---|---|
| `/usr/libexec/vp-wartung/schluessel-holen.sh` | der Abholer: `lauf` (Dauerdienst), `frist` (cron, jede Minute), `einmal` (Abfrage von Hand), `status` |
| `/etc/init.d/vp-wartung` | startet Dropbear an der Tunnel-Adresse mit eigener Schlüsseldatei (`dropbear -D`) und den Abholer; hängt den RAM-Bereich ein; sichert beim Herunterfahren der Box die letzten Ereignisse (`/etc/rc.d/K20vp-wartung`) |
| `/etc/vp-wartung/keys` | eigenes tmpfs (128 KiB, nur root) mit der Schlüsseldatei. Nicht unter `/tmp`: Dropbear lehnt eine Schlüsseldatei unter einem Verzeichnis ab, das alle beschreiben dürfen |
| `/tmp/vp-wartung` | Arbeitsstand des Abholers: je Schlüssel die Frist in Laufzeit der Box; die Datei `beenden`, solange nach einem gestrichenen Schlüssel noch Sitzungen zu beenden sind; `frist`, das Lebenszeichen des cron-Laufs |
| `/etc/vp-wartung/ereignisse` | die [Ereignisliste](#protokoll-der-box-wer-wann-auf-einer-box-war) im Flash: wann welcher Fenster-Schlüssel kam und ging, jede Anmeldung durch den Tunnel, jedes Ende einer Sitzung. Höchstens 250 Zeilen, nie ein Schlüssel |
| `/etc/config/vp-wartung` | Server (`10.10.32.1`), Port (`8022`), Schnittstelle; wahlweise `warte` |
| `/etc/nftables.d/20-vp-wartung.nft` | zwei eigene Firewall-Ketten: SSH 2222 nur aus den Tunneln, die Anfrage nach Schlüsseln nur durch den Tunnel |

- **Die UCI-Instanz `dropbear.vp_wartung` entfällt.** Das Startskript von OpenWrt kennt `-D` nicht, deshalb startet ein eigenes Startskript die Instanz. Sie läuft nur, solange der Tunnel eine Adresse hat.
- **Was dauerhaft in `/etc/dropbear/authorized_keys` steht, gilt im Tunnel weiter.** Der Abholer liest die Datei nur und schreibt ihre Zeilen vor die Fenster-Schlüssel. Eine neue Zeile dort gilt im Tunnel nach spätestens einer Minute. Port 22 im LAN ist unberührt. Was dort stehen soll: [ein Notfall-Schlüssel](#dauerhafte-schlüssel-ein-notfall-schlüssel).
- **Nur RAM.** Ein Neustart der Box löscht jeden Fenster-Schlüssel; die Box holt ihn von selbst wieder, solange das Fenster offen ist. Ohne das tmpfs schreibt der Abholer nichts.
- **Was ein Update der Box übersteht:** `sysupgrade -l | grep -E 'vp-wartung|service-tunnel-watch'` nennt neun Zeilen: `/etc/config/vp-wartung`, `/etc/init.d/vp-wartung`, `/etc/nftables.d/20-vp-wartung.nft`, `/etc/rc.d/S60vp-wartung`, `/etc/wireguard/vp-wartung.key`, `/usr/libexec/vp-edge-light/service-tunnel-watch.sh` und `/usr/libexec/vp-wartung/schluessel-holen.sh` (diese sieben an der Labor-Mango so gelesen), seit dem 12.10.2026 dazu `/etc/rc.d/K20vp-wartung` und die Ereignisliste `/etc/vp-wartung/ereignisse` (beide im Container belegt, die Liste erst, sobald es ein Ereignis gab). Die Einstellung `cronloglevel` steht in `/etc/config/system` und bleibt ebenfalls. Die Schlüsseldatei der Fenster unter `/etc/vp-wartung/keys` steht nicht darin, auch nicht bei offenem Fenster: Sie liegt im tmpfs, und ein Fenster-Schlüssel kommt so nie mit in ein Update.
- **Eine Sitzung endet mit dem Fenster, an zwei Schranken** (Entscheid vom 10.10.2026): Der Wartungsserver trennt den Weg, und die Box beendet die Sitzungen, die mit dem gestrichenen Fenster-Schlüssel begonnen wurden. Sitzungen mit einem dauerhaften oder einem anderen, noch gültigen Fenster-Schlüssel bleiben; eine, die sich keinem gültigen Schlüssel zuordnen lässt, endet dabei ebenfalls. Die Fälle, die Zuordnung und was „beenden“ heißt: [Fernwartung](../../docs/fernwartung.md#was-mit-einer-laufenden-anmeldung-geschieht).
- **Die Marke in der Schlüsseldatei.** Der Abholer schreibt hinter jeden Schlüssel `vpf-<Kennzahl>` (Fenster) oder `vpd-<Kennzahl>` (dauerhaft), bei einer dauerhaften Zeile vor deren Kommentar; `/etc/dropbear/authorized_keys` selbst bleibt unberührt. Dropbear gibt nur das **erste** Wort hinter dem Schlüssel als `SSH_PUBKEYINFO` an die Prozesse der Sitzung weiter, und nur wenn es aus Buchstaben, Ziffern und `.,_-+@` besteht. Wer die Zeile anders aufbaut, nimmt dem Abholer die Zuordnung: Dann endet jede Sitzung beim nächsten Streichen, auch die mit dauerhaftem Schlüssel.
- **Eine Box mit älterem Skript** streicht nur den Schlüssel; der Anmeldeprozess bleibt bis zu 15 Minuten stehen (Dropbear `-K 300`: nach drei unbeantworteten Lebenszeichen `Exit … Keepalive timeout` im Log). Der Wechsel: [Ausrollen](#sitzungen-beenden-ausrollen-je-box).
- **Frist in Laufzeit der Box** (`/proc/uptime`), nicht in Uhrzeit. Die Box nimmt höchstens 24 h und höchstens acht Schlüssel an. Ein cron-Lauf je Minute streicht Verfallenes auch dann, wenn der Abholer hängt.
- **Die Antwort des Servers ist die ganze Liste.** Ein geschlossenes Fenster und ein im Portal ersetzter oder entfernter Schlüssel sind auf der Box gestrichen, sobald der Server es meldet; in der Probe nach 0,2 bis 1 s. Jede Antwort, die nicht genau die [vereinbarte Form](../../docs/contracts/fernwartung-schluessel-v1.md) hat, ändert nichts.
- **Nur durch den Tunnel.** Der Abholer fragt nicht, wenn die Route zum Server nicht über `wg_wartung` führt, und die Firewall der Box weist die Anfrage auf jedem anderen Weg ab. Im Netz des Kunden kann sich so niemand als Wartungsserver ausgeben.
- **Datenvolumen:** Die Anfrage bleibt bis zu 45 s am Server offen. Im Prototyp waren das rund 3 MB am Tag. Für eine Box am Mobilfunk: `uci set vp-wartung.schluessel.warte=300; uci commit vp-wartung; /etc/init.d/vp-wartung restart` (der Server lässt höchstens 300 s zu). Nach einem Neustart der VM kann es dann bis zu fünf Minuten dauern, bis die Box ein neues Fenster bemerkt. Mit 300 s ist nichts gemessen.
- **Braucht Dropbear ab 2025.89** (OpenWrt 25.12). Auf einem älteren richtet das Skript die frühere UCI-Instanz ein und sagt das; dort gelten nur die dauerhaften Schlüssel. Dasselbe tut `VP_SERVICE_SCHLUESSEL=aus` vor der Befehlszeile, und es räumt den Abholer wieder ab.
- **Startet die neue Instanz nicht,** stellt das Skript die frühere UCI-Instanz wieder her und endet mit einem Fehler. Niemand wird dadurch ausgesperrt.

Nachsehen auf der Box:

```sh
/usr/libexec/vp-wartung/schluessel-holen.sh status   # Abholer, letzte Antwort, Zugang und Restlaufzeit je Fenster, der cron-Lauf, die letzten zehn Ereignisse; nie ein Schlüssel
/usr/libexec/vp-wartung/schluessel-holen.sh ereignisse   # die ganze Ereignisliste: wer wann auf der Box war (übersteht einen Neustart)
logread -e vp-wartung                                # die letzten Stunden: wann welcher Fenster-Schlüssel kam und ging, welche Sitzung die Box beendet hat, Meldungen des Abholers
logread -e dropbear | grep 'Pubkey auth'             # die letzten Stunden: jede Anmeldung mit Fingerabdruck und Absender, auch die an Port 22 im LAN
logread -e dropbear | grep 'Terminated by signal'    # die letzten Stunden: jede von der Box beendete Sitzung mit Absender
awk '{ print $1, $3, $4 }' /etc/vp-wartung/keys/authorized_keys   # Art, Marke und Kommentar je Zeile; nie der Schlüssel
```

`status` nennt auch die Sitzungen im Tunnel, gezählt nach der Art ihres Schlüssels: `Sitzungen im Tunnel: 2 - dauerhafter Schluessel 1, Fenster-Schluessel 1, gestrichener Fenster-Schluessel 0, nicht zuzuordnen 0`. Darunter stehen der cron-Lauf (`zuletzt vor … s` oder `AUSGEBLIEBEN seit … s`) und die letzten zehn Zeilen der Ereignisliste.

Meldet `status` „seit dem Start keine“ gültige Antwort, obwohl `ping 10.10.32.1` geht, gibt der Wartungsserver keine Schlüssel aus: Dort ist `VP_TUNNEL_SCHLUESSEL_PORT` nicht gesetzt, oder der Dienst hat keinen frischen Soll-Stand ([Tunnel-Dienst](../../services/tunnel-dienst/README.md#schlüsselausgabe)).

#### Protokoll der Box: wer wann auf einer Box war

Entscheid des Kapitäns vom 12.10.2026, nach dem Befund vom 11.10.: Eine Probe an der Labor-Mango war neun Stunden später an der Box nicht mehr belegbar. Der Protokollspeicher der Box (`logread`) liegt im RAM, fasst 128 KiB (`system.log_size`) und überschreibt das Älteste.

**Was ihn gefüllt hat**, gemessen an der Labor-Mango am 12.10.2026 (nur gelesen): 805 Zeilen, die älteste 3 h 31 min alt.

| Quelle | Zeilen | Anteil am Speicher | Kommt an jeder Box? |
|---|---|---|---|
| cron: eine Zeile je Start eines Zeitauftrags (`crond[…]: USER root pid … cmd …`) | 467 | 39 % | ja, an jeder Box mit Wartungstunnel: `schluessel-holen.sh frist` und `wireguard_watchdog` jede Minute, `service-tunnel-watch.sh` alle fünf Minuten, zusammen 132 Zeilen je Stunde |
| Edge-Light-Programm: `enrollment: cannot reach the portal for CSR upload; retrying` | 211 | 47 % | nein. Die Warnung kommt nur, solange eine Box **noch kein Zertifikat hat und das Portal nicht erreicht**, dann nach kurzem Anlauf jede Minute (`internal/enroll`, Abstand 10 bis 60 s). Die Labor-Mango ist nicht gekoppelt, und ihre Portal-Adresse zeigt absichtlich ins Leere (`http://127.0.0.1:9`). Eine gekoppelte Box fragt gar nicht mehr; eine neue Box, die das Portal erreicht, wartet still auf die Kopplung |
| Dropbear: Anmeldungen | 124 | 12 % | nein: 40 der 41 Anmeldungen kamen von der Arbeitsmaschine an Port 22 (Proben), eine durch den Tunnel |
| `vp-wartung` | 3 | unter 1 % | ja, nur bei einem Ereignis |

**Was seit dem 12.10. gilt**, für eine Box, auf der `service-tunnel.sh` ab diesem Stand gelaufen ist:

- **cron protokolliert die Starts seiner Zeitaufträge nicht mehr.** Das Skript setzt `system.cronloglevel` auf `9`, wenn die Einstellung noch nicht gesetzt ist. Eine Einstellung, die schon jemand gewählt hat, bleibt; das Skript sagt es dann. Mit dem letzten Tunnel (`abbauen`) nimmt das Skript die `9` wieder weg.
- **Das trifft alle Zeitaufträge der Box,** nicht nur die der Fernwartung: cron kennt die Stufe nur für sich als Ganzes. Heute stehen in der crontab einer Box nur die drei Zeilen dieses Skripts.

| Im Protokoll der Box | vorher | jetzt |
|---|---|---|
| Start eines Zeitauftrags (`USER root pid … cmd …`) | jede Minute | nicht mehr |
| ein Auftrag läuft noch vom vorigen Mal (`process already running`) | ja | nicht mehr |
| Fehler von cron selbst: unlesbare Zeile der crontab (`parse error at …`), Start gescheitert (`can't execute`, `vfork`), Zeitsprung | ja | ja |
| ein Auftrag endet mit Fehler oder sein Programm fehlt | nein, cron hat das nie protokolliert | nein |
| der cron-Lauf der Fenster-Schlüssel bleibt aus (crontab-Zeile weg, cron steht, Lauf hängt oder scheitert) | nein | **ja:** `vp-wartung: FEHLER: der cron-Lauf (frist) ist seit … s ausgeblieben`, und wenn er wiederkommt |

- **Ein Zeitauftrag meldet sein Ausbleiben selbst.** Jeder Lauf `frist` legt ein Lebenszeichen ab (`/tmp/vp-wartung/frist`, Laufzeit der Box). Ist es älter als 180 s, meldet es der Abholer einmal im Protokoll, und `status` zeigt `AUSGEBLIEBEN`. Die beiden Wächter des Tunnels melden wie bisher, wenn sie eingreifen. **Wer einen weiteren Zeitauftrag auf die Box legt,** lässt ihn seine Fehler selbst mit `logger` melden: cron tut es nicht.
- **Die Warnung des Programms zur Anmeldung am Portal bleibt, wie sie ist.** Sie steht im gemeinsamen Go-Code von Edge Light und Docker-Box und trifft nur eine ungekoppelte Box ohne Portal. An der Labor-Mango reicht `logread` damit auch künftig nur rund sechs bis sieben Stunden zurück (überschlagen und nach dem Einspielen hochgerechnet, [nicht gemessen](#belegt)). Wie viel eine gekoppelte Box im Betrieb protokolliert, ist nicht gemessen.

**Die Ereignisliste** (`/etc/vp-wartung/ereignisse`) hängt deshalb nicht daran, wie lange der Protokollspeicher reicht. Der cron-Lauf des Abholers übernimmt jede Minute, was an dessen Ende zur Fernwartung neu steht, im Wortlaut und mit der Zeit des Protokolls:

| Ereignis | Zeile (gekürzt) |
|---|---|
| Schlüssel eines Fensters angekommen, gestrichen | `vp-wartung: Fenster-Schluessel jetzt: <Zugang> …` und `… jetzt: keine` |
| Anmeldung durch einen Wartungstunnel | `dropbear[<Prozess>]: Pubkey auth succeeded for 'root' with ssh-rsa key SHA256:<Fingerabdruck> from <Absender>:<Port>` |
| Sitzung von der Box beendet, und warum | `vp-wartung: Sitzung beendet (Dropbear-Prozess <Prozess>): ihr Fenster-Schluessel ist gestrichen` |
| Ende einer Sitzung, und warum | `dropbear[<Prozess>]: Exit (root) from <<Absender>:<Port>>: Terminated by signal` (oder `Disconnect received`, `Keepalive timeout` …) |

- **Wer es war:** Der Zugang steht in der Zeile des Fenster-Schlüssels, der Fingerabdruck in der Zeile der Anmeldung. Das Portal zeigt denselben Fingerabdruck am Zugang ([Fernwartung](../../docs/fernwartung.md#anmeldung-an-der-box-fenster-schlüssel)). Zusammen gehören die Zeilen mit derselben Prozessnummer.
- **Nie ein Schlüssel.** Übernommen werden nur diese vier Arten von Zeilen; eine Zeile, in der ein Schlüssel steht, nie.
- **Nur durch einen Tunnel:** Eine Anmeldung zählt, wenn ihr Absender aus den erlaubten Netzen eines Wartungstunnels kommt (`allowed_ips`, am Wartungsserver `10.10.32.0/24`). Anmeldungen an Port 22 im LAN stehen nicht darin, abgewiesene Versuche auch nicht; beides bleibt für Stunden in `logread`.
- **Feste Obergrenze:** höchstens 250 Zeilen zu höchstens 400 Zeichen, also unter 100 KB. Käme die 251. dazu, bleiben die neuesten 200.
- **Wie weit sie zurückreicht:** nach Ereignissen, nicht nach Zeit. Eine Sitzung im Fenster schreibt vier bis sechs Zeilen (Schlüssel gekommen, Anmeldung, von der Box beendet, Ende, Schlüssel gestrichen). Das sind mindestens die letzten rund 35 bis 50 Sitzungen, an einer Kundenbox mit wenigen Wartungen im Monat also Jahre. Wer in einem offenen Fenster in einer Schleife anmeldet, verdrängt die Geschichte: Jede Anmeldung kostet zwei Zeilen.
- **Im Flash, geschrieben nur bei einem Ereignis.** Ohne Fernwartung schreibt die Box nichts; ein Lauf ohne neues Ereignis lässt die Datei unberührt. Beim Herunterfahren der Box (`reboot`) sichert das Startskript, was seit dem letzten cron-Lauf geschah.
- **Gelesen werden nur die letzten 200 Zeilen des Protokollspeichers,** mit 5 s Zeitgrenze, nie der ganze Speicher: Zwei Leser, die ihn zugleich ganz lesen, lassen den Protokolldienst der Box neu starten ([unten](#proben-von-der-box-busybox-unter-2512)). Schreibt die Box in einer Minute mehr als 200 Zeilen, kann der Liste deshalb ein Ereignis fehlen. Beim ersten Lauf nach dem Ausrollen kommt in die Liste, was in diesen 200 Zeilen steht.

| Die Liste … | |
|---|---|
| übersteht | einen Neustart der Box, einen Stromausfall (bis auf die letzte Minute davor), ein `sysupgrade` (steht in `/etc/sysupgrade.conf`), ein Update des Edge-Light-Programms (das berührt sie nie), einen erneuten Lauf von `service-tunnel.sh` |
| übersteht nicht | `service-tunnel.sh <ziel> abbauen wg_wartung`, `VP_SERVICE_SCHLUESSEL=aus` und den Rückfall, wenn die Anmelde-Instanz nicht startet: Dann räumt das Skript die Fenster-Schlüssel samt Liste ab. Ebenso nicht ein Zurücksetzen der Box auf Werkseinstellungen. Wer root auf der Box ist, kann sie ändern |
| reicht nicht über die Box hinaus | Portal und Wartungs-VM erfahren von einer Anmeldung nichts. Die VM behält dauerhaft nur ihre Seite (Journal: Fenster geöffnet und geschlossen, Schlüssel ausgegeben), das Portal sein Protokoll der Fenster |

**Abgewogen:**

| Weg | Warum (nicht) |
|---|---|
| größerer Protokollspeicher (`log_size`) | hilft nur, solange nichts anderes viel schreibt, und reicht nie fest zurück: An der Labor-Mango brauchte eine Woche rund 4 MB RAM. Weg nach jedem Neustart. Nicht gebaut |
| eigene Liste im RAM | feste Reichweite, kein Schreiben in den Flash. Aber weg nach einem Neustart, und eine Wartung endet oft mit einem. Nicht gebaut |
| **eigene Liste im Flash** | feste Reichweite, übersteht den Neustart. Abnutzung: wenige hundert Byte je Wartung. Schlimmster Fall, überschlagen und nicht gemessen: Meldet sich jemand im offenen Fenster in einer Schleife an, schreibt die Box die Liste jede Minute neu, rund 40 MB am Tag; verteilt auf den freien Platz wären das Jahre bis zur Grenze des Flash. Platz: unter 100 KB von 4,5 MB freiem Overlay. **Gebaut** |

#### Protokoll und Ereignisliste: ausrollen je Box

Wie beim [Beenden der Sitzungen](#sitzungen-beenden-ausrollen-je-box): ein erneuter Lauf von `service-tunnel.sh` mit der Befehlszeile aus dem Portal, je Box. Portal, API und Tunnel-Dienst ändern sich nicht. **Ausgeführt an einem Gerät, der Labor-Mango (12.10.2026, [Stand](#stand-an-der-labor-mango-12102026)); an keiner anderen Box.** Jede Box nur mit dem Wort des Kapitäns.

| | Vorher | Nachher |
|---|---|---|
| `uci -q get system.@system[0].cronloglevel` | leer | `9` |
| `logread \| grep -c 'crond.*USER root'`, einige Minuten nach dem Lauf | wächst um 132 je Stunde | wächst nicht mehr |
| `service-tunnel.sh <ziel> status` | keine Zeile zu cron und zu Ereignissen | `cron protokolliert die Starts der Zeitauftraege: nein (cronloglevel 9 …)`, `cron-Lauf (streicht Verfallenes, jede Minute): zuletzt vor … s`, `Ereignisse der Fernwartung: …` mit den letzten zehn Zeilen |
| `ls -l /etc/vp-wartung/ereignisse /etc/rc.d/K20vp-wartung` | beide fehlen | der Verweis steht; die Liste entsteht mit dem ersten Ereignis |
| letzte Zeilen des Skripts | – | `Protokoll der Box: cron protokolliert die Starts … nicht mehr` und `nachlesen: wer wann angemeldet war …` |
| eine Anmeldung von vor zwei Tagen | nicht mehr zu finden | steht in `status` oder `schluessel-holen.sh ereignisse` |

**Schritte für die Labor-Mango** (`edge-5t2dcy6`, über `root@192.168.0.46`, Port 22):

1. Vorher festhalten: `service-tunnel.sh root@192.168.0.46 status`, dazu auf der Box `uci -q get system.@system[0].cronloglevel` (leer) und `logread | grep -c 'crond.*USER root'`.
2. Die Befehlszeile aus dem Portal ausführen: `VP_SERVICE_PUBKEY='<server>' edge-light/openwrt/service-tunnel.sh root@192.168.0.46 <adresse>`. Der Lauf fasst den Tunnel nicht an (`Tunnel unveraendert`); er tauscht Abholer und Startskript, startet Lauscher, Abholer und cron neu. Eine offene Sitzung im Tunnel übersteht ihn.
3. `status`: die drei neuen Zeilen stehen da. Was zur Fernwartung noch im Protokollspeicher steht, hat der erste Lauf in die Liste übernommen.
4. Nach fünf Minuten: Die Zahl aus Schritt 1 ist nicht gewachsen.
5. Probe: im Portal ein Fenster für den eigenen Zugang öffnen, anmelden, schließen. `status` zeigt die vier bis sechs Zeilen dazu.
6. Am nächsten Tag und nach einem `reboot` der Box: `status` zeigt dieselben Zeilen noch.

**Eine Box mit älterem Skript** behält ihr Verhalten: cron protokolliert jeden Start, es gibt keine Liste, und `status` nennt die drei Zeilen nicht. Daran erkennt man den Stand. Fenster-Schlüssel und das Beenden der Sitzungen sind davon unberührt.

**Rückweg:** auf der Box `uci delete system.@system[0].cronloglevel; uci commit system; /etc/init.d/cron restart`; dann protokolliert cron wieder jeden Start. Die Liste stört nicht, wenn sie bleibt. Ganz zurück geht es mit `service-tunnel.sh` aus dem Stand davor (`git show 6c9eb2861:edge-light/openwrt/…`); dessen Lauf lässt `cronloglevel`, die Liste und `/etc/rc.d/K20vp-wartung` stehen, sie sind von Hand zu entfernen.

| Box | Stand | Ausrollen |
|---|---|---|
| Labor-Mango `edge-5t2dcy6` | am Wartungsserver, eingespielt am 12.10.2026 um 13:13 UTC: Abholer und Startskript vom Stand `ead1d14f5`, `cronloglevel 9`, Liste mit den fünf Einträgen der Probe von 13:42 bis 13:43 UTC | ausgeführt, Schritte 1 bis 5 ([Stand](#stand-an-der-labor-mango-12102026)); offen ist Schritt 6 |
| Pilot `edge-zay5sdd` | laut dieser Datei noch im alten Service-VPN, ohne Fenster-Schlüssel; nicht eingespielt | mit dem [beaufsichtigten Wechsel](#wechsel-des-piloten-auf-den-wartungsserver-beaufsichtigt-noch-nicht-ausgeführt). Ein Lauf mit `VP_SERVICE_ZIEL=alt` stellte dort nur die Zeilen von cron ab; eine Liste gibt es ohne Fenster-Schlüssel nicht |

##### Stand an der Labor-Mango (12.10.2026)

Die Schritte 1 bis 5 sind ausgeführt, Schritt 6 nicht. Zeiten in UTC.

- **Eingespielt um 13:13:** ein Lauf von `service-tunnel.sh` aus dem Stand `ead1d14f5`, 15 s, Rückgabe 0, `Tunnel unveraendert`. Kein Fenster war offen, niemand im Tunnel angemeldet. Vorher und nachher passten zur Tabelle oben: `cronloglevel` leer, danach `9`; `status` nennt die drei neuen Zeilen; der Verweis `/etc/rc.d/K20vp-wartung` steht.
- **cron:** In den 14 Minuten nach dem Lauf (13:13:22 bis 13:27:22) schrieb cron keine Startzeile mehr und auch keinen Fehler. In den zehn Minuten davor waren es 2 bis 3 je Minute. Der cron-Lauf des Abholers lief weiter jede Minute (`status`: `zuletzt vor 21 s`, später `vor 42 s`).
- **Die Liste entstand erst mit dem ersten Ereignis.** Nach dem Lauf fehlte die Datei, `status` nannte `Ereignisse der Fernwartung: noch keine …`. Eine Sitzung vom Morgen (07:07) lag schon außerhalb der 200 Zeilen, die der Abholer liest, und steht nicht darin.
- **Probe des Kapitäns mit einem echten Fenster, 13:42 bis 13:43:** Danach standen in der Liste genau die fünf erwarteten Einträge: Fenster-Schlüssel gekommen (13:42:57), Anmeldung durch den Tunnel (13:43:03), Fenster-Schlüssel gestrichen, Ende der Sitzung (`Terminated by signal`) und `Sitzung beendet … gestrichen` (alle drei 13:43:57). Der Minutenlauf der Box hat die Datei binnen einer Minute angelegt (geschrieben 13:44): 5 Zeilen, 617 Byte, Rechte `-rw-------` (nur root), kein Schlüssel darin. Einmal gelesen um 13:45 mit `schluessel-holen.sh ereignisse`.
- **Gelesen wurde das Protokoll der Box nur begrenzt** (`logread -l 300`, je ein Aufruf vorher und nachher, nie zwei zugleich; [Regel](#proben-von-der-box-busybox-unter-2512)).
- **Nicht ausgeführt:** Schritt 6 (nächster Tag, `reboot`), ein Update der Box, der Rückweg. Was damit offen bleibt, steht unter [Noch nicht belegt](#belegt).

#### Sitzungen beenden: ausrollen je Box

Die zweite Schranke kommt mit einem erneuten Lauf von `service-tunnel.sh` auf die Box, mit der Befehlszeile aus dem Portal (dieselbe wie beim Einrichten). Portal, API und Tunnel-Dienst ändern sich nicht. **An keinem Gerät ausgeführt;** Labor-Mango und Pilot mit dem Wort des Kapitäns.

| | Vorher | Nachher |
|---|---|---|
| `service-tunnel.sh <ziel> status` | keine Zeile zu Sitzungen | `Sitzungen im Tunnel: …` |
| `awk '{ print $1, $3, $4 }' /etc/vp-wartung/keys/authorized_keys` | `ssh-rsa <kommentar>` | `ssh-rsa vpd-<32 Zeichen> <kommentar>`, im offenen Fenster dazu `ssh-rsa vpf-<32 Zeichen> vp-fenster:<zugang>` |
| letzte Zeilen des Skripts | – | `zum Ende: mit dem Schluessel beendet die Box die Sitzungen, die mit ihm begonnen wurden` |
| Fenster schließen, während eine Anmeldung offen ist | der Anmeldeprozess steht bis zu 15 Minuten (`logread -e dropbear`: `Keepalive timeout`) | er endet nach wenigen Sekunden (`logread -e vp-wartung`: `Sitzung beendet …`; `logread -e dropbear`: `Terminated by signal`) |

**Schritte, je Box:**

1. Kein Techniker arbeitet gerade an der Box; `status` ansehen und die Zeilen „vorher“ notieren.
2. Die Befehlszeile aus dem Portal ausführen: `VP_SERVICE_PUBKEY='<server>' edge-light/openwrt/service-tunnel.sh <ziel> <adresse>`. Der Lauf fasst den Tunnel nicht an (`Tunnel unveraendert`), WAN und LAN bleiben oben; er tauscht Abholer und Startskript und startet Lauscher und Abholer neu.
3. `status`: die Zeile `Sitzungen im Tunnel:` steht da, `Fenster-Schluessel: Abholer laeuft` mit einer gültigen Antwort.
4. Probe: im Portal ein Fenster für den eigenen Zugang öffnen (15 Minuten), anmelden, das Fenster schließen. Auf der Box nennt `logread -e vp-wartung | grep 'Sitzung beendet'` die Sitzung; `status` zählt sie nicht mehr.

**Was mit einer offenen Sitzung geschieht, wenn das Skript läuft:**

- Eine Sitzung an Port 22 (LAN, an der Labor-Mango der WAN-Anschluss) bleibt unberührt, auch die, über die das Skript läuft.
- Eine Sitzung im Tunnel übersteht den Lauf: Nur der Lauscher startet neu. Sie trägt aber keine Marke, weil sie vor dem neuen Skript begann, und ist damit nicht zuzuordnen. **Beim ersten Fenster-Schlüssel, der danach gestrichen wird, endet sie,** auch wenn sie mit einem dauerhaften Schlüssel begonnen wurde. Wer sich danach neu anmeldet, trägt die Marke und bleibt. In der Probe belegt (Schritt 11b).

| Box | Stand | Ausrollen |
|---|---|---|
| Labor-Mango `edge-5t2dcy6` | am Wartungsserver, Fenster-Schlüssel eingerichtet (09.10.2026), Dropbear 2025.89 | die Schritte oben, über `root@192.168.0.46` (Port 22) |
| Pilot `edge-zay5sdd` | laut dieser Datei noch im alten Service-VPN (`wg_service`, nur dauerhafte Schlüssel); dort gibt es keinen Fenster-Schlüssel und nichts auszurollen | die Schranke kommt mit dem [beaufsichtigten Wechsel](#wechsel-des-piloten-auf-den-wartungsserver-beaufsichtigt-noch-nicht-ausgeführt), Schritt 3: Er richtet den neuen Tunnel mit diesem Skript ein. Ist der Pilot inzwischen gewechselt: die Schritte oben, über `mango-neu` |

**Rückweg:** dieselbe Befehlszeile mit `service-tunnel.sh` aus dem Stand davor (`git show a9e9872e9:edge-light/openwrt/…` oder ein Checkout dieses Stands). Die Box streicht dann wieder nur den Schlüssel. In der Probe läuft der Wechsel in beide Richtungen (Schritt 11b).

#### Einrichten ohne Unterbrechung, Dropbear an der Adresse

Am Mango gemessen (25.12.5, 09.10.2026):

- **Das Skript startet nur die Tunnel-Schnittstelle** (`ifup`), und nur wenn sich an ihr etwas geändert hat. Ein zweiter Lauf mit denselben Werten fasst sie nicht an. `/etc/init.d/network reload` setzt am Mango dagegen den Switch zurück: LAN und WAN waren 4 s ohne Link, die WAN-Adresse wurde neu geholt, und der Tunnel war 8 s unten.
- **Dropbear wird erst geladen, wenn die Schnittstelle oben ist.** Die Meldung `Network interface 'wg_wartung' has no suitable IP address(es)!` erscheint damit nicht mehr. Ausnahme: direkt nach der Installation von `wireguard-tools` startet das Skript das Netzwerk neu und muss Dropbear vorher laden. Dort kündigt es die Meldung an; sie ist dann kein Fehler.
- **Dropbear hängt an der Adresse des Tunnels (`Interface`), nicht an der Schnittstelle (`DirectInterface`).** Beides wurde ausprobiert:

| | `Interface` (bleibt) | `DirectInterface` |
|---|---|---|
| Dropbear läuft mit | `-p 10.10.16.2:2222` | `-l wg_wartung -p 2222` |
| Tunnel unten | lauscht auf **allen** Adressen (`0.0.0.0:2222`), bis der Tunnel wieder oben ist | die Instanz läuft nicht |
| nach `ifup wg_wartung`, wie es der Wächter ausführt | antwortet weiter | **antwortet im Tunnel nicht mehr**, bis Dropbear neu startet |

`ifup` legt die Schnittstelle neu an, sie bekommt eine neue Nummer. Dropbear wird dabei nicht neu gestartet, weil sich seine Befehlszeile nicht ändert, und bleibt mit `DirectInterface` an die alte Nummer gebunden. Eine Box, deren Wächter den Tunnel einmal neu gestartet hat, wäre über SSH nicht mehr erreichbar. Deshalb bleibt `Interface`, wo es die UCI-Instanz noch gibt: im alten Service-VPN, mit `VP_SERVICE_SCHLUESSEL=aus` und auf einem Dropbear vor 2025.89.

**SSH 2222 außerhalb des Tunnels** (Entscheid vom 09.10.2026): Die UCI-Instanz lauscht auf allen Adressen, solange der Tunnel unten ist. Die WAN-Zone wies das immer ab, die LAN-Zone nicht. Seit dem 09.10. schreibt das Skript eine eigene Firewall-Kette vor die von fw4 (`/etc/nftables.d/20-vp-wartung.nft`, Kette `vp_wartung_eingang`): Port 2222 kommt nur aus den Tunneln der Zone `service` und von der Box selbst an, auf jedem anderen Weg wird er abgewiesen. Das gilt bei Tunnel oben und unten, für beide Arten der Instanz und auch für die Tunnel-Adresse, wenn ein Gerät im LAN sie über die Box anspricht. Die Instanz der Fenster-Schlüssel läuft ohne Tunnel-Adresse gar nicht; sie bindet an die Adresse und startet nach einem `ifup` des Wächters von selbst neu. Port 22 im LAN bleibt, wie er ist.

#### Belegt

- **Im Container** mit `edge-light/test/service-tunnel-probe.sh` gegen OpenWrt 24.10 (procd, netifd, fw4, Dropbear, cron, Kernel-WireGuard): Altbestand, neuer Tunnel daneben, Wiederholbarkeit ohne Neustart der Schnittstelle, geänderte Gegenstelle, Reihenfolge von Schnittstelle und Dropbear, Schutz beim Abbauen, alten Tunnel abbauen, Web-App für das Techniker-Netz und je Adresse, `VP_SSH_KEY`.
- **Am Mango unter 25.12.5 gegen den echten Wartungsserver** (Labor-Box `edge-5t2dcy6`, 08./09.10.2026): Handshake; im offenen Fenster kommen SSH auf 2222 und die Web-App an der Box an; das Fenster läuft ab. Mit dem Skript vom 09.10.: Einrichten wie bei einer neuen Box und erneuter Lauf ohne Dropbear-Meldung und ohne Unterbrechung von WAN und LAN; die Web-App nimmt eine Adresse des Techniker-Netzes an, die auf der Box nie eingetragen wurde (`10.10.32.1`), und weist 8887 von derselben Adresse ab.
- **Im Container unter OpenWrt 25.12.5** (Dropbear 2025.89, WAN und LAN getrennt) mit `edge-light/test/wartung-anmeldung-probe.sh`, gegen den Tunnel-Dienst aus dem Repo, mit echter SSH-Anmeldung durch einen echten Tunnel: die Fenster-Schlüssel von der Einrichtung über einen heutigen Zugang bis zum Abbauen, die Störfälle (Lücke in der Server-Firewall, Server und Abholer weg, Neustart der Box, falscher Server, Laufzeit statt Uhr) und SSH 2222 außerhalb des Tunnels bei Tunnel oben und unten. Dazu, dass der Tunnel-Dienst den Schlüssel als abgeholt meldet, sobald das Box-Skript ihn übernommen hat (Schritt 1).
- **Im selben Container: die Box beendet die Sitzungen eines gestrichenen Fenster-Schlüssels** (10.10.2026). Je Fall steht eine stille Sitzung offen; nach dem Streichen ist ihr Anmeldeprozess auf der Box weg, und in einer Lücke der Server-Firewall antwortet sie nicht mehr:
  - Fenster im Portal geschlossen (Schritt 4), Schlüssel im offenen Fenster ersetzt und entfernt (4b), Fenster abgelaufen (4c), Dienst angehalten und Frist über den cron-Lauf (5);
  - zwei Techniker mit je einem Fenster: Eines endet, die Sitzung des anderen und die mit dem dauerhaften Schlüssel bleiben; eine Weiterleitung ohne Prozess endet und steht sofort wieder; derselbe Schlüssel zugleich dauerhaft und im Fenster bleibt (4d);
  - Neustart der Box mitten im Fenster, danach Neustart von Lauscher und Abholer (6); Abräumen der Instanz (10, 12);
  - Ausrollen über das Skript von vorher mit offenen Sitzungen, samt Gegenprobe: Mit dem Skript von vorher bleibt der Anmeldeprozess stehen, und in der Lücke läuft die Sitzung wieder (11b).
- **Im selben Container: Protokoll der Box und Ereignisliste** (12.10.2026, Schritte 0, 1, 5b, 6, 6b, 10 und 12). Mit dem Skript von vorher sind diese Prüfungen rot:
  - vorher protokolliert cron jeden Start; nach dem Lauf des Skripts über mehrere Minuten keinen mehr, auch nicht nach einem Neustart von cron;
  - die Ereignisse einer früheren Sitzung stehen in der Liste und in `status`, nachdem der Protokollspeicher mit so vielen Zeilen überschrieben wurde, wie cron früher in Stunden schrieb (der Protokolldienst lief dabei durch); jedes genau einmal; kein Schlüssel, keine Anmeldung an Port 22; ein Lauf ohne neues Ereignis ändert die Datei nicht;
  - die Liste übersteht den Neustart der Box; der Schritt, den die Box beim Herunterfahren ausführt, bringt die Anmeldung von eben noch hinein;
  - 320 Ereignisse dazu: nie mehr als 250 Zeilen, die neuesten bleiben, eine überlange Zeile wird gekürzt;
  - eine unlesbare Zeile der crontab meldet cron weiter; fehlt die Zeile des Laufs, meldet der Abholer das Ausbleiben und die Rückkehr;
  - Abräumen und Abbauen entfernen Liste und Verweis, mit dem letzten Tunnel ist `cronloglevel` wieder ungesetzt.
- **An der Labor-Mango belegt** (`edge-5t2dcy6`, OpenWrt 25.12.5, gegen den echten Wartungsserver und das echte Portal):
  - Einrichten am 09.10.2026: Das Startskript hängt das tmpfs selbst ein (`vp-wartung /etc/vp-wartung/keys tmpfs … size=128k,mode=700`), darunter liegt im Flash nichts; beide Firewall-Ketten stehen vor denen von fw4; Abholer, Startskript und cron-Zeile laufen; Dropbear nimmt die Schlüsseldatei im tmpfs an; eine RSA-Anmeldung mit 4096 Bit dauert 1,2 bis 2,0 s; die Liste von `sysupgrade -l` (sieben Zeilen, siehe oben); WAN und LAN ohne Unterbrechung.
  - Abnahme durch den Kapitän am 10.10.2026 („hat alles funktioniert“), nach den fünf Punkten des Abnahmeplans: Anmeldung im offenen Fenster, ohne dass der Schlüssel des Technikers dauerhaft auf der Box liegt; nach dem Schließen ist der Fenster-Schlüssel von der Box gestrichen; nach einem Neustart der Box im Fenster ist er weg und kommt von selbst wieder; bei angehaltenem Tunnel-Dienst verfällt er zur Frist; die Dateien stehen in der Liste von `sysupgrade -l`.
  - Dabei beobachtet (10.10.2026, UTC): Anmeldung im Fenster 17:13:48, Dienst auf der VM angehalten 17:15:59, Fenster-Schlüssel von der Box gestrichen 17:40:38, der Anmeldeprozess auf der Box endete 17:55:37 mit „Keepalive timeout“. Das sind genau 15 Minuten nach dem Ende des Fensters: Der Server hatte den Weg getrennt, der Prozess wartete nur noch auf sein Lebenszeichen.
- **Einschränkung der Labor-Mango:** Die Arbeitsmaschine erreicht sie über ihren WAN-Anschluss (`192.168.0.46`, Port 22 nur wegen der Regel `Allow-SSH-WAN`); ihr LAN ist `10.213.0.0/24`, am LAN-Anschluss hängt kein Gerät. Port 2222 war von der WAN-Seite schon vorher abgewiesen. Dass die neue Kette abweist, zeigt dort nur ihr Zähler.
- **An der Labor-Mango nur gelesen** (10.10.2026, nichts geändert), für die Zuordnung von Sitzung und Schlüssel: `dropbear -V` nennt 2025.89; die eigene Anmeldung an Port 22 trägt `SSH_PUBKEYINFO` mit dem ersten Wort des Kommentars ihres Schlüssels; `/proc/<pid>/environ` ist lesbar; `pgrep -P`, `sha256sum`, `flock`, `ubus` und `jsonfilter` sind da; procd und die PID-Datei nennen denselben Lauscher.
- **An der Labor-Mango nur gelesen** (12.10.2026, nichts geändert), für das Protokoll der Box: Größe und Alter des Protokollspeichers und was ihn füllt ([oben](#protokoll-der-box-wer-wann-auf-einer-box-war)); `crond -f -c /etc/crontabs -l 7`, `cronloglevel` nicht gesetzt; die drei Zeilen der crontab; `logread` und das Auswerten aller 805 Zeilen brauchen dort zusammen 0,5 s (der Abholer liest nur 200); `flock`, `tail`, `wc` sind da, `base64` und `timeout` nicht; freies Overlay 4,5 MB. Dort läuft der Abholer vom 11.10.2026, und das Protokoll nennt am 12.10. um 07:07:48 UTC eine Sitzung, die die Box mit ihrem Fenster-Schlüssel beendet hat (`Sitzung beendet … gestrichen`, dazu `Terminated by signal`).
- **An der Labor-Mango eingespielt und erprobt** (12.10.2026, mit dem Wort des Kapitäns), Protokoll der Box und Ereignisliste: ein Lauf um 13:13 UTC, Rückgabe 0, Tunnel unverändert (Schnittstelle, Port und Adresse wie vorher, Zähler laufen weiter, neuer Handshake); die dauerhaften Schlüssel unverändert; cron schrieb in den 14 Minuten danach keine Startzeile mehr (vorher 2 bis 3 je Minute); die Liste entstand mit dem ersten Ereignis und zeigte nach der Probe des Kapitäns (Fenster von 13:42 bis 13:43 UTC) genau die fünf erwarteten Einträge, angelegt vom Minutenlauf binnen einer Minute, Rechte nur für root, kein Schlüssel darin. `sysupgrade -l` nannte nach dem Lauf acht Zeilen (neu: `/etc/rc.d/K20vp-wartung`); die neunte, die Liste selbst, steht in `/etc/sysupgrade.conf` und wurde nach der Probe nicht noch einmal gelesen. Einzelheiten: [Stand](#stand-an-der-labor-mango-12102026).
- **Noch nicht belegt:**
  - Protokoll und Ereignisliste auf einer echten Mango, über das hinaus, was an der Labor-Mango belegt ist (oben). Offen sind:
    - ob die Liste einen echten `reboot` und ein Update (`sysupgrade`) am Gerät übersteht, und ob das Startskript beim Herunterfahren die letzte Minute sichert (im Container ist der Neustart ein hartes Ende); die Liste über Tage;
    - wie weit `logread` ohne die Zeilen von cron wirklich zurückreicht: nur hochgerechnet aus 14 Minuten, rund sieben Stunden an dieser ungekoppelten Box (rund 60 Zeilen und 18 kB je Stunde statt rund 195 Zeilen und 33 kB); nicht gemessen;
    - ob der Protokolldienst der Mango bei zwei gleichzeitigen Lesern genauso neu startet wie im Container: bewusst nicht ausprobiert, es löschte ihr Protokoll;
    - die Rechenzeit des Lesens je Minute und das Schreiben auf dem JFFS2 der Mango über mehr als diese eine Datei mit fünf Zeilen;
    - jede andere Box als die Labor-Mango: An keiner ist das Skript eingespielt;
  - das Beenden der Sitzungen über Tage und die Laufzeit des cron-Laufs auf dem MIPS-Prozessor;
  - Port 2222 aus dem LAN einer Mango und bei Tunnel unten (`ifdown wg_wartung`); im Container ist beides belegt;
  - ein echtes `sysupgrade`. Danach fehlen ohnehin `kmod-wireguard` und `wireguard-tools`, bis sie neu installiert sind;
  - die Fenster-Schlüssel über einen fremden Anschluss, über Mobilfunk und über Tage;
  - die Web-App vom Gerät eines Technikers aus, seit die Regel je Adresse entfallen ist (im Fenster: `curl -m 5 http://<adresse>:8484/health`);
  - die [Rückmeldung](../../docs/fernwartung.md#rückmeldung-des-tunnel-dienstes) für eine Mango im Portal: Sie braucht das Ausrollen von Portal und Tunnel-Dienst.

#### Proben von der Box (BusyBox unter 25.12)

`nc -w 3 …` und `timeout 3 …` gibt es nicht. `nc -w` sendet nichts und sieht aus wie „keine Verbindung". So geht eine TCP-Probe mit drei Sekunden Wartezeit:

```sh
( nc <adresse> <port> </dev/null >/tmp/probe.out 2>&1 & p=$!; sleep 3; kill $p 2>/dev/null )
head -c 40 /tmp/probe.out; rm -f /tmp/probe.out
```

**Nie zwei `logread` zugleich.** Lesen zwei Aufrufe den vollen Protokollspeicher gleichzeitig, startet der Protokolldienst (`logd`) neu, und das ganze Protokoll ist weg. Im Container unter 25.12.5 gemessen (12.10.2026): 98 von 100 Versuchen mit zwei vollen Lesern, auch mit `-e`; kein Neustart, wenn einer der beiden höchstens die letzten 300 Zeilen liest (`logread -l 300`), mit 400 Zeilen wieder fast immer. An einer Mango nicht ausprobiert, auch beim Einspielen an der Labor-Mango bewusst nicht. **Am Gerät deshalb nur begrenzt lesen** (`logread -l 200`, höchstens `-l 300`), nie den ganzen Speicher und nie mit zwei Lesern zugleich. Wer nachsieht, während ein anderer oder ein Skript liest, nimmt `logread -l 200`; für die Fernwartung reicht `status`, das die Ereignisliste zeigt und selbst nur 200 Zeilen liest.

Den Tunnel prüft von der Box aus `ping 10.10.32.1`. TCP von der Box zum Server oder zu einem Techniker verwirft der Wartungsserver immer; das ist kein Fehler des Tunnels.

### Wechsel des Piloten auf den Wartungsserver (beaufsichtigt, noch nicht ausgeführt)

Der Pilot (`edge-zay5sdd`, heute `10.10.1.25` im alten VPN) wechselt erst, wenn der Wartungsserver steht. Der alte Tunnel bleibt bis zum letzten Schritt bestehen, so ist die Box jederzeit über einen Weg erreichbar. „Beaufsichtigt" heißt: ein Mensch führt jeden Schritt aus und prüft das Ergebnis, und jemand kommt im Notfall vor Ort an den Mango (WLAN `VoltPilot.de-zay5sdd`, `root@192.168.1.1`).

**Voraussetzungen:**

- Die VM steht, die API kennt den Server-Schlüssel, und im Portal steht „Tunnel-Dienst holt ab".
- Für den Rechner des Technikers gibt es einen Zugang im Portal, und er ist als zweites WireGuard-Profil neben dem alten VPN eingerichtet.
- In `~/.ssh/config` zwei Namen für dieselbe Box: `mango-alt` (`HostName 10.10.1.25`, `Port 2222`, `User root`) und `mango-neu` (die neue Adresse, `Port 2222`, `User root`), beide mit dem `IdentityFile`, den die Box schon kennt. Das ist ein RSA-Schlüssel; mit einem anderen endet Schritt 5 mit `Permission denied (publickey)`, und Schritt 6 darf dann nicht folgen. Dieser dauerhafte Schlüssel gilt im neuen Tunnel weiter, auch mit Fenster-Schlüsseln. Auf den einen [Notfall-Schlüssel](#dauerhafte-schlüssel-ein-notfall-schlüssel) wird erst nach dem Wechsel gekürzt.
- Für Fenster-Schlüssel braucht der Pilot Dropbear ab 2025.89 (OpenWrt 25.12); `ssh mango-alt 'dropbear -V'` nennt den Stand. Auf einem älteren richtet das Skript die frühere Instanz ein und sagt das in den letzten Zeilen; der Wechsel selbst geht genauso.

**Schritte:**

1. Über den alten Tunnel den neuen Schlüssel erzeugen: `edge-light/openwrt/service-tunnel.sh mango-alt key`. Der alte Schlüssel bleibt unberührt.
2. Im Portal Schlüssel und Referenz `edge-zay5sdd` hinterlegen; das Portal nennt die Adresse im Box-Netz.
3. Über den alten Tunnel den neuen einrichten: die Befehlszeile aus dem Portal, mit `mango-alt` statt `root@<box>`. Danach laufen beide Tunnel. Die Web-App ist damit im neuen Tunnel für das Techniker-Netz frei; die Freigabe je Adresse im alten VPN (`10.10.1.5`) bleibt daneben bestehen. Der neue Tunnel bekommt die Instanz der Fenster-Schlüssel, der alte behält seine. Ab diesem Schritt kommt SSH 2222 nur noch aus den beiden Tunneln an, nicht mehr aus dem LAN des Mango; dort bleibt Port 22.
4. Im Portal ein Fenster öffnen: Box `edge-zay5sdd`, der eigene Zugang, 1 Stunde, Grund „Wechsel auf den Wartungsserver".
5. Über den neuen Weg prüfen, alle drei Punkte:
   - `ssh mango-neu`. Der Host-Schlüssel muss `SHA256:9v/vmOZqCxM2vkV0IqYIjD3U3HL/Go44eeU83WTos8o` sein, sonst abbrechen.
   - `edge-light/openwrt/service-tunnel.sh mango-neu status`: Handshake auf `wg_wartung`, die Zeile `Web-App 8484 im Tunnel: Techniker-Netz 10.10.32.0/24` und `Fenster-Schluessel: Abholer laeuft`. Steht darunter „seit dem Start keine“ gültige Antwort, gibt der Wartungsserver noch keine Schlüssel aus; der Wechsel geht trotzdem weiter, die Anmeldung läuft dann über den dauerhaften Schlüssel.
   - Web-App: `http://<neue adresse>:8484/health` im Browser oder mit `curl` liefert `"status":"UP"` und `"ref":"edge-zay5sdd"`.
6. Nur wenn Schritt 5 gelingt: über den **neuen** Weg den alten Tunnel abbauen: `edge-light/openwrt/service-tunnel.sh mango-neu abbauen wg_service`.
7. Die Freigabe je Adresse aus dem alten VPN schließen, sie hat keinen Zweck mehr: `edge-light/openwrt/service-tunnel.sh mango-neu web` (ohne Adresse). Die Freigabe für das Techniker-Netz bleibt, `status` zeigt beides. Danach das Fenster im Portal schließen oder ablaufen lassen.
8. Optional und von Hand durch den Kapitän: den Peer des Piloten in WireGuard UI auf `vpn.voltpilot.de` entfernen. Die Fernwartung ändert dort nichts.

**Rückweg:** Bis Schritt 6 ist nichts verloren. Kommt der neue Tunnel nicht, baut man ihn über den alten wieder ab: `service-tunnel.sh mango-alt abbauen wg_wartung`; das räumt auch die Fenster-Schlüssel ab. Nach Schritt 6 ohne funktionierenden neuen Tunnel hilft nur noch der Zugang vor Ort. Die SSH-Schlüssel in `/etc/dropbear/authorized_keys` bleiben beim Wechsel gleich und gelten in beiden Tunneln. **Vor Schritt 6 muss die Anmeldung über `mango-neu` mit einem dauerhaften Schlüssel gelungen sein,** nicht nur mit einem Fenster-Schlüssel: Sonst hinge der einzige Zugang zum Piloten an Portal und Wartungsserver.

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

Im Flash bleiben Identität, Zertifikat, Auswahl, Freigaben, Fahrplan-Cache (alle 15 min) und das OCPP-Befehlsbuch (Sicherheit: höchstens einmal ausführen, auch über einen Neustart). Außerhalb des Programms schreibt die Fernwartung ihre [Ereignisliste](#protokoll-der-box-wer-wann-auf-einer-box-war) in den Flash: nur, wenn ein Ereignis dazukam, höchstens 250 Zeilen.

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
