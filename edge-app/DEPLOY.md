# Edge-App auf einer eigenen VM ausrollen (echter Betrieb, Live-Cloud)

Runbook: die VoltPilot Edge-App auf deiner eigenen VM / deinem eigenen Gerät (Docker) betreiben, gegen die **Live-Cloud** (`portal.voltpilot.de` / `mqtt.voltpilot.de:8883`), an einem **echten Deye-Wechselrichter** im LAN, und die Referenz selbst im Portal beanspruchen.

Kein Simulator, keine `VP_DEV_*`-Abkürzungen: das ist der echte First-Boot-Enrollment-Weg (Gerät erzeugt seinen Schlüssel lokal, lädt einen CSR hoch, pollt, bekommt sein Zertifikat, sobald du die Referenz beanspruchst).

Der allgemeine Aufbau steht in [`README.md`](README.md); dies hier ist der Deploy-Weg für den Produktivbetrieb.

## Empfohlen: der eigenständige Installer (`install.sh`)

Der schnellste, robusteste Weg ist der mitgelieferte **geführte Installer** - und er ist **eigenständig**: `install.sh` ist die **einzige Datei**, die auf dem Gerät liegen muss. Er **erzeugt seine eigene `docker-compose.yml`** (und die `.env`) und braucht **kein** Repo-Klon. Er formalisiert genau die manuellen Schritte unten (Voraussetzungen prüfen, an der Registry anmelden, `docker-compose.yml` + `.env` schreiben, Images ziehen + starten, Referenz-ID anzeigen, Anbindung verifizieren) und ist mehrfach ausführbar (idempotent), ohne je die Datenvolumes oder die Geräteidentität zu löschen:

```bash
# Nur diese eine Datei auf das Gerät kopieren (Beispiele):
curl -fsSLO https://git.tecmaxx.de/mamotec/voltpilot-ems/raw/branch/main/edge-app/install.sh
# oder: scp install.sh geraet:~/voltpilot/
chmod +x install.sh
./install.sh                     # schreibt docker-compose.yml + .env ins aktuelle Verzeichnis
```

Die **erzeugte `docker-compose.yml` nutzt ausschließlich vorgefertigte Registry-Images** (`edge-app-core` + `edge-app-nodered`, `pull_policy: always`) - **kein lokaler Build, kein Simulator**. Sie spiegelt die echten Dienste der Repo-`docker-compose.yml` exakt (Images, Env, Volumes, Ports), sodass ein gezogener Stack sich wie ein Repo-basiertes `docker compose up -d` verhält.

Der Installer startet **nur** den echten Modus (`core` + `nodered`), verlangt ein nicht-Standard Node-RED-Passwort und setzt die `VP_DEV_*`-Schalter nie. Er schreibt in das **aktuelle Verzeichnis** (dort, wo er ausgeführt wird) und überschreibt eine **handbearbeitete** `docker-compose.yml` nie ohne Rückfrage (eine selbst erzeugte wird beim Update aktualisiert). Nützliche Optionen: `./install.sh --help`, `--reconfigure` (neue `.env` **und** `docker-compose.yml`), `--force-compose` (nur die `docker-compose.yml`), `--print-compose` (die erzeugte Datei nach stdout), `--dry-run` (nur prüfen), `--non-interactive` (Werte aus der Umgebung). Danach ist nur noch der Wechselrichter zu wählen (Abschnitt 4) und die Referenz im Portal zu beanspruchen (Abschnitt 5), die der Installer am Ende anzeigt.

> **Lockstep-Hinweis (Entwickler):** Ändern sich in der Repo-`edge-app/docker-compose.yml` die echten Dienste (Image-Refs, Env-Variablen/-Defaults, Volumes, Ports), muss `generate_compose()` in `install.sh` entsprechend angepasst werden. Der Selbst-Check `edge-app/test/install-selfcheck.sh` prüft genau diese Gleichheit (`install.sh --print-compose` gegen `docker compose config` der Repo-Datei) und schlägt bei Drift fehl.

Die folgenden Abschnitte beschreiben denselben Ablauf **manuell** (Fallback bzw. zum Nachvollziehen, benötigt das Repo bzw. den `edge-app/`-Ordner).

## 0. Voraussetzungen

