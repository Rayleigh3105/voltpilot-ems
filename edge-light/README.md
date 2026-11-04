# Edge Light

> **Weitermachen?** Stand, Entscheidungen, Messwerte und die nächsten Schritte stehen in der [Übergabe](docs/uebergabe.md).

Die VoltPilot-Box als **ein einziges Programm** – ohne Docker, ohne Node-RED. Gebaut für kleine Router wie den GL.iNet Mango (OpenWrt, MIPS, 128 MB RAM, 16 MB Flash), läuft aber auf jedem Linux (arm64, amd64).

**Ziel:** Edge Light und die Docker-Box bestehen vorerst nebeneinander, je nach Anwendungsfall (Produktentscheid 07.10.2026): Edge Light für kleine Hardware und einfachere Anlagen, die Docker-Box für komplexere Anforderungen vor Ort, die bessere Hardware brauchen. Was Edge Light kann, misst die [Paritätsliste](docs/paritaet.md); ob die Docker-Box je auf dasselbe Programm umgestellt wird, ist offen.

## Stand: Stufe 1 (Fundament + Deye-Monitoring)

| | |
|---|---|
| **Funktioniert** | Alles, was der Go-Core heute schon kann (Kopplung, Cloud-Verbindung, Pufferung, Fahrplan, Schutzgrenzen, OCPP-Lastmanagement inkl. PV-Überschussladen, Shelly, lokale Web-App `:8484`), **plus** Deye lesen über den Solarman-Datenlogger (alle vier Gerätefamilien) und „Verbindung testen" für den Deye |
| **Noch nicht** | Alle anderen Lesewege, Wechselrichter-Steuerung (bei „Sonne + Speicher“ gibt die Box den nur gelesenen Speicher als *beobachtet* frei, `frei_beobachtet`; eine Ladungsabsenkung gibt es ohne Steuerung nicht), weitere Energiequellen, Kundenautomationen – siehe [Paritätsliste](docs/paritaet.md). Nicht unterstützte Anbindungen werden **benannt**, nie still übergangen |
| **Bewiesen** | Gemeinsame Testvektoren mit Node-RED (23 Dekodier- und 50 Protokollfälle), Integrationstest „unveränderter Core + Go-Schicht 1", MIPS-Programm unter Emulation ([Smoke-Test](test/qemu-smoke.sh)) |
| **Offen vor einem Kundeneinsatz** | Updates aus dem Portal sind gebaut ([Updates](docs/boot-und-updates.md)); offen sind der Laborbeweis P1–P11 an der Labor-Mango ([Labor](labor/README.md)) und das erste Update über das Portal auf `edge-tgjn9gd` ([Nachrüsten](docs/nachruesten.md)) – erst dann dürfen Boxen zum Kunden (Entscheid 5c, U-6) |

## Bauen und prüfen

Benötigt Go ≥ 1.24 **oder** Docker (die Skripte wählen selbst).

