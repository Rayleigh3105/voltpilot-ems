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
# Live-Cloud. WICHTIG: der Portal-Host ist die Portal-API portal.voltpilot.de,
# NICHT die Marketing-Seite voltpilot.de. Der Default ist inzwischen korrekt
# (portal.voltpilot.de), aber setze VP_PORTAL_BASE_URL fuer den Produktivbetrieb
# hier explizit - so ist der Cloud-Endpunkt unmissverstaendlich dokumentiert.
# (Ein falscher Host -> HTTP 404 auf den CSR-Upload; der Core loggt das mit
#  einem klaren Hinweis auf VP_PORTAL_BASE_URL.)
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
docker compose up -d --build
```

Das startet genau **`core` + `nodered`** - **kein** `edge-sim` (der Simulator hängt am Profil `sim` und bleibt hier aus).
`docker compose ps` zeigt beide Container `healthy`.

Kontrolle:

```bash
docker compose ps
docker compose logs -f core   # "vp-edge-core started" + "enrollment: generated device keypair"
```

Der Core erzeugt beim ersten Start seinen EC-P-256-Schlüssel lokal (der private Schlüssel verlässt das Gerät nie), lädt den CSR zum Portal hoch und pollt - der Pairing-Zustand steht dann auf *warte_auf_beanspruchung*.

## 4. Deye-Integration in Node-RED konfigurieren

Der Node-RED-Editor läuft LAN-only hinter Auth: **`http://<vm>:1881`** (bzw. dein `VP_NODERED_PORT`), Benutzer `voltpilot`, Passwort = `VP_NODERED_PASSWORD`.
Kunden bekommen diesen Zugang nie - das ist der VoltPilot-Service-Zugang.

1. Tab **"Deye (Vorlage)"** öffnen, Knoten **"Deye-Konfiguration"** öffnen und das Array auf deinen Wechselrichter setzen:

   ```js
   flow.set('deye_wechselrichter', [
     {
       id: 'wr1',
       ip: '192.168.1.50',    // IP deines Deye-WiFi-Loggers
       port: 48899,
       family: 'hybrid_1p',   // 'string' | 'hybrid_1p' | 'hybrid_3p' | 'micro'
       invert_grid_sign: false,
       invert_batt_sign: false,
       limit_stages: []       // nur string/micro
     }
   ]);
   ```

2. Familie unbekannt? Inject **"Familie erkennen"** auslösen (nur Hybride: der Probe entscheidet `hybrid_1p` vs `hybrid_3p`; `string`/`micro` haben keinen SoC und werden manuell gewählt).
3. Tab **"Deye (Vorlage)"** **aktivieren**, den Tab **"SunSpec (Simulator)"** **deaktivieren**, **Deploy**.
4. **Vorzeichen am Gerät kalibrieren** (mittags PV-Überschuss -> Netz negativ; erzwungenes Laden -> Batterie positiv) und `invert_grid_sign`/`invert_batt_sign` entsprechend setzen.

Alle Register, die Familien-Autoerkennung, die Wirkleistungsbegrenzung (string/micro) und die Kalibrierung im Detail: **[`nodered/DEYE.md`](nodered/DEYE.md)**.
Der lokale Bus-Kontrakt (Messwert-Payload, Einheiten/Vorzeichen, QoS/Kadenz) - falls du einen anderen Wechselrichter verdrahtest: **[`nodered/CUSTOM-INVERTER.md`](nodered/CUSTOM-INVERTER.md)**.

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

## Fehlerbilder (kurz)

- **CSR-Upload wird mit HTTP 404 abgelehnt** (Core-Log: "the portal API has no enrollment endpoint at this URL"): `VP_PORTAL_BASE_URL` zeigt auf den falschen Host (die Marketing-Seite `voltpilot.de` statt der Portal-API `portal.voltpilot.de`). Korrigieren und `docker compose up -d` erneut.
- **Pairing bleibt auf *warte_auf_beanspruchung*:** Referenz im Portal noch nicht beansprucht, oder ein Tippfehler zwischen `VP_REF` und der beanspruchten Referenz - beide müssen exakt übereinstimmen.
- **VP-Aufkleber-ID wird abgelehnt (unbekannte Referenz):** eine `VP-`-Referenz muss in der Geräte-Registry hinterlegt sein (Plattform -> Geräte-Registry). Für einen Eigenbetrieb einfach `VP_REF` leer lassen (ungegatete `edge-xxxxxx`) oder eine eigene Nicht-`VP-`-Referenz wählen.
- **Keine Telemetrie trotz "Verbunden":** Deye-Tab noch nicht aktiviert / Simulator-Tab noch aktiv, oder `ip`/`family` im *Deye-Konfiguration*-Knoten falsch - Node-RED-Debug prüfen, siehe [`nodered/DEYE.md`](nodered/DEYE.md).
- **Werte mit falschem Vorzeichen:** `invert_grid_sign`/`invert_batt_sign` kalibrieren (Abschnitt 4).

## Betrieb

- **Neustart-fest:** `restart: unless-stopped`; Identität + Puffer liegen im Volume `vp-edge-data`, die Node-RED-Verdrahtung in `vp-nodered-data`.
- **Cloud-Ausfall:** Telemetrie wird lokal gepuffert (Standard 48 h, `VP_BUFFER_HOURS`) und bei Reconnect geordnet nachgeliefert; ohne frischen Fahrplan (> 20 min) fällt der Core auf Eigenverbrauch (PV − Last) zurück.
- **Update:** `git pull && docker compose up -d --build` (die Volumes bleiben erhalten).
