# Edge Light

> **Weitermachen?** Stand, Entscheidungen, Messwerte und die nächsten Schritte stehen in der [Übergabe](docs/uebergabe.md).

Die VoltPilot-Box als **ein einziges Programm** – ohne Docker, ohne Node-RED. Gebaut für kleine Router wie den GL.iNet Mango (OpenWrt, MIPS, 128 MB RAM, 16 MB Flash), läuft aber auf jedem Linux (arm64, amd64). Derselbe Kern läuft als **Edge Industrie** neben der SPS-Laufzeit auf dem WAGO PFC200 (ARMv7, [edge-industrie/](../edge-industrie/README.md)); „Edge Light“ heißt allein die Mango-Linie.

**Ziel:** Edge Light und die Docker-Box bestehen vorerst nebeneinander, je nach Anwendungsfall (Produktentscheid 07.10.2026): Edge Light für kleine Hardware und einfachere Anlagen, die Docker-Box für komplexere Anforderungen vor Ort, die bessere Hardware brauchen. Was Edge Light kann, misst die [Paritätsliste](docs/paritaet.md); ob die Docker-Box je auf dasselbe Programm umgestellt wird, ist offen.

## Stand: Stufe 1 (Fundament + Deye-Monitoring)

| | |
|---|---|
| **Funktioniert** | Alles, was der Go-Core heute schon kann (Kopplung, Cloud-Verbindung, Pufferung, Fahrplan, Schutzgrenzen, OCPP-Lastmanagement inkl. PV-Überschussladen, Shelly, lokale Web-App `:8484`), **plus** Deye lesen über den Solarman-Datenlogger (alle vier Gerätefamilien), Huawei SUN2000 + LUNA2000 über Modbus TCP, KACO Powador-Altgeräte seriell über einen RS485-zu-Ethernet-Wandler, SunSpec über Modbus TCP (KACO Powador/blueplanet TL3, Fronius Eco), generisches Modbus TCP (Registerprofil `sunspec`), Fronius über die Solar API, KOSTAL PLENTICORE BI, KACO über die App-Schnittstelle (HTTP 8484) und den NH3 über die AISWEI-Registerkarte und Shelly Pro 3EM als Netz- oder Unterzähler (auch als weitere Energiequellen, dazu ein Deye über seinen Logger) und „Verbindung testen" für alle samt Suche nach weiteren Wechselrichtern an einem Datamanager; aus dem Portal einzelne Register einmal lesen (Probe-Kanal) und schreiben (Portal und `:8484`), der Schalt-Test des Freigabe-Assistenten, Modbus-Datenspiegel mit Lernblöcken und der geräte-eigenen Exportgrenze des Deye; Zusatzmesswerte nach Katalog (Messwerte-Bibliothek), auch die Energiekarten einer WAGO-Steuerung (WAGO-Registerbild) |
| **Noch nicht** | Alle anderen Lesewege, Wechselrichter-Steuerung (bei „Sonne + Speicher“ gibt die Box den nur gelesenen Speicher als *beobachtet* frei, `frei_beobachtet`; eine Ladungsabsenkung gibt es ohne Steuerung nicht), weitere Energiequellen über die übrigen Lesewege (Fronius Solar API, KOSTAL PLENTICORE, KACO HTTP/Modbus), Kundenautomationen – siehe [Paritätsliste](docs/paritaet.md). Nicht unterstützte Anbindungen werden **benannt**, nie still übergangen |
| **Bewiesen** | Gemeinsame Testvektoren mit Node-RED (Deye 23 Dekodier- und 50 Protokollfälle, Huawei 37, KACO seriell 58, SunSpec 30 mit drei echten KACO-Rohlesungen, generisches Modbus 29 Werte-, 12 Profil- und 17 Probe-Fälle, Register schreiben 19 und Schalt-Test 11 Lauffälle, Fronius Solar API 60, KOSTAL PLENTICORE 50, KACO App-Schnittstelle 38 Decodierungen und 12 Lesezyklen, KACO NH3 32, Messwerte-Bibliothek 925 Dekodier-Signaturen, 23 Planer- und 9 Laufzeit-Abläufe, WAGO-Registerbild 13 Vertragsfälle und jeder Simulator-Fall Lesung für Lesung), Shelly-Zähler 14 Fälle mit drei echten Antworten, Integrationstests „unveränderter Core + Go-Schicht 1" (Deye, go-e, Huawei + Powador der Kundenanlage), MIPS-Programm unter Emulation ([Smoke-Test](test/qemu-smoke.sh)) |
| **Offen vor einem Kundeneinsatz** | Updates aus dem Portal sind gebaut ([Updates](docs/boot-und-updates.md)); offen sind der Laborbeweis P1–P11 an der Labor-Mango ([Labor](labor/README.md)) und das erste Update über das Portal auf `edge-tgjn9gd` ([Nachrüsten](docs/nachruesten.md)) – erst dann dürfen Boxen zum Kunden (Entscheid 5c, U-6) |