- **Docker + Compose-Plugin** auf der VM (`docker --version`, `docker compose version`).
- **Netzwerkzugang von der VM aus** in beide Richtungen:
  - zum **Deye-WiFi-Logger** im LAN: **UDP Port 48899** (die `deye`-CLI spricht den Logger direkt an).
  - zur **Live-Cloud** (ausgehend, keine eingehenden Ports nötig):
    - `portal.voltpilot.de:443` (HTTPS - Enrollment + Portal-API),
    - `mqtt.voltpilot.de:8883` (mTLS-MQTT - Telemetrie + Fahrplan).

Schneller Vorabtest von der VM:

```bash
curl -sS -o /dev/null -w 'portal %{http_code}\n' https://portal.voltpilot.de/
nc -z mqtt.voltpilot.de 8883 && echo 'mqtt 8883 offen'
nc -zu <deye-logger-ip> 48899 && echo 'deye-logger erreichbar'
```

## 1. Edge-App auf die VM holen

```bash
git clone https://git.tecmaxx.de/mamotec/voltpilot-ems.git
cd voltpilot-ems/edge-app
```

(Alternativ nur den Ordner `edge-app/` auf die VM kopieren - er ist eigenständig.)

## 2. `.env` anlegen

```bash
cp .env.example .env
```

Dann in `.env` mindestens diese Werte setzen:

```dotenv
# Live-Cloud. Der eingebaute Standard ist bereits https://portal.voltpilot.de;
# fuer eine eigene Umgebung hier den passenden Portal-Host eintragen.
VP_PORTAL_BASE_URL=https://portal.voltpilot.de
VP_MQTT_HOST=mqtt.voltpilot.de
VP_MQTT_PORT=8883

# Geraete-Referenz. Genau diesen Wert beanspruchst du spaeter im Portal.
# Leer lassen -> das Geraet erzeugt sich eine dauerhafte Referenz (edge-xxxxxx)
# und zeigt sie in der lokalen Webansicht (:8484). Eine VP-Aufkleber-ID
# (VP-XXXX-0001) funktioniert nur, wenn sie in der Geraete-Registry hinterlegt ist.
VP_REF=

# Node-RED-Editor-Zugang (Service-Zugang) - pro Installation aendern!
VP_NODERED_PASSWORD=<starkes-passwort>

# Batterie-Grenzen fuer die lokalen Guards (an die echte Anlage anpassen).
VP_MAX_CHARGE_KW=50
VP_MAX_DISCHARGE_KW=50
VP_SOC_MIN_PCT=5
VP_SOC_MAX_PCT=95
```

Optional, falls die Standard-Hostports (`8484` Webansicht, `1881` Node-RED-Editor) belegt sind:

```dotenv
VP_WEB_PORT=8484
VP_NODERED_PORT=1881
```

`VP_DEV_*` bleibt leer (auskommentiert). Diese Schalter sind nur für Entwicklung/E2E und dürfen auf einem echten Gerät nie gesetzt sein.

## 3. Im echten Modus hochfahren (ohne Simulator)

```bash
docker login git.tecmaxx.de   # einmalig, mit den bereitgestellten Zugangsdaten
docker compose up -d           # zieht die fertigen Registry-Images (pull_policy: always), kein lokaler Build
```

Das startet genau **`core` + `nodered`** - **kein** `edge-sim` (der Simulator hängt am Profil `sim` und bleibt hier aus).
`docker compose ps` zeigt beide Container `healthy`.

Kontrolle:

```bash
docker compose ps
docker compose logs -f core   # "vp-edge-core started" + "enrollment: generated device keypair"
```

### 3a. Ohne lokalen Build: fertige Images ziehen (empfohlen)

Die Edge-App-Images sind in der Forgejo-Registry veröffentlicht (`git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core` + `edge-app-nodered`, **Multi-Arch: `linux/amd64` + `linux/arm64`**, sodass ein Raspberry Pi automatisch die arm64-Variante zieht) - gebaut vom Workflow `.forgejo/workflows/edge-images.yaml` (auf dem amd64-Runner, arm64 per Cross-Compile) bzw. von VoltPilot gepusht. Die `docker-compose.yml` benennt genau diese Images, sodass auf der Edge-VM **kein** lokaler Build (`--build`) nötig ist - besonders auf schwacher Hardware sind gebaute Images deutlich schneller als ein `--build` (der `nodered`-Build kompiliert u. a. das Deye-CLI in einer Go-Stage).

