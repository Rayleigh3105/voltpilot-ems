# Direktvermarktung auf der Mango (Stufe 2)

Die Box ist die Direktvermarktungsschnittstelle der Anlage (Konzept `vp-direktvermarktung-konzept` d2, Entscheide E1=A, E2=A vom 25.11.2026):
ein OpenVPN-Client zum Partner und ein Modbus-TCP-Server mit der Registerbelegung des Partners, erreichbar NUR über den Tunnel.
Dieses Dokument beschreibt, was davon auf der Mango lebt, welche Dateien die Zustellung legt, und die Messwerte zu PS-D2.

## Wo was lebt

| Teil | Ort |
|---|---|
| Tunnel-Verwalter, Zustandsmaschine (§5.4), Ereignisliste | `edge-app/core/internal/vermarktertunnel` (laeuft im Agent, `agent/direktvermarktung.go`) |
| Schnittstelle (Datenspiegel mit schreibbaren Halteregistern) | `edge-app/core/internal/direktvermarkter` (Stufe 1), gebunden an `<tunnel-adresse>:502` |
| Partner-Grenze im Einspeisewaechter | `exportLimit = min(registrierte Grenze, Partner-Grenze)` am Eintritt der registrierten Grenze in `applySetpoint`; Speicher-Kaskade zuerst (`guards/exportcascade.go`, E2) |
| Tunnel-Start beim Booten | `edge-light/openwrt/files/etc/init.d/vp-vermarkter` - der Tunnel gehoert zum System, nicht zum Programm (PS-D8) |
| Firewall | fw4-Zone `vermarkter` plus `/etc/nftables.d/30-vp-vermarkter.nft` (harte Ketten: eingehend nur TCP 502 zur Tunnel-Adresse, keine Weiterleitung, ausgehend in den Tunnel nur Antworten) |
| Stand fuer die Web-App | `GET /api/direktvermarktung` auf `:8484` (Lage, Partner, Vorgabe, Grenze; nie ein Geheimnis) |

Der OpenVPN-Daemon laeuft daemonisiert mit pid-Datei (`/tmp/vp-vermarkter/`):
ein Programm-Update oder -Absturz laesst den Tunnel stehen, das neue Programm adoptiert ihn.
Die Konfiguration erzeugt die Box SELBST aus Profil und Zugang (nie die Datei des Partners im Ganzen):
`route-nopull` + `pull-filter ignore` (keine gepushten Routen, kein redirect-gateway, kein DNS), `script-security 0`, `remote-cert-tls server`, Prozess ohne Rechte nach dem Start.

## Was die Zustellung legt (Vertrag mit vp-dv-zustellung)

Solange die Zustellung aus der Cloud (Aufgabe `vp-dv-zustellung`) nicht gebaut ist, legt die Werkstatt oder ein Techniker dieselben Dateien von Hand.
Verzeichnis: `/etc/vp-edge-light/vermarkter` (Flash, uebersteht sysupgrade mit `/etc/vp-edge-light/`), alles root 0600/0700.
Masssgeblich ist der Package-Doc-Kommentar in `edge-app/core/internal/vermarktertunnel/zugang.go`; kurz:

| Datei | Inhalt |
|---|---|
| `anschluss.json` | `{"partner":"luox","referenz_wp":12000}` - Partner-Id aus dem eingebetteten Katalog und die Referenzleistung der Anlage in Watt (F6: was sie bedeutet, entscheidet die zustellende Cloud) |
| `zugang/zugang.json` | Gegenstelle (`host`, `port`, `protokoll` udp/tcp), `tls_schluessel` (`tls_crypt`/`tls_auth`/`keine`), `gueltig_bis`, `fingerabdruck` |
| `zugang/ca.pem`, `zugang/zertifikat.pem`, `zugang/schluessel.pem` | CA des Partners, Anlagen-Zertifikat, privater Schluessel |
| `zugang/tls.key` | nur bei `tls_crypt`/`tls_auth` |

Das Register-Bild, die Wortfolge (F3) und die Regeln kommen NIE aus der Zustellung, sondern aus dem eingebetteten Katalog (`catalog/direktvermarkter`); die Zustellung waehlt nur den Partner.
`anschluss.json` entfernen zieht den Anschluss zurueck: Tunnel aus, Firewall-Oeffnung weg, Schnittstelle zu.
Das Loeschen der Zugangs-DATEIEN beim Rueckzug gehoert der Zustellung (Konzept §5.7 "Box loescht und quittiert") und ist hier bewusst nicht eingebaut.

Offene Annahmen von luox bleiben markiert, je genau ein Wert:
Wortfolge F3 (`wortfolge_laufzeit` in den Katalog-Vektoren), Verhalten bei veralteten Werten F8 (`bei_veraltet_laufzeit`), Bezugsgroesse der Vorgabe F5 (`vorgabe_wirkt_auf`, aufgeloeste Basis `einspeisung_netzpunkt`), Register 4 ohne Netzbetreiber-Signal F7 (`netzbetreiberOhneSignalPct` in `agent/direktvermarktung.go`), Port und Protokoll F1 (je Anlage in `zugang.json`).

## Beweis ohne Hardware

`edge-light/test/direktvermarktung-probe.sh`: echtes `vp-edge-light` auf OpenWrt 25.12.5 im Container, echter OpenVPN-Tunnel zu einem Labor-Server, `vp-luox-sim` liest und schreibt durch den Tunnel.
Belegt PS-D3, PS-D4, PS-D16, PS-D17 sowie PS-D5/D7/D8 und die Stoerfaelle aus §5.6 (Ablauf-Frist verkuerzt ueber `VP_VERMARKTER_LEBENSZEICHEN_S`, ein NUR-kuerzender Test-Regler; `VPDV_LEBENSZEICHEN=900` faehrt die volle Frist).
PS-D9 (Speicher laedt zuerst) haengt an einem geregelten Wechselrichter und ist als Go-Test belegt (`guards/exportcascade`-Tests, `agent/direktvermarktung_test.go`); die Probe zeigt, dass die Partner-Grenze den Einspeisewaechter erreicht.
PS-D2/PS-D19 am echten Geraet (Labor-Mango, 24-h-Lauf) bleiben offen bis zur Hardware-Runde.

## PS-D2: Flash und RAM von OpenVPN

Gewaehlt: `openvpn-mbedtls` (wie Konzept §4), OpenWrt 25.12.5, Ziel `ramips/mt76x8` (`mipsel_24kc`), Stand 25.11.2026 aus dem offiziellen Paket-Feed:

| Paket | Download | installiert |
|---|---|---|
| `openvpn-mbedtls 2.7.8-r1` | 212 KB | 411 KB |
| `kmod-tun 6.12.94-r1` | 22 KB | 45 KB |
| `libmbedtls21 3.6.7-r1` (nur falls noch nicht da; `ustream-mbedtls`-Systeme haben sie) | 306 KB | 639 KB |

Zusammen 456 KB installiert (schlimmstenfalls 1,1 MB mit `libmbedtls21`) bei rund 4,5 MB freiem Flash - der Rahmen "rund 0,6 MB" aus Konzept §4 haelt.
RAM: die Container-Probe druckt `VmRSS` des OpenVPN-Prozesses in Schritt 9 (x86/arm unter Docker, Anhaltswert); die massgebliche mipsel-Zahl und `MemAvailable` unter Volllast (PS-D19) misst die Labor-Mango-Runde mit `cat /proc/<pid>/status` nach 10 Minuten Tunnel.
