# Edge-App auf einer eigenen VM ausrollen (echter Betrieb, Live-Cloud)

Runbook: die VoltPilot Edge-App auf deiner eigenen VM / deinem eigenen Gerät (Docker) betreiben, gegen die **Live-Cloud** (`portal.voltpilot.de` / `mqtt.voltpilot.de:8883`), an einem **echten Deye-Wechselrichter** im LAN, und die Referenz selbst im Portal beanspruchen.

Kein Simulator, keine `VP_DEV_*`-Abkürzungen: das ist der echte First-Boot-Enrollment-Weg (Gerät erzeugt seinen Schlüssel lokal, lädt einen CSR hoch, pollt, bekommt sein Zertifikat, sobald du die Referenz beanspruchst).

Der allgemeine Aufbau steht in [`README.md`](README.md); dies hier ist der Deploy-Weg für den Produktivbetrieb.

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
# Live-Cloud - der Portal-Host MUSS explizit gesetzt werden.
# (Der eingebaute Standard ist https://voltpilot.de und stimmt fuer echte
#  Geraete NICHT - immer portal.voltpilot.de eintragen.)
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

Die Edge-App-Images sind in der Forgejo-Registry veröffentlicht (`git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core` + `edge-app-nodered`, Plattform `linux/amd64`) - gebaut vom Workflow `.forgejo/workflows/edge-images.yaml` (nativ auf dem Runner) bzw. von VoltPilot gepusht. Die `docker-compose.yml` benennt genau diese Images, sodass auf der Edge-VM **kein** lokaler Build (`--build`) nötig ist - besonders auf schwacher Hardware sind gebaute Images deutlich schneller als ein `--build` (der `nodered`-Build kompiliert u. a. das Deye-CLI in einer Go-Stage).

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

- **Neustart-fest:** `restart: unless-stopped`; Identität + Puffer liegen im Volume `vp-edge-data`, die Node-RED-Verdrahtung in `vp-nodered-data`.
- **Cloud-Ausfall:** Telemetrie wird lokal gepuffert (Standard 48 h, `VP_BUFFER_HOURS`) und bei Reconnect geordnet nachgeliefert; ohne frischen Fahrplan (> 20 min) fällt der Core auf Eigenverbrauch (PV − Last) zurück.
- **Update (Pull-basiert, empfohlen):** `docker compose pull core nodered && docker compose up -d` - zieht die frischen Registry-Images ohne lokalen Build; die Volumes bleiben erhalten.
- **Update (lokaler Build):** `git pull && docker compose up -d --build` - Fallback, wenn die VM die Registry nicht erreicht.