```bash
docker login git.tecmaxx.de           # einmalig, mit den bereitgestellten Zugangsdaten
docker compose pull core nodered      # fertige Images ziehen (kein Build)
docker compose up -d                  # ohne --build starten
```

Der lokale Build (`docker compose up -d --build`) bleibt der Fallback, wenn die VM die Registry nicht erreicht oder ein Image für die Ziel-Architektur fehlt.

Der Core erzeugt beim ersten Start seinen EC-P-256-Schlüssel lokal (der private Schlüssel verlässt das Gerät nie), lädt den CSR zum Portal hoch und pollt - der Pairing-Zustand steht dann auf *warte_auf_beanspruchung*.

## 4. Wechselrichter auswählen (Selbstverdrahtung, kein Flow-Edit)

Der Wechselrichter wird **in der lokalen Webansicht ausgewählt** - Node-RED verdrahtet sich daraus selbst ("vorne auswählen, hinten ist alles verdrahtet"). Es ist **kein** Flow-Edit pro Kunde nötig.

1. Lokale Webansicht öffnen (**`http://<vm>:<VP_WEB_PORT>` → "Wechselrichter einrichten"**) und den Wechselrichter wählen: **Marke → Familie/Typ → Verbindungsdaten**.
   - **Deye:** Marke `Deye`, Familie (`string` | `hybrid_1p` | `hybrid_3p` | `micro`), Logger-**IP** und die **Datenlogger-Seriennummer** (NICHT die Wechselrichter-Seriennummer - steht z. B. im WLAN-Namen `AP_<serial>`). Transport ist fix Solarman-V5 (TCP 8899).
   - **Anderer Hersteller:** Marke `Anderer Hersteller (Modbus / SunSpec)`, Profil `sunspec`, Wechselrichter-**IP** + Unit-ID. Transport ist fix Modbus-TCP (Port 502).
2. Speichern. Der Core veröffentlicht die Auswahl retained auf `edge/inverter/config`; der immer aktive Node-RED-Tab **"Wechselrichter (automatisch)"** liest sie und fährt den passenden Leseadapter automatisch an. Die Messwerte erscheinen als Telemetrie, sobald das Gerät beansprucht + verbunden ist (Schritt 5).
3. **Deye - Vorzeichen am Gerät kalibrieren** (mittags PV-Überschuss → Netz negativ; erzwungenes Laden → Batterie positiv): stimmt das Netz-Vorzeichen nicht, in der Auswahl **"Netz-Vorzeichen invertieren"** setzen. Zeigt eine HV-Firmware die PV-Leistung um Faktor 10 zu niedrig, **Leistungsskalierung = ×10 (Dekawatt)** wählen.

Vor dem Eintragen der Deye-Seriennummer den Transport am Gerät verifizieren: `node nodered/deye/solarman-probe.js --ip <logger> --serial <n> --family <f>` auf der Edge-VM (siehe [`nodered/DEYE.md`](nodered/DEYE.md)).
Alle Register je Familie, die On-Device-Probe und die Kalibrierung im Detail: **[`nodered/DEYE.md`](nodered/DEYE.md)**.
Ein Wechselrichter ohne fertiges Profil? VoltPilot ergänzt ein Modbus-Profil (`nodered/modbus-tcp.js`) bzw. eine Deye-Familie (`nodered/deye/deye-decode.js`); der lokale Bus-Kontrakt für eine komplett eigene Verdrahtung steht in **[`nodered/CUSTOM-INVERTER.md`](nodered/CUSTOM-INVERTER.md)** (Node-RED-Editor LAN-only: `http://<vm>:1881`, Benutzer `voltpilot`, Passwort `VP_NODERED_PASSWORD` - Kunden bekommen diesen Zugang nie).

## 5. Enrollen + im Portal beanspruchen

Der Core hat seinen CSR bereits hochgeladen und pollt.
Beanspruche jetzt die Referenz selbst im Portal:

1. Portal öffnen (`https://portal.voltpilot.de`), anmelden.
2. **Geräte -> ＋ Gerät hinzufügen**.
3. **Standort** wählen und als **Referenz** genau den Wert eintragen, den die lokale Webansicht (`http://<vm>:<VP_WEB_PORT>`) groß anzeigt (dein `VP_REF`, oder die automatisch erzeugte `edge-xxxxxx`).
4. Beanspruchen.

