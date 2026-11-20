# vp-wartung: der Wartungstunnel als ein Programm

Die Box-Seite des Wartungstunnels für Geräte ohne OpenWrt, zuerst für den WAGO PFC200 (Edge Industrie).
Auf der Mango (Edge Light) richtet `edge-light/openwrt/service-tunnel.sh` denselben Tunnel mit dem WireGuard des Kerns, Dropbear und Regeln in der Firewall ein.
Der PFC200 hat kein WireGuard im Kern, und seine Firewall gehört der WAGO-Firmware; darum läuft hier alles in einem Prozess.
Regeln, Vertrag und Hintergrund: [Fernwartung](../../docs/fernwartung.md#boxen-ohne-openwrt-das-tunnel-programm-vp-wartung), [Schlüsselausgabe v1](../../docs/contracts/fernwartung-schluessel-v1.md).
Einrichten auf dem Gerät: [`edge-industrie/wartung.sh`](../wartung.sh), beschrieben in [edge-industrie/README.md](../README.md#wartungstunnel).

Das Programm gehört zum Betriebssystem der Box, nicht zum Box-Programm `vp-edge-industrie`.
Es ist ein eigenes Go-Modul mit eigenen Abhängigkeiten (wireguard-go, gVisor-Netstack, `x/crypto/ssh`); `edge-app/core` und das Programm der Mango bleiben davon unberührt.
Kein Update aus dem Portal tauscht es: Es kommt durch `wartung.sh` auf das Gerät.

## Aufbau

| Paket | Aufgabe |
|---|---|
| `cmd/vp-wartung` | das Programm: `lauf`, `schluessel`, `status [werte]`, `ereignisse`, `pruefe`, `hostschluessel`, `fassung` |
| `internal/tunnel` | WireGuard im eigenen Prozess (wireguard-go mit Netstack): keine Schnittstelle im Kern, keine Route, keine Firewall-Regel |
| `internal/sshd` | SSH-Server auf 2222 im Tunnel: nur root, nur Schlüssel; Befehl mit Standardeingabe, Shell mit Terminal, Weiterleitung; kein SFTP |
| `internal/bestand` | wer sich jetzt anmelden darf: Fenster-Schlüssel mit Frist in Laufzeit (nur im Speicher), dauerhafte Schlüssel aus `/root/.ssh/authorized_keys` (nur gelesen) |
| `internal/abholer` | fragt die Schlüsselausgabe des Wartungsservers, nur durch den Tunnel |
| `internal/vertrag` | die Prüfregel für die Antwort der Schlüsselausgabe, Zwilling von `pruefe` im Abholer der Mango |
| `internal/hostkey` | liest die Host-Schlüssel des Dropbear des Geräts (Dropbear-Format) |
| `internal/ereignisse` | Ereignisliste im Flash: nur bei einem Ereignis, höchstens 250 Zeilen, nie ein Schlüssel |
| `internal/stand` | der Stand für `status`, eine Datei im RAM |
| `internal/konfig` | die Einstellungen (`schluessel = wert`) |
| `internal/dienst` | das laufende Programm: verbindet die Teile, streicht Verfallenes im eigenen Takt, pflegt den Endpunkt |
| `cmd/vp-wartung-gegenstelle` | Prüfwerkzeug: ein Wartungsserver im Kleinen für die Probe; kommt auf kein Gerät |

## Was die Bauart festlegt

- **SSH 2222 und die Web-App 8484 lauschen auf keiner Netzbuchse.**
  Beide Lauscher leben im Netstack des Tunnels; am Gerät öffnet das Programm nur einen UDP-Socket für WireGuard.
- **Die Schlüsselausgabe wird nur durch den Tunnel gefragt.**
  Der Abholer hat keinen anderen Weg.
- **Fenster-Schlüssel stehen in keiner Datei.**
  Sie liegen im Speicher des Prozesses; ein Neustart des Programms oder des Geräts löscht jeden.
- **Fristen laufen auf der monotonen Uhr.**
  Die Uhr des PFC200 steht ab Werk falsch und springt beim ersten Zeitabgleich; eine Frist verlängert das nicht.
- **Jede Verbindung kennt ihren Schlüssel.**
  Gilt ein Fenster-Schlüssel nicht mehr, endet genau die Verbindung, die mit ihm begann; „nicht zuzuordnen“ gibt es hier nicht.
- **Keine zweite Identität.**
  Der Server zeigt die Host-Schlüssel des Geräts; kann er keinen lesen, startet er nicht.

## Prüfen

```bash
cd edge-industrie/wartung && go vet ./... && go test -race ./...   # mit echtem WireGuard über die Schleife des Rechners
edge-light/scripts/pruefregel-abgleich.sh                      # die Prüfregel der Mango gegen dieselben Fälle
edge-industrie/scripts/build-wartung.sh                        # edge-industrie/dist/vp-wartung-linux-arm
edge-industrie/test/wartung-probe.sh                           # wartung.sh, Dienst und das ARMv7-Programm im Container
```

`edge-light/scripts/test.sh` führt die ersten beiden Zeilen und den Bau für ARMv7 mit aus.
Die Tests der Pakete laufen auch als 32-Bit-ARM-Programme (`GOOS=linux GOARCH=arm go test -c`, im Container gestartet); der Test mit Terminal läuft nur unter Linux.
