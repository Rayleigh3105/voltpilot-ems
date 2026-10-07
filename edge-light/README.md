# Edge Light

> **Weitermachen?** Stand, Entscheidungen, Messwerte und die nächsten Schritte stehen in der [Übergabe](docs/uebergabe.md).

Die VoltPilot-Box als **ein einziges Programm** – ohne Docker, ohne Node-RED. Gebaut für kleine Router wie den GL.iNet Mango (OpenWrt, MIPS, 128 MB RAM, 16 MB Flash), läuft aber auf jedem Linux (arm64, amd64).

**Ziel:** Edge Light und die Docker-Box bestehen vorerst nebeneinander, je nach Anwendungsfall (Produktentscheid 07.10.2026): Edge Light für kleine Hardware und einfachere Anlagen, die Docker-Box für komplexere Anforderungen vor Ort, die bessere Hardware brauchen. Was Edge Light kann, misst die [Paritätsliste](docs/paritaet.md); ob die Docker-Box je auf dasselbe Programm umgestellt wird, ist offen.

## Stand: Stufe 1 (Fundament + Deye-Monitoring)

| | |
|---|---|
| **Funktioniert** | Alles, was der Go-Core heute schon kann (Kopplung, Cloud-Verbindung, Pufferung, Fahrplan, Schutzgrenzen, OCPP-Lastmanagement inkl. PV-Überschussladen, Shelly, lokale Web-App `:8484`), **plus** Deye lesen über den Solarman-Datenlogger (alle vier Gerätefamilien) und „Verbindung testen" für den Deye |
| **Noch nicht** | Alle anderen Lesewege, Wechselrichter-Steuerung (und damit die Speicherfreigabe von „Sonne + Speicher“, die Box fährt dort „Nur Sonne“), weitere Energiequellen, Kundenautomationen – siehe [Paritätsliste](docs/paritaet.md). Nicht unterstützte Anbindungen werden **benannt**, nie still übergangen |
| **Bewiesen** | Gemeinsame Testvektoren mit Node-RED (23 Dekodier- und 50 Protokollfälle), Integrationstest „unveränderter Core + Go-Schicht 1", MIPS-Programm unter Emulation ([Smoke-Test](test/qemu-smoke.sh)) |
| **Offen vor einem Kundeneinsatz** | Signierte Startkette und Updates ([Stufe 2](docs/boot-und-updates.md)), Pilot auf einem echten Mango ([Mango-Notizen](docs/mango.md)) |

## Bauen und prüfen

Benötigt Go ≥ 1.24 **oder** Docker (die Skripte wählen selbst).

```bash
edge-light/scripts/test.sh          # Vektoren, Go-Tests (mit Race-Detector), MIPS-Build
edge-light/scripts/build.sh         # dist/vp-edge-light-linux-{mipsle,arm64,amd64} + .sha256
edge-light/test/qemu-smoke.sh       # MIPS-Programm unter Emulation gegen simulierten Deye
```

Lokal ohne Router ausprobieren (amd64):

```bash
edge-light/scripts/build.sh amd64
(cd edge-app/core && go run ./cmd/vp-solarman-sim) &        # simulierter Deye-Logger auf :8899
VP_DATA_DIR=/tmp/vp VP_PORTAL_BASE_URL=http://127.0.0.1:9 \
  edge-light/dist/vp-edge-light-linux-amd64
# http://127.0.0.1:8484 → Einrichten → Deye, IP 127.0.0.1, Port 8899, Seriennummer 2985159064
```

## Auf einem OpenWrt-Router (Pilot)

Das Programm läuft bei **jedem Start aus dem RAM** (`/tmp`). Im Flash liegt nur eine gepackte Kopie (~4,4 MB gzip), die der Loader beim Start entpackt und gegen ihre Prüfsumme prüft – so startet die Box auch ohne Download-Server und nach einem Stromausfall ohne Internet. Mit `base_url` lädt der Loader zusätzlich die aktuelle Fassung per HTTPS. Ablauf und Grenzen: [Mango-Notizen](docs/mango.md).

```bash
edge-light/scripts/build.sh mipsle
edge-light/openwrt/install.sh root@<mango-ip>                    # Kopie in den Flash, Dienst aktivieren
# optional: edge-light/openwrt/install.sh root@<mango-ip> https://<server>/edge-light
ssh root@<mango-ip> /etc/init.d/vp-edge-light restart
```

Der Dropbear des Mango-Images kennt nur **RSA**-Schlüssel (kein Ed25519) – für den SSH-Zugang einen RSA-Schlüssel hinterlegen.

> ⚠ **Stufe 1 ist ein Pilotstand.** Die Echtheit des Programms hängt an HTTPS bzw. an der per SSH aufgespielten Kopie; die signierte Kette folgt in Stufe 2. Nicht auf eine Kundenflotte ausrollen, bevor Stufe 2 steht.

## Aufbau

```
edge-light/
├── README.md                  dieser Überblick
├── docs/
│   ├── uebergabe.md           Stand, Entscheidungen, Messwerte, nächste Schritte (Einstieg)
│   ├── architektur.md         ein Programm = Core + Go-Schicht 1; der lokale Bus als Vertrag
│   ├── paritaet.md            was schon in Go läuft, was fehlt, Reihenfolge
│   ├── boot-und-updates.md    RAM-Start, signierte Kette (Stufe 2), Updates, Rückfall
│   └── mango.md               GL.iNet Mango: Speicher, Flash, Ports, WireGuard, Pilotplan
├── openwrt/
│   ├── install.sh             Einrichtung über SSH (auch durch den WireGuard-Tunnel)
│   ├── service-tunnel.sh      Wartungstunnel ins Service-VPN (WireGuard, nur Schlüssel-SSH)
│   └── files/                 Loader, procd-Dienst, UCI-Konfiguration
├── scripts/                   build.sh, test.sh (lokales Go oder Docker)
└── test/
    ├── qemu-smoke.sh          MIPS-Programm unter qemu gegen simulierten Logger
    └── mango-labtest.sh       Start + Messung auf einem echten Mango per SSH (ohne Portal)
```

**Der Go-Code liegt in `edge-app/core`**, nicht hier – aus einem harten Grund: Go erlaubt den Zugriff auf `internal/`-Pakete nur innerhalb des Moduls. Edge Light *ist* der bestehende Core plus neue Pakete; eine Kopie wäre sofort eine zweite Wahrheit. Die neuen Pakete:

| Paket | Aufgabe |
|---|---|
| `edge-app/core/cmd/vp-edge-light` | das Programm |
| `edge-app/core/internal/edgemain` | der gemeinsame Programmrahmen von `vp-edge-core` und `vp-edge-light` |
| `edge-app/core/internal/layer1` | die Go-Schicht 1 (ersetzt Node-RED Funktion für Funktion) |
| `edge-app/core/internal/solarmanv5` | Solarman-V5-Protokoll (Zwilling von `nodered/deye/solarman-v5.js`) |
| `edge-app/core/internal/deyedecode` | Deye-Registerkarten und Dekodierung (Zwilling von `nodered/deye/deye-decode.js`) |
| `edge-app/core/internal/goeapi` | go-e HTTP-API v2 lesen (Zwilling von `nodered/goe/goe-api.js`) |
| `edge-app/core/cmd/vp-solarman-sim` | simulierter Deye-Logger für Tests (nie beim Kunden) |