Sobald die Referenz beansprucht ist, signiert die API den CSR mit der Geräte-CA, schreibt den Broker-ACL-Grant und **lädt die Broker-Autorisierung automatisch neu** (Prod-`api` mit `VOLTPILOT_BROKER_AUTHZ_RELOAD_ENABLED=true`), sodass der frische Grant innerhalb von Sekunden greift.
Falls die Auto-Reload-Flag in deinem Deployment aus ist, greift der Backstop: der Deploy-/Cron-Reload bzw. auf dem Cloud-Host `tools/pki/reload-broker-authz.sh` (`emqx ctl conf reload` liest die ACL-Datei nicht neu).

## 6. Verifizieren

- **Lokale Webansicht** `http://<vm>:<VP_WEB_PORT>` (Standard `:8484`): der Pairing-Zustand läuft *warte_auf_beanspruchung* -> *zertifikat_erhalten* -> **"Verbunden mit VoltPilot"**, und "Wechselrichter: verbunden" zeigt den Deye-Link.
- **Core-Logs**: `docker compose logs -f core` zeigt den mTLS-Verbindungsaufbau und die Telemetrie-Publishes.
- **Portal**: die Geräte-Zeile flippt auf **online** und zeigt echte Telemetrie (SoC/PV/Last/Leistung) aus dem Deye.

Wenn die Werte im Portal stehen, ist das Gerät produktiv angebunden.

## LAN-Logger nicht aus dem Container erreichbar? (Host-Networking)

**Symptom:** Der `deye`-Read liefert leer / läuft in den Timeout, obwohl die Logger-IP stimmt (`nc -zu <deye-logger-ip> 48899` von der VM aus klappt, aber aus dem Node-RED-Container heraus kommt nichts zurück).

**Ursache:** Ein Docker-Bridge-Container spricht viele WiFi-Logger (Deye/Solarman-Dongle, USR-Chip) über **UDP 48899** nicht zuverlässig an: das ausgehende Paket wird ge-SNAT-tet, die Antwort des Dongles kommt oft von einem **anderen Quellport** oder als **Broadcast** zurück und wird von conntrack verworfen -> der Read bleibt leer. Das ist ein bekanntes Verhalten dieser Logger, nicht ein Konfigurationsfehler in VoltPilot.

**Fix:** Node-RED auf **Host-Networking** umstellen. Dann sitzt der Container direkt auf dem LAN (kein NAT) und der UDP-Austausch mit dem Dongle klappt - der Standard-Fix für Solarman/USR-Logger. Dafür gibt es das Override `docker-compose.hostnet.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.hostnet.yml up -d
```

`core` und der Simulator bleiben unverändert; nur `nodered` wandert aufs Host-Netz. Ohne das Override läuft alles wie gehabt (Bridge).

**Caveats (wichtig):**

- **Feste Ports:** Host-Networking bindet die Hostports direkt - es gibt kein Portmapping mehr. Der Node-RED-Editor liegt danach fest auf **Host-Port `1880`** (nicht mehr `VP_NODERED_PORT`). `http://<vm>:1880`, Zugang wie gehabt (`voltpilot` / `VP_NODERED_PASSWORD`).
- **Bus über Loopback:** Auf dem Host-Netz ist der Compose-Dienstname `core` nicht mehr auflösbar. Das Override setzt deshalb `VP_CORE_HOST=127.0.0.1` und `VP_CORE_PORT=${VP_BUS_PORT:-1884}` - die vp-Knoten sprechen den lokalen Bus dann über die Host-Loopback-Freigabe des Core an (`127.0.0.1:1884 -> core:1883`). Diese Env-Variablen haben Vorrang vor der Flow-Konfiguration, du musst den Flow also nicht anfassen. Der Cloud-Weg (Enrollment/mTLS) läuft weiter über den `core`-Container und ist davon unberührt.
- **Nur Linux:** Host-Networking ist ein Linux-Feature (Kundengeräte: Raspberry Pi / Linux-VM). Auf Docker Desktop (macOS/Windows) hat `network_mode: host` keine volle Wirkung.
- **Sim-Tab:** Im Host-Netz erreicht der SunSpec-Simulator-Tab den Dienst `edge-sim` nicht mehr (der lebt im Bridge-Netz). Host-Networking ist der Weg für den **echten** LAN-Wechselrichter, nicht für den Simulator.