```bash
edge-light/scripts/test.sh          # Vektoren, Go-Tests (mit Race-Detector), MIPS-Build
edge-light/scripts/build.sh         # dist/vp-edge-light-linux-{mipsle,arm64,amd64} + .sha256
edge-light/scripts/release.sh edge-light-JJJJ.MM.N <ausgabe>  # eine Fassung: mipsle, arm64, Skriptstand, sha256sums (nur lokales Go)
edge-light/test/qemu-smoke.sh       # MIPS-Programm unter Emulation gegen simulierten Deye
edge-light/test/verbraucherregel-probe.sh  # Fahrplan-Slot und reaktive Verbraucherregel gegen simulierte Verbraucher
edge-light/test/install-probe.sh    # install.sh gegen OpenWrt im Container (nach build.sh amd64)
edge-light/test/boot-speicher-probe.sh  # Speicherpruefung des Loaders gegen OpenWrt im Container
edge-light/test/boot-update-probe.sh    # Update im Loader (Tausch, Probe, Behalten, Zurueck, Strom weg) gegen OpenWrt im Container
edge-light/labor/laborbau.sh <aus> <seq> [mipsle|amd64]  # Laborbeweis: Wegwerf-Wurzel, Labor-Fassungen P1-P11 (labor/README.md)
edge-light/labor/labor-probe.sh     # Trockenlauf des Labor-Pakets gegen OpenWrt im Container (echte Programme)
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

Das Programm läuft bei **jedem Start aus dem RAM** (`/tmp`). Im Flash liegt die **bestätigte** Fassung gepackt (~5 MB gzip), die der Loader beim Start entpackt und gegen ihre Prüfsumme prüft – so startet die Box auch nach einem Stromausfall ohne Internet. Neue Fassungen kommen signiert über das Portal (Edge-Updates); der Loader tauscht, wacht über die Probe und nimmt zurück ([Updates](docs/boot-und-updates.md)). Grenzen: [Mango-Notizen](docs/mango.md).

```bash
edge-light/scripts/build.sh mipsle
VP_LIGHT_MANIFEST=<release.json> edge-light/openwrt/install.sh root@<mango-ip>  # Vertrauens-Set, bestätigte Fassung, Dienst
ssh root@<mango-ip> /etc/init.d/vp-edge-light restart
```

Der Dropbear des Mango-Images kennt nur **RSA**-Schlüssel (kein Ed25519) – für den SSH-Zugang einen RSA-Schlüssel hinterlegen.

> ⚠ **Nicht versenden, bevor U-6 erfüllt ist:** Laborbeweis P1–P11 grün und das erste Update über das Portal auf `edge-tgjn9gd` gelungen (Entscheid 5c). Boxen mit Stufe 1 werden einmal durch den Tunnel [nachgerüstet](docs/nachruesten.md).

## Aufbau

```
edge-light/
├── README.md                  dieser Überblick
├── docs/
│   ├── uebergabe.md           Stand, Entscheidungen, Messwerte, nächste Schritte (Einstieg)
│   ├── architektur.md         ein Programm = Core + Go-Schicht 1; der lokale Bus als Vertrag
│   ├── paritaet.md            was schon in Go läuft, was fehlt, Reihenfolge
│   ├── boot-und-updates.md    RAM-Start, Updates aus dem Portal, Probe, Rückfall, die zehn Schichten
│   ├── nachruesten.md         Runbook: Boxen mit Stufe 1 durch den Tunnel nachrüsten, erstes Portal-Update
│   └── mango.md               GL.iNet Mango: Speicher, Flash, Ports, WireGuard, Pilotplan
├── gehaeuse/                  3D-gedruckte Gehäuse, je Gerät ein Ordner: Modell, Druckdateien, Druck- und Montageanleitung
│   └── glinet-gl-mt300n-v2/   Gehäuse für den GL.iNet Mango
├── labor/                     Laborbeweis P1–P11: laborbau.sh (Wegwerf-Wurzel), labor-probe.sh, Checkliste
├── openwrt/
│   ├── install.sh             Einrichtung über SSH (auch durch den WireGuard-Tunnel): Vertrauens-Set, bestätigte Fassung
│   ├── service-tunnel.sh      Wartungstunnel zum Wartungsserver aus dem Portal (WireGuard, SSH mit Fenster-Schlüsseln, Web-App im Fenster)
│   └── files/                 Loader, procd-Dienst, UCI-Konfiguration; `vp-wartung`: Abholer und Startskript der Fenster-Schlüssel, Ereignisliste der Fernwartung
├── scripts/                   build.sh, test.sh (lokales Go oder Docker); release.sh und skripte-paket.py für eine Fassung edge-light-JJJJ.MM.N (Lauf `.forgejo/workflows/edge-light-release.yaml`: Tag → Prüfen → Anhänge am Forgejo-Release; mit `EDGE_LIGHT_SIGNIEREN=true` Manifest, Signatur, Register, Programme ins Portal)
└── test/
    ├── qemu-smoke.sh          MIPS-Programm unter qemu gegen simulierten Logger
    ├── mango-labtest.sh       Start + Messung auf einem echten Mango per SSH (ohne Portal)
    ├── service-tunnel-probe.sh  service-tunnel.sh gegen OpenWrt im Container (Wechsel alt → Wartungsserver)
    └── wartung-anmeldung-probe.sh  Fenster-Schlüssel: echte SSH-Anmeldung durch einen echten Tunnel (OpenWrt 25.12, Tunnel-Dienst aus dem Repo); Protokoll der Box und Ereignisliste
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

## Gehäuse

Edge Light kann auf mehreren Geräten laufen; ein 3D-gedrucktes Gehäuse mit VoltPilot-Logo gehört zu genau einem. Die Gehäuse liegen deshalb nach Gerät geordnet unter [`gehaeuse/`](gehaeuse/README.md). Bisher: [GL.iNet Mango](gehaeuse/glinet-gl-mt300n-v2/README.md) mit fertigen Druckdateien, Druck- und Montageanleitung.