## Bauen und prüfen

Benötigt Go ≥ 1.24 **oder** Docker (die Skripte wählen selbst).

```bash
edge-light/scripts/test.sh          # Vektoren, Go-Tests (mit Race-Detector), MIPS-Build, ARMv7-Build, Loader-Abgleich Edge Industrie, Tunnel-Programm vp-wartung, Prüfregel der Schlüsselausgabe
edge-light/scripts/build.sh         # dist/vp-edge-light-linux-{mipsle,arm64,arm,amd64} + .sha256
edge-light/scripts/release.sh edge-light-JJJJ.MM.N <ausgabe>  # eine Fassung: mipsle, arm64, arm, Skriptstand, sha256sums (nur lokales Go)
edge-light/test/qemu-smoke.sh       # MIPS-Programm unter Emulation gegen simulierten Deye
edge-light/test/verbraucherregel-probe.sh  # Fahrplan-Slot und reaktive Verbraucherregel gegen simulierte Verbraucher
edge-light/test/steuerlogik-probe.sh       # Steuerlogik: Logik-Dienst baut, Box laesst mitlaufen, Herzschlag-Block logik, nichts geschaltet
edge-light/test/steuerlogik-scharf-probe.sh # Steuerlogik scharf: echte Schaltanfragen an einen gestellten Shelly, Schutz, Zurueck, Stilllegen, zweiter Herr
edge-light/test/install-probe.sh    # install.sh gegen OpenWrt im Container (nach build.sh amd64)
edge-light/test/boot-speicher-probe.sh  # Speicherpruefung des Loaders gegen OpenWrt im Container
edge-light/test/boot-update-probe.sh    # Update im Loader (Tausch, Probe, Behalten, Zurueck, Strom weg) gegen OpenWrt im Container
edge-light/test/wlan-anschluss-probe.sh # WLAN-Anschluss (Kabel oder WLAN), Einrichtungs-WLAN und Einrichtungsseite gegen OpenWrt 25.12.5 mit simuliertem Funk im Emulator (test/wlan-labor)
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

## Steuern und Prüfstand-Build

Edge Light steuert einen Deye selbst (Fernsteuerung 1100-1121 oder Zeitfenster, Rückgabe, Absturz-Wiederherstellung, Wechselrichter-Automatik) regelt Fronius-Erzeuger über SunSpec Model 123 ab (Pfad `abregelung`) und schreibt das generische SunSpec-/Modbus-Profil (Pfad `modbus`), aber nur mit **Edge-Light-Freigabe** je Gerätefamilie und Steuerpfad (`edge-app/core/internal/layer1/freigabe.go`).
Ohne Eintrag wird geprüft und gelesen, nie geschrieben, und die Rückmeldung nennt den Grund.
Der Normalweg ist eine Freigabe am Prüfstand mit dem Go-Code; der Captain kann eine Familie aber auch ohne Prüfstand freigeben, gestützt auf die Gleichheit mit dem Node-RED-Verhalten - so geschehen am 20.11.2026 für Deye `hybrid_3p` (`remote`, `tou`) und Fronius `fronius_sunspec` (`abregelung`), gegen die gemeinsamen Vektoren aus #1965/#1967. Die Prüfstand-Schritte dieser PRs bleiben vor dem ersten Feldeinsatz der jeweiligen Familie empfohlen, sind aber keine Voraussetzung mehr für den Eintrag.
Sie kommt zu allen bestehenden Toren hinzu (Not-Aus, Zertifizierung oder First-Light-Freigabe, Automatik-Zertifikate) und lockert keines.
Eine Deye-Freigabe, die mit dem Node-RED-Ausführer der Docker-Box erworben wurde, öffnet sie nicht von selbst.

Für die Sitzung am Prüfstand gibt es den Prüfstand-Build, der die Freigabe für alle Familien öffnet und beim Start laut warnt:

```bash
(cd edge-app/core && GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -tags pruefstand -o /tmp/vp-edge-light-pruefstand ./cmd/vp-edge-light)
```

Er läuft nur am Prüfgerät und wird nie ausgeliefert: `build.sh` verweigert den Tag, und `test.sh` prüft das Release-Programm.
Nach bestandenem Prüfstand trägt ein PR die Familie mit Pfad und Prüfnachweis in `freigaben` ein; für eine Freigabe ohne Prüfstand nennt der Eintrag stattdessen ehrlich den Captain, das Datum und die Gleichheitsgrundlage.

## Auf einem OpenWrt-Router (Pilot)

Das Programm läuft bei **jedem Start aus dem RAM** (`/tmp`). Im Flash liegt die **bestätigte** Fassung gepackt (~5 MB gzip), die der Loader beim Start entpackt und gegen ihre Prüfsumme prüft – so startet die Box auch nach einem Stromausfall ohne Internet. Neue Fassungen kommen signiert über das Portal (Edge-Updates); der Loader tauscht, wacht über die Probe und nimmt zurück ([Updates](docs/boot-und-updates.md)). Grenzen: [Mango-Notizen](docs/mango.md).

```bash
edge-light/scripts/build.sh mipsle
VP_LIGHT_MANIFEST=<release.json> edge-light/openwrt/install.sh root@<mango-ip>  # Vertrauens-Set, bestätigte Fassung, Dienst
ssh root@<mango-ip> /etc/init.d/vp-edge-light restart
```

Der Dropbear des Mango-Images kennt nur **RSA**-Schlüssel (kein Ed25519) – für den SSH-Zugang einen RSA-Schlüssel hinterlegen.

> ⚠ **Nicht versenden, bevor U-6 erfüllt ist:** Laborbeweis P1–P11 grün und das erste Update über das Portal auf `edge-tgjn9gd` gelungen (Entscheid 5c). Boxen mit Stufe 1 werden einmal durch den Tunnel [nachgerüstet](docs/nachruesten.md).

## Edge Industrie (WAGO PFC200)

Derselbe Kern für ARMv7 heißt Edge Industrie und hat seinen eigenen Ordner [edge-industrie/](../edge-industrie/README.md): Einrichtung, Loader, Dienst, Proben und die Handgriffe am Gerät.
Sein Loader spricht wortgleich das Update-Protokoll des Mango-Loaders; `test.sh` prüft das mit `edge-industrie/scripts/loader-abgleich.sh`.

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
├── scripts/                   build.sh, test.sh (lokales Go oder Docker; ruft den Loader-Abgleich und die Tests des Tunnel-Programms von Edge Industrie); pruefregel-abgleich.sh prüft die Prüfregel der Schlüsselausgabe im Abholer der Mango gegen die Fälle des Vertrags; release.sh und skripte-paket.py für eine Fassung edge-light-JJJJ.MM.N (Lauf `.forgejo/workflows/edge-light-release.yaml`: Tag → Prüfen → Anhänge am Forgejo-Release; mit `EDGE_LIGHT_SIGNIEREN=true` Manifest, Signatur, Register, Programme ins Portal)
└── test/
    ├── qemu-smoke.sh          MIPS-Programm unter qemu gegen simulierten Logger
    ├── mango-labtest.sh       Start + Messung auf einem echten Mango per SSH (ohne Portal)
    ├── service-tunnel-probe.sh  service-tunnel.sh gegen OpenWrt im Container (Wechsel alt → Wartungsserver)
    ├── wartung-anmeldung-probe.sh  Fenster-Schlüssel: echte SSH-Anmeldung durch einen echten Tunnel (OpenWrt 25.12, Tunnel-Dienst aus dem Repo); Protokoll der Box und Ereignisliste
    ├── wlan-anschluss-probe.sh  WLAN-Anschluss der Box (scan, messen, verbinden, kabel, Störfälle), Einrichtungs-WLAN (Fenster, Zone, Notweg) und Einrichtungsseite (Ende-zu-Ende) gegen OpenWrt mit simuliertem Funk
    └── wlan-labor/            das Labor dazu: OpenWrt 25.12.5 im Emulator v86, mac80211_hwsim, Abbilder und Pakete per hole.sh außerhalb des Repos
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
| `edge-app/core/internal/steuerplan` | Steuern des Deye: Schreibplan, Ausführer und Rückmeldung (Zwilling der Schreibseite von `nodered/inverter-control-routing.js` und der Knoten „Steuerung / Schreibplan“ und „Deye Solarman-V5 schreiben + zuruecklesen“) |
| `edge-app/core/cmd/vp-solarman-sim` | simulierter Deye-Logger für Tests (nie beim Kunden) |

## Gehäuse

Edge Light kann auf mehreren Geräten laufen; ein 3D-gedrucktes Gehäuse mit VoltPilot-Logo gehört zu genau einem. Die Gehäuse liegen deshalb nach Gerät geordnet unter [`gehaeuse/`](gehaeuse/README.md). Bisher: [GL.iNet Mango](gehaeuse/glinet-gl-mt300n-v2/README.md) mit fertigen Druckdateien, Druck- und Montageanleitung.