Prüfen, dass der Container wirklich auf dem Host-Netz ist:

```bash
docker inspect -f '{{.HostConfig.NetworkMode}}' $(docker compose -f docker-compose.yml -f docker-compose.hostnet.yml ps -q nodered)   # -> host
```

Danach wieder in Abschnitt 4 den Deye-Read testen - er sollte jetzt Werte liefern.

## Fehlerbilder (kurz)

- **Pairing bleibt auf *warte_auf_beanspruchung*:** Referenz im Portal noch nicht beansprucht, oder ein Tippfehler zwischen `VP_REF` und der beanspruchten Referenz - beide müssen exakt übereinstimmen.
- **VP-Aufkleber-ID wird abgelehnt (unbekannte Referenz):** eine `VP-`-Referenz muss in der Geräte-Registry hinterlegt sein (Plattform -> Geräte-Registry). Für einen Eigenbetrieb einfach `VP_REF` leer lassen (ungegatete `edge-xxxxxx`) oder eine eigene Nicht-`VP-`-Referenz wählen.
- **Keine Telemetrie trotz "Verbunden":** Deye-Tab noch nicht aktiviert / Simulator-Tab noch aktiv, oder `ip`/`family` im *Deye-Konfiguration*-Knoten falsch - Node-RED-Debug prüfen, siehe [`nodered/DEYE.md`](nodered/DEYE.md).
- **Deye-Read bleibt leer / Timeout trotz richtiger Logger-IP:** typischer UDP-über-NAT-Fall - Node-RED auf Host-Networking umstellen, siehe Abschnitt ["LAN-Logger nicht aus dem Container erreichbar?"](#lan-logger-nicht-aus-dem-container-erreichbar-host-networking).
- **Werte mit falschem Vorzeichen:** `invert_grid_sign`/`invert_batt_sign` kalibrieren (Abschnitt 4).

## Betrieb

- **Neustart-fest:** `restart: unless-stopped`; Identität + Puffer liegen im Volume `vp-edge-data`. Im Volume `vp-nodered-data` liegt nur der Node-RED-Laufzeitzustand - die **Flows selbst gehören zum Image** (VoltPilot-Vorlage + Selbstverdrahtung) und werden beim Start automatisch aus dem Image ins Volume nachgezogen (siehe Update).
- **Cloud-Ausfall:** Telemetrie wird lokal gepuffert (Standard 48 h, `VP_BUFFER_HOURS`) und bei Reconnect geordnet nachgeliefert; ohne frischen Fahrplan (> 20 min) fällt der Core auf Eigenverbrauch (PV − Last) zurück.
- **Update (empfohlen: `update.sh`):** ein Befehl im Deploy-Verzeichnis - `./update.sh` - hält die Compose-Datei(en) aktuell UND aktualisiert die Container, sicher:
  1. erkennt das Deploy-Modell automatisch: eine **vom Installer erzeugte** `docker-compose.yml` (Marker `# @voltpilot-edge-install:` in der ersten Zeile) wird über die `install.sh`-Vorlage neu erzeugt (eine Quelle, kein Duplikat - `update.sh` benötigt dafür `install.sh` im selben Verzeichnis); ein **Repo-Klon** (git-verwaltete `docker-compose.yml`) wird per `git pull --ff-only` aktualisiert (niemals force/stash/reset); eine **handbearbeitete** Datei wird nie ohne `--force-compose` überschrieben.
  2. bezieht ein genutztes `docker-compose.hostnet.yml` automatisch ein (erkannt am laufenden `nodered`-Container; bei gestoppten Containern `--hostnet`) und hält es aktuell.
  3. zieht die frischen Registry-Images und startet `up -d --remove-orphans` - Volumes und `.env` bleiben unberührt, die `VP_DEV_*`-Schalter werden nie gesetzt, `down -v` gibt es nicht.
  4. verifiziert danach über `GET /health` (Pairing-/Cloud-Zustand), meldet PASS/FAIL mit Diagnose-/Rollback-Hinweisen und **zeigt am Ende die Digests der laufenden Images** - genau die Zeichenketten, die ein späteres Rollback braucht (notieren!).

  Nützliche Optionen: `--help`, `--dry-run` (zeigt nur, was sich ändern würde - läuft auch ohne Docker), `--skip-pull` (nur Compose-Refresh + `up -d`), `--non-interactive`, `--force-compose`, `--hostnet`, `--print-compose`/`--print-hostnet` (Vorlagen nach stdout). Auf ein Gerät holen wie den Installer: `curl -fsSLO https://git.tecmaxx.de/mamotec/voltpilot-ems/raw/branch/main/edge-app/update.sh` (neben die vorhandene `install.sh`). Selbst-Check: `edge-app/test/update-selfcheck.sh`.
- **Image-Version festnageln / zurückrollen (Rollback in einem Befehl):** Ohne Zutun folgt ein Gerät `:latest` (jedes `up -d` zieht den neuesten Stand) - das ist der Standard und bleibt so. Für einen geprüften, wiederholbaren Stand:

  ```bash
  ./update.sh --tag <tag>          # beide Images auf einen Tag (z. B. Commit-SHA) festnageln
  ./update.sh --core-image git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:<digest> \
              --nodered-image git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-nodered@sha256:<digest>
  ./update.sh --latest             # Pin wieder lösen
  ```

  Als `<tag>` taugt jeder von `.forgejo/workflows/edge-images.yaml` veröffentlichte Tag - der Workflow pusht neben `:latest` immer auch `:<commit-sha>`, d. h. jeder gebaute Stand ist direkt anwählbar. Der Pin landet als `VP_EDGE_IMAGE_TAG` bzw. `VP_EDGE_CORE_IMAGE`/`VP_EDGE_NODERED_IMAGE` in der `.env` (das Update ersetzt **genau diese Schlüssel**, jede andere Zeile - Geheimnisse eingeschlossen - bleibt Byte für Byte erhalten, Rechte 600) und gilt damit auch für ein späteres reines `docker compose up -d`. **Vor einem Flotten-Update die aktuellen Digests notieren** (jedes `update.sh` gibt sie am Ende aus, ohne Update: `docker compose config --images` + `docker image inspect --format '{{index .RepoDigests 0}}' <image>`) - damit ist der Rollback ein Befehl statt einer Handbearbeitung pro Gerät.
- **Update (manuell, das, was `update.sh` automatisiert):** `docker compose pull core nodered && docker compose up -d` - zieht die frischen Registry-Images ohne lokalen Build; die Volumes bleiben erhalten. Hat sich zusätzlich die Compose-Datei geändert, muss sie dabei von Hand nachgezogen werden (Installer-Deployment: `./install.sh --force-compose`; Repo-Klon: `git pull --ff-only`). **Die Node-RED-Flows aktualisieren sich dabei automatisch:** das `nodered`-Image bringt seine Vorlagen (`flows.json`, `settings.js`, `vp-palette`, `node_modules`) unter einem eigenen Image-Pfad mit; ein Start-Entrypoint schreibt sie beim Hochfahren ins `vp-nodered-data`-Volume neu, sobald sich der Image-Inhalt geändert hat (per Versions-Marker abgesichert, ein unveränderter Neustart ist ein stiller No-Op). Ein manuelles Löschen des Node-RED-Volumes ist **nicht** mehr nötig. Der Core-Zustand in `vp-edge-data` (Identität, Zertifikate, Wechselrichter-Auswahl) wird nie angefasst.
- **Update (lokaler Build):** `git pull && docker compose up -d --build` - Fallback, wenn die VM die Registry nicht erreicht.
- **Einmalig für ein Gerät mit ALTEM `nodered`-Image (vor dieser Auto-Reseed-Fix):** Ein Gerät, dessen `vp-nodered-data` noch von einem Image *vor* dieser Änderung befüllt wurde, hat die alten Flows im Volume und keinen Versions-Marker mit passendem Format - der erste Start des **neuen** Images erkennt das (fehlender/anderer Marker) und schreibt die Flows automatisch neu; danach greifen alle künftigen Updates ohne Eingriff. Falls ein Gerät zuvor manuell entzerrt wurde: `docker compose down && docker volume rm voltpilot-edge_vp-nodered-data && docker compose up -d` zieht die aktuellen Image-Flows frisch (nur das Node-RED-Volume, **nie** `vp-edge-data`).
