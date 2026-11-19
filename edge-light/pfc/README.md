# Edge Light auf dem WAGO PFC200

Edge Light als eigenes Programm auf der WAGO-Firmware eines PFC200 (750-8212, zweite Generation, ARMv7), neben der SPS-Laufzeit.
Dasselbe Programm und dasselbe Update-Protokoll wie auf der Mango, nur ohne OpenWrt: BusyBox-Init statt procd, eine Einstellungsdatei statt UCI, ein eigener Benutzer statt root.

**Stand: von Hand einrichtbar, am Gerät noch nichts belegt.**
Alles hier ist gegen ein BusyBox-Linux für ARMv7 im Container geprüft, so nah an der WAGO-Firmware, wie die Unterlagen es hergeben (Firmware 27: glibc 2.35, BusyBox 1.34.1, BusyBox-Init).
Was nur ein echtes Gerät zeigen kann, steht unten als [Annahme mit Prüfstein](#annahmen-über-die-firmware).
Lesen aus der SPS, Werkstatt, Wartungstunnel und Koppelbild gehören nicht zu diesem Stand.

## Aufbau

```
edge-light/pfc/
├── README.md                              dieser Überblick
├── install.sh                             Einrichtung über SSH: Benutzer, Loader, Dienst, Vertrauens-Set, bestätigte Fassung
└── files/
    ├── etc/init.d/vp-edge-light           Dienst-Skript (start, stop, restart, status)
    └── home/voltpilot/
        ├── konfig                         Einstellungen (Schlüssel = Wert)
        └── libexec/boot.sh                Loader: Start aus dem RAM, Tausch, Probe, Behalten, Zurück
```

Die Proben dazu liegen bei den übrigen Proben von Edge Light:
`edge-light/test/pfc-install-probe.sh`, `edge-light/test/pfc-update-probe.sh` und `edge-light/scripts/pfc-abgleich.sh`.

## Was auf dem Gerät entsteht

| Ort | Was | Gehört |
|---|---|---|
| `/etc/init.d/vp-edge-light` | Dienst-Skript | root |
| `/etc/rc.d/S99_vp-edge-light` | Link auf das Dienst-Skript: Start beim Hochfahren | root |
| `/home/voltpilot/libexec/boot.sh` | Loader | root |
| `/home/voltpilot/konfig` | Einstellungen | root |
| `/home/voltpilot/fassung/` | die bestätigte Fassung, gepackt, mit Prüfsummen | voltpilot |
| `/home/voltpilot/daten/` | Kennung, Zertifikat, Vertrauens-Set, Auswahl, Marken der Update-Versuche | voltpilot (0700) |
| `/tmp/vp-edge-light/` | das entpackte Programm und alles, was laufend geschrieben wird (RAM) | voltpilot (0700) |
| `/home/voltpilot/programm/` | das entpackte Programm, nur wenn `/tmp` keine Programme startet | voltpilot |

Die Wurzel des Geräts bekommt nur das Dienst-Skript und seinen Link.
Alles andere liegt unter `/home/voltpilot`.
Die SPS-Laufzeit, ihre Dienste, die Firewall und die Netzeinstellungen des Geräts fasst weder `install.sh` noch das Programm an.

## Rechte

- Das Dienst-Skript ist der einzige Teil, der als root läuft.
  Es legt das RAM-Verzeichnis an, fragt die Bestellnummer des Geräts ab und wechselt dann zum Benutzer `voltpilot`.
- Loader und Programm laufen als `voltpilot` (ohne Passwort, ohne Anmeldung), mit `nice 10` hinter der SPS-Laufzeit.
  Der Loader verweigert den Start als root.
- Dienst-Skript, Loader und Einstellungen gehören root.
  Das Programm kann sie nicht ändern, auch nicht durch ein Update.
- Bei Speichernot beendet der Kern zuerst Edge Light (`oom_score_adj = 800`), nie die Laufzeit; Go bekommt ein weiches Speicherlimit (`gomemlimit = 96MiB`).
  Beide Zahlen sind Vorschläge, am Gerät noch nicht gemessen (PS-P6).

## Einrichten

Voraussetzung: SSH als root auf das Gerät, und das Programm für ARMv7.

```bash
edge-light/scripts/build.sh arm        # dist/vp-edge-light-linux-arm (oder die Fassung aus einem Release)
VP_LIGHT_MANIFEST=<release.json> edge-light/pfc/install.sh root@<pfc-ip>
ssh root@<pfc-ip> /etc/init.d/vp-edge-light restart
ssh root@<pfc-ip> /etc/init.d/vp-edge-light status
```

`install.sh` prüft zuerst, ohne etwas zu ändern, ob das Gerät alles Nötige mitbringt, und nennt, was fehlt.
Es legt den Benutzer an, kopiert Loader und Dienst-Skript, legt das Vertrauens-Set in den Flash und spielt das Programm als bestätigte Fassung ein.
Die Prüfsumme der Fassung wird auf dem Gerät nachgerechnet, bevor sie gilt.
Mit `VP_LIGHT_MANIFEST` (das signierte Manifest genau dieser Fassung) vermerkt die Box ihren Stand und kann die bestätigte Fassung nach einem Stromausfall beim Update aus dem Portal nachladen.
Ein erneuter Aufruf erneuert Loader, Dienst-Skript, Vertrauens-Set und Fassung; Kennung, Zertifikat, Auswahl und die Einstellungen bleiben.
Alle Variablen stehen im Kopf von [`install.sh`](install.sh).

Danach wird die Box gekoppelt wie jede andere, über die lokale Web-App `http://<pfc-ip>:8484`.

Das Protokoll von Loader und Programm geht an syslog, Marke `vp-edge-light`.

## Einstellungen

`/home/voltpilot/konfig`, eine Angabe je Zeile in der Form `schluessel = wert`.
Die Datei wird gelesen, nie ausgeführt.
`install.sh` legt sie nur an, wenn sie fehlt, und setzt darin nur `local_dir`, `arch`, `enabled` und bei Bedarf `programm_dir`.
Weitere Einstellungen der Box (wie in `edge-app/.env.example`) stehen als Zeilen `env = NAME=wert`.
Eine Änderung wirkt nach `/etc/init.d/vp-edge-light restart`.

Zwei Dinge sind nicht einstellbar:

- **Der Port des Modbus-Datenspiegels ist fest 1502.**
  Auf 502 sitzt der Modbus-Server der SPS.
  Der Datenspiegel bleibt ab Werk aus; eingeschaltet lauscht er auf 1502, und die Web-App nennt denselben Port.
- **Die Modellangabe kommt vom Gerät.**
  Das Dienst-Skript fragt `/etc/config-tools/get_coupler_details order-number` ab; daraus wird „WAGO 750-8212“ in der Geräteliste.
  Antwortet das Werkzeug nicht, nennt die Box, was das Gerät sonst über sich sagt (`/proc/device-tree/model`), und rät nichts.

## Ports

| Port | Wofür | Erreichbar |
|---|---|---|
| 8484 | lokale Web-App | im Netz des Geräts |
| 8887 | OCPP, nur wenn Ladesäulen angebunden sind | im Netz des Geräts |
| 1883 | lokaler Bus | nur auf dem Gerät selbst (127.0.0.1) |
| 1502 | Modbus-Datenspiegel, ab Werk aus | im Netz des Geräts, wenn eingeschaltet |

80, 443, 8080 und 8081 belegt die WAGO-Firmware, 502 die SPS.
Ob 8484, 8887, 1883 und 1502 am Gerät wirklich frei sind, zeigt PS-P5.

## Updates

Unverändert die Edge-Light-Linie ([Updates](../docs/boot-und-updates.md)): Das Programm prüft Manifest und Signatur, lädt die Fassung in den RAM, der Loader tauscht beim nächsten Start, die neue Fassung läuft zehn Minuten zur Probe und wird behalten oder zurückgenommen.
Jede Edge-Light-Fassung enthält dafür ein Programm `vp-edge-light:linux/arm`.
Eine ältere Fassung ohne dieses Programm wendet die Box nicht an und sagt das.

Ein Update tauscht nur das Programm.
**Loader und Dienst-Skript ändern sich nur durch `install.sh`:** Das Loader-Selbstupdate der Mango gibt es auf dem PFC200 nicht.
Das Programm sucht den Loader am Pfad der Mango, findet dort keinen und schreibt nichts.
Die Firmware des PFC200, die CODESYS-Laufzeit und das SPS-Programm werden nie von selbst getauscht.

Der Loader trägt zwei Marken:

- `PFC_LOADER_STAND`: der Stand von Loader und Dienst-Skript des PFC200; bei jeder Änderung an einem der beiden erhöhen.
- `ABGLEICH_MANGO_STAND`: der `LOADER_STAND` des Mango-Loaders, mit dem die gemeinsamen Funktionen abgeglichen sind.

Die Funktionen des Update-Protokolls stehen im Loader des PFC200 wortgleich wie im Mango-Loader.
`edge-light/scripts/pfc-abgleich.sh` (Teil von `scripts/test.sh`) scheitert, sobald eine davon abweicht oder der Mango-Loader einen neuen Stand trägt.

## Was belegt ist

```bash
VP_LIGHT_VERSION=edge-light-2099.01.0 edge-light/scripts/build.sh arm   # ein Release-Name: die Probe erzeugt dazu ein Manifest
edge-light/test/pfc-install-probe.sh    # install.sh, Dienst und Loader mit dem echten ARMv7-Programm
edge-light/test/pfc-update-probe.sh     # das Update im Loader: dieselben Fälle wie boot-update-probe.sh der Mango
edge-light/scripts/pfc-abgleich.sh      # Loader wortgleich mit dem Mango-Loader; läuft in scripts/test.sh
```

Beide Proben laufen in `busybox:1.34.1-glibc` für `linux/arm/v7`, ohne Netz, mit BusyBox-Init als erstem Prozess.

| Probe | Belegt |
|---|---|
| `pfc-install-probe.sh` | `install.sh` verweigert vor dem ersten SSH-Aufruf, was nicht passt, und ändert nichts, wenn dem Gerät ein Werkzeug fehlt. Ablage, Eigentümer und Schreibschutz stimmen. Das echte Programm läuft als `voltpilot` mit `nice 10`, meldet „WAGO 750-8212“ und `arm` und ist update-bereit. Der Datenspiegel ist aus und lauscht eingeschaltet auf 1502, nichts auf 502. Der Dienst startet das Programm nach einem Absturz nach 10 s neu, beendet es geordnet und startet nach „Strom aus“ von selbst. Ein zweiter Aufruf von `install.sh` erhält Einstellungen und Kennung. Trägt `/tmp` `noexec`, läuft das Programm aus dem Flash |
| `pfc-update-probe.sh` | Als Benutzer `voltpilot`: Gut-Fall mit Behalten; Probestart scheitert; drei Abstürze; keine Cloud bis zur Frist; Selbsttest durchgefallen; Fälschung im RAM; Strom weg in der Probe; Strom weg beim Tausch mit Nachladen genau dieser Fassung; Obergrenze der Marken im Flash. Mit dem echten Programm: Probestart, Urteil „offen“ ohne Cloud, Rücknahme mit dessen Grund, geordnetes Ende auf TERM. Kein Loader-Selbstupdate, auch wenn das Programm am Pfad der Mango schreiben dürfte |

**Was der Container nicht belegt:** alles, was von der echten Firmware abhängt.
Er hat keine SPS-Laufzeit, kein WBM, keine Firewall, kein echtes `get_coupler_details`, keinen echten Flash und rechnet unter Emulation.

## Annahmen über die Firmware

Jede Annahme ist so gebaut, dass `install.sh` oder der Dienst sie am Gerät prüft und einen Fehler nennt, statt still etwas Falsches zu tun.
Die Prüfsteine PS-P… sind die des PFC200-Konzepts (Abschnitt 7, „Prüfsteine am Test-PFC200“).

| Annahme | Was geschieht, wenn sie nicht stimmt | Prüfstein |
|---|---|---|
| SSH als root; `su`, `adduser` oder `useradd`, `sha256sum`, `gunzip`, `awk`, `sed`, `logger`, `nice`, `df` sind vorhanden | `install.sh` nennt, was fehlt, und ändert nichts | PS-P3 (Zusatz unten) |
| `su -s /bin/sh voltpilot -c ...` wechselt als root ohne Passwort zum Benutzer | `install.sh` prüft es durch einen echten Wechsel und bricht sonst ab | PS-P3 (Zusatz unten) |
| `get_coupler_details order-number` antwortet mit der Bestellnummer in einer Zeile | die Modellangabe fällt auf `/proc/device-tree/model` zurück; das Programm läuft | PS-P3 |
| Der Kern kennt `vfpv3`; das Programm ist für ARMv7 mit Gleitkomma-Einheit gebaut (`GOARM=7`) | das Programm startet nicht; der Loader meldet es und versucht es weiter | PS-P3, PS-P6 |
| `/home` liegt auf der Datenpartition und hat Platz für die gepackte Fassung (etwa 6 MB, beim Update kurz das Doppelte) | das Kopieren scheitert oder die Prüfsumme auf dem Gerät stimmt nicht; `install.sh` bricht ab, bevor die Fassung gilt | PS-P4 |
| `/tmp` liegt im RAM und startet Programme | `install.sh` prüft es durch einen echten Start und legt das Programm sonst nach `/home/voltpilot/programm`; liegt `/tmp` nicht im RAM, ist `ram_dir` anzupassen | PS-P4 |
| Neben der Laufzeit bleiben etwa 27 MB RAM frei (15 MB entpacktes Programm plus 12 MB Reserve; während eines Updates mehr) | der Loader startet nicht und nennt den gemessenen Wert und die Schwelle | PS-P4, PS-P6 |
| 8484, 8887, 1883 und 1502 sind frei | das Programm meldet den belegten Port im Protokoll; `web_addr` und `bus_addr` sind einstellbar | PS-P5 |
| Die Firmware startet beim Hochfahren jedes `/etc/rc.d/S*` mit `start`; `S99_` kommt nach dem Netz | der Dienst startet nicht von selbst; der Name des Links ist mit `VP_PFC_RC_LINK` wählbar, fehlt `/etc/rc.d`, sagt `install.sh` das | PS-P7, PS-P15 |
| `wget` oder `curl` des Geräts kann HTTPS und kennt die Wurzeln, denen das Portal vertraut | betrifft nur das Nachladen der bestätigten Fassung nach Strom weg beim Tausch; der Loader meldet „kein startbares Programm“ und versucht es weiter | PS-P3 (Zusatz unten) |
| `syslogd` läuft; `logger` schreibt dorthin | das Protokoll fehlt; `status` und `/health` antworten weiter | PS-P7 (Zusatz unten) |
| Ein Firmware-Update lässt `/home/voltpilot` stehen, die Wurzel nicht | Dienst-Skript und Link fehlen danach; `install.sh` erneut ausführen | PS-P17 |

## Handgriffe für Stufe 0

Stufe 0 misst am Test-Gerät, bevor dort etwas eingerichtet wird: acht Prüfsteine, nur lesen.
`<pfc>` ist die Adresse des Test-Geräts.
Die Befehle sind Vorschläge aus den Unterlagen und gewöhnlichem Linux; am Gerät belegt ist keiner.

| # | Handgriff | Festhalten |
|---|---|---|
| PS-P1 | Gerät im Werkszustand an ein Netz mit DHCP stecken und einschalten | Adresse, Name, MAC, Sekunden bis dahin; antwortet `https://<pfc>/wbm` |
| PS-P2 | Schalter auf STOP, Reset länger als 8 s drücken | SYS blinkt orange; 192.168.1.17 antwortet; nach einem Neustart wieder weg |
| PS-P3 | Befehl unten | SSH als root möglich; Firmware-Stand, Kern, Modellzeile, `vfpv3`, Bestellnummer |
| PS-P4 | Befehl unten | freier RAM mit laufender Laufzeit; freier Platz der Datenpartition; ob `/tmp` im RAM liegt und `noexec` trägt |
| PS-P5 | Befehl unten | jeder Port mit Programm und Adresse |
| PS-P7 | Befehl unten | Startreihenfolge, Muster der vorhandenen Skripte |
| PS-P16 | Befehl unten | vorhandene Update-Werkzeuge der Firmware (für diesen Stand nur Auskunft) |
| PS-P20 | Befehl unten | WireGuard im Kern, ja oder nein (für diesen Stand nur Auskunft) |

```bash
# PS-P3: wer ist das Gerät, und was kann es
ssh root@<pfc> 'cat /etc/REVISIONS; uname -srm; cat /proc/device-tree/model; grep -E "model name|Features|Hardware" /proc/cpuinfo; /etc/config-tools/get_coupler_details order-number'
# PS-P4: Platz, und ob /tmp im RAM liegt und noexec trägt
ssh root@<pfc> 'free -m; df -h; mount; head -5 /proc/meminfo'
# PS-P5: was lauscht ab Werk
ssh root@<pfc> 'netstat -tlnup'
# PS-P7: wo hängt ein eigener Dienst
ssh root@<pfc> 'cat /etc/inittab; ls -la /etc/rc.d /etc/init.d'
# PS-P16: Update-Werkzeuge der Firmware
ssh root@<pfc> 'ls /etc/config-tools | grep -i -E "fw|firmware|update|image|backup"; rauc status 2>&1 | head -20'
# PS-P20: WireGuard im Kern
ssh root@<pfc> 'modprobe wireguard; ip link add vp-t type wireguard && echo kern_ja; ip link del vp-t; ls /dev/net/tun'
```

Zusätze für diesen Stand, im selben Besuch:

```bash
# Werkzeuge, die install.sh und der Dienst brauchen (jede Zeile "fehlt: ..." ist ein Befund)
ssh root@<pfc> 'for w in su adduser useradd sha256sum gunzip awk sed grep cut tr head tail logger nice id chown df wget curl; do command -v $w >/dev/null || echo "fehlt: $w"; done; busybox | head -n 1; ls -l "$(command -v su)"'
# Nachladen: kann das Gerät das Portal über HTTPS erreichen
ssh root@<pfc> 'wget -q -T 20 -O /dev/null https://portal.voltpilot.de/api/v1/edge/trust-set/trust-set.json && echo https_ja'
# Protokoll: wohin schreibt logger
ssh root@<pfc> 'logger -t vp-probe hallo; ps | grep -i [s]yslog; grep -l vp-probe /var/log/* 2>/dev/null'
```

Festhalten: die Ausgaben als Text, dazu den Firmware-Stand.
Weicht eine Antwort von der Tabelle oben ab, wird zuerst dieser Ordner angepasst und die Probe im Container nachgezogen, dann erst eingerichtet.

## Labortest am Test-Gerät

Beschrieben, nicht ausgeführt: Das Test-Gerät ist erst mit Stufe 0 erreichbar.
Er folgt auf Stufe 0 und setzt voraus, dass deren Antworten zur Tabelle oben passen.
Der Test braucht eine Edge-Light-Fassung, die nach diesem Stand gebaut ist (mit `linux/arm`), und für den Update-Teil eine zweite, neuere.

1. **Einrichten.**
   `VP_LIGHT_MANIFEST=<release.json> edge-light/pfc/install.sh root@<pfc>` mit dem Programm `vp-edge-light-linux-arm` der Fassung in `edge-light/dist/`, dann `restart`.
   Erwartet: `status` nennt Dienst und Programm; im syslog steht „device detected“ mit `"model":"WAGO 750-8212","arch":"arm"`.
2. **Läuft es, und was kostet es (PS-P6).**
   Nach zehn Minuten: `ssh root@<pfc> 'for q in /proc/[0-9]*; do case "$(readlink $q/exe)" in */vp-edge-light/vp-edge-light | */programm/vp-edge-light) grep -E "VmRSS|VmHWM|Threads" $q/status ;; esac; done; top -bn1 | head -15; free -m; wget -qO- http://127.0.0.1:8484/health'`.
   Festhalten: RAM des Prozesses, Rechenlast neben der Laufzeit, freier RAM.
   Daraus folgen `gomemlimit` und `prozess_reserve_kb`.
3. **Geräteliste.**
   Box über `http://<pfc>:8484` koppeln.
   Erwartet im Portal unter Plattform, „Geräte & Updates“: „WAGO 750-8212 · arm“, Loader „kennt Updates (Stufe 2)“.
4. **Kaltstart (PS-P15).**
   Strom aus, 10 s warten, Strom an.
   Festhalten: Sekunden bis SYS grün und bis `/health` antwortet; der Dienst startet von selbst, die Kennung ist dieselbe.
5. **Rücknahme.**
   Im Portal die neuere Fassung zuweisen und den Weg ins Internet trennen (am Router des Labornetzes, nicht am Gerät, damit SSH bleibt), sobald `/home/voltpilot/daten/ota/versuche` die Zeile `start` trägt.
   Erwartet: Nach zehn Minuten nimmt der Loader zurück (`zurueck ... keine Cloud-Verbindung in der Probezeit`), die alte Fassung läuft; mit Internet meldet das Portal die Rücknahme mit diesem Grund.
6. **Strom weg in der Probe.**
   Die neuere Fassung erneut zuweisen und den Strom ziehen, sobald `versuche` die Zeile `start` trägt.
   Erwartet: Die alte Fassung startet, `versuche` trägt `abbruch`; die Box versucht dieselbe Zuweisung danach von selbst noch einmal.
7. **Update mit Probe.**
   Den Versuch aus Schritt 6 laufen lassen.
   Erwartet: Die Box lädt, startet neu, läuft zehn Minuten zur Probe und behält; `versuche` trägt `ok`, die Geräteliste nennt die neue Fassung.

Während aller Schritte läuft die SPS-Laufzeit weiter; SYS bleibt grün.

Keine Aussage zu Produktsicherheit, CE oder Normkonformität des Geräts mit zusätzlicher Software.
