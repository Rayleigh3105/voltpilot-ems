# WLAN-Labor: OpenWrt mit simuliertem Funk

Ein echtes OpenWrt 25.12.5 mit WLAN, ohne Mango, ohne Docker, ohne Root auf dem Rechner.
Gebaut für den WLAN-Anschluss der Box (`edge-light/openwrt/files/usr/libexec/vp-edge-light/wlan-anschluss.sh`); inzwischen prüft es auch das Einrichtungs-WLAN samt Wächter (`einrichtung-wlan.sh`, Läufe `einrichtung`, `fenster`), das Weiterlesen bei Routerausfall und -tausch (`routerausfall`) und die Einrichtungsseite der Web-App Ende-zu-Ende (`einrichtung-weg`: das echte Go-Programm, als i686 gebaut, läuft im Emulator).
Der nächste Schritt (Wiederfinden der Geräte, S6) verwendet es weiter.

```sh
edge-light/test/wlan-anschluss-probe.sh            # alle Läufe
edge-light/test/wlan-anschluss-probe.sh verbinden  # ein Lauf
LAUT=1 edge-light/test/wlan-anschluss-probe.sh scan  # Konsole mitlesen
```

## Was drin ist

| Teil | Stand |
|---|---|
| System | OpenWrt 25.12.5 `x86/generic` (Kernel und ext4-Abbild von downloads.openwrt.org) im Emulator v86 0.5.473 unter Node, 512 MB |
| Pakete | aus den signierten Indizes von 25.12.5 (`pakete.txt`): `kmod-mac80211-hwsim`, `wpad-basic-mbedtls`, `iw`, `iwinfo`, `relayd`, `ip-full`, `kmod-veth`, `tcpdump-mini` und ihre Abhängigkeiten; apk prüft die Signaturen im Gast |
| Funk | `mac80211_hwsim radios=4`: Kundenrouter (hostapd, WPA2, Kanal 6, Namensraum `kunde`, DHCP 192.168.178.100-150), Nachbar (WPA3/SAE, Kanal 11, Namensraum `nachbar`), Box (`radio0` mit dem echten netifd, hostapd und wpa_supplicant), Handy (`handy0`, Namensraum `handy`, für das Einrichtungs-WLAN) |
| Kabel | `kabel0` im `br-lan` der Box, `kabel1` im Namensraum `kabel` (steht für Smart Dongle oder Waveshare; Stellvertreter-Dienste auf 80, 502 und 4196); im Lauf `kabel` dazu `wan0` als Kabel zum Router (192.168.179.0/24) |
| Box | LAN `10.213.0.1/24` wie nach der Werkstatt; Funkmodul `radio0` wie OpenWrt 25.12.5 es anlegt (an, darauf das offene WLAN „OpenWrt“ im `lan` aus); Stellvertreter für Web-App 8484 und OCPP 8887 |

Abweichungen vom Gerät, ehrlich benannt:

- Funk ist simuliert: kein Rauschen, keine Dämpfung, das Signal steht fest bei -30 dBm. Reichweite, Wände und Antennen zeigt das Labor nicht; die Schwelle prüft der Lauf `messen` über `VP_WLAN_SCHWELLE`.
- Treiber `mac80211_hwsim` statt `mt7603`; beide melden „ein Kanal“, hostapd und wpa_supplicant sind dieselben Programme.
- Das Funkmodul trägt `aufbau.txt` von Hand ein, mit Band `2g` wie die Mango: `wifi config` nähme beim Simulator 6 GHz.
- i686 statt MIPS; Zeiten sind emuliert.
- `wpad` läuft ohne ujail-Sandbox: eingesperrt meldet sich `wpa_supplicant` im Emulator nicht am ubus.

## Dateien

| Datei | Zweck |
|---|---|
| `hole.sh` | holt Abbilder (gegen feste Prüfsummen), BIOS, v86 und Pakete in einen Zwischenspeicher außerhalb des Repos (`VP_WLAN_LABOR_CACHE`, Vorgabe `~/.cache/vp-wlan-labor`) |
| `boot.mjs` | startet OpenWrt und arbeitet eine Befehlsliste an der seriellen Konsole ab; `@<s>` setzt die Frist eines Befehls, `FRIST_FAKTOR` streckt alle |
| `laeufe/basis.txt`, `laeufe/aufbau.txt` | Pakete, Prüfhelfer, Skript der Box; Funk, Router, Kabelgerät |
| `laeufe/<lauf>.txt` | je Befehl ein Lauf mit festen Erwartungen |
| `werkzeug/pruef.sh` | Prüfhelfer im Gast: `pruefe`, `verneine`, `gleich` schreiben `PRUEF ok` oder `PRUEF FEHLER`, `info` einen Messwert ohne Urteil |
| `werkzeug/udhcpc.sh` | DHCP für die Namensräume |
| `werkzeug/http.sh` | roher HTTP-Aufruf über busybox `nc` (uclient-fetch kann weder Header noch Cookies): `http_ruf <ns> <adresse> <port> <methode> <pfad> [cookie] [json-body]`, dazu `http_status` und `http_cookie` |
| `werkzeug/beob-wlan.sh` | für die Fehlersuche: alle 2 s Client-Schnittstelle, Zustand von wpa_supplicant, WLAN-Adresse und lokale Adresse am Relay (`sh /tmp/labor/werkzeug/beob-wlan.sh > /tmp/beob.txt &` in einem Lauf) |

Neue Läufe: eine Datei unter `laeufe/`, eine Zeile je Befehl; die Probe hängt sie hinter `basis.txt` und `aufbau.txt`.
Das Skript der Box liegt im Gast unter `$W`, die Adresse des Kabelgeräts holt `dhcp_neu kabel kabel1`.

## Fallen

- Die Last des Rechners: unter hoher Last kommt OpenWrt im Emulator nicht rechtzeitig hoch. Die Probe wartet deshalb, bis die Last unter `VP_WLAN_LABOR_LAST` liegt (Vorgabe: Kerne × 1,5).
- Lange Zeilen verliert die serielle Konsole: `boot.mjs` sendet in Stücken von 48 Zeichen.
- `@<s>` wirkt nur am Zeilenanfang.
- Variablen der Konsole sind nicht exportiert: in `sh -c` doppelte Anführungszeichen, damit die Konsole sie einsetzt.
