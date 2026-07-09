# Fronius-Wechselrichter lesen (Solar API) - Referenz + Einrichtung

Fronius-Wechselrichter (GEN24, Symo, Primo, Symo Hybrid u. a.) werden über die
**lokale Fronius Solar API** (HTTP/JSON) ausgelesen - **kein Modbus**. Genau so
integriert Home Assistant Fronius: ein einziger HTTP-GET auf
`GetPowerFlowRealtimeData.fcgi` liefert PV + Netz + Last + Batterie + Ladestand
in einem Aufruf, also den kompletten kanonischen Messwertsatz von VoltPilot.

- **Kanonische, offline-getestete Decode-Quelle:**
  [`fronius/solar-api.js`](fronius/solar-api.js) (`fronius/solar-api.test.js`) -
  owns nur die Zuordnung + den Endpunktpfad, **keinen Socket-Code**. Der
  Funktionsknoten im Flow trägt eine **synchrone Kopie** von `decodePowerFlow`
  (ein Node-RED-Flow ist self-contained JSON und kann keine Repo-Datei requiren);
  `flows-sync.test.js` pinnt beide zusammen - das gleiche Prinzip wie bei Deye
  (`deye/solarman-v5.js` + `deye/deye-decode.js`).
- **Nur lesen.** Fronius bleibt per Konstruktion nur-lesend, wie Deye: es steht
  **nicht** in `inverter-control-routing.js`'s `CERTIFIED_CONTROL_FAMILIES`.
  Batteriesteuerung ist ausgeklammert (siehe unten).
- **Nur cloud-/vertragsneutral.** Die kanonischen Kanäle
  (`pv_power_kw`/`power_kw`/`load_kw`/`soc_pct`) existieren bereits - keine
  Änderung an Contract, Ingest, Rollups, Portal oder Optimierer.

## 0. Solar API in der Wechselrichter-Weboberfläche aktivieren (WICHTIG!)

Bei neuerer **GEN24-Firmware (≥ 1.14.1)** ist die Solar API **standardmäßig
AUS** und muss einmalig aktiviert werden - das ist der Fronius-Klassiker unter
den Support-Anrufen (das Pendant zur Deye-Falle "Logger-Seriennummer, nicht
Wechselrichter-Seriennummer"):

1. Weboberfläche des Wechselrichters öffnen (`http://<IP>` bzw. die
   Solar.web-App / das lokale UI).
2. **Kommunikation → Solar API** suchen und die **Solar API aktivieren**.
   (Ältere Datamanager-2.0-Geräte - Symo/Primo mit Datamanager - haben sie i. d. R.
   bereits an.)
3. Speichern; der Wechselrichter antwortet danach unter
   `/solar_api/v1/GetPowerFlowRealtimeData.fcgi`.

Ohne diesen Schritt liefert der Wechselrichter keine Daten und der Lesepfad
bleibt **idle-sicher** (Knotenstatus-Hinweis, keine Telemetrie, kein Absturz).

## 1. Host/IP finden

Die Solar API hört auf dem **lokalen Netz-Interface** des Wechselrichters:

- Im Router / DHCP-Server nach dem Fronius-Gerät suchen (Hersteller-MAC-Präfix
  **`00:03:AC`**), oder
- die IP in der Solar.web-App / im lokalen UI unter Netzwerk ablesen, oder
- eine feste IP / DHCP-Reservierung vergeben (empfohlen, damit sich die Adresse
  nicht ändert).

Kein Benutzername, kein Passwort, keine Seriennummer und keine Unit-ID nötig -
die Solar API ist im LAN unauthentifiziert (wie HA sie liest).

## 2. GEN24: selbstsigniertes HTTPS-Zertifikat

Manche **GEN24-Firmware leitet HTTP auf HTTPS mit einem selbstsignierten
Zertifikat um** (bestätigt über HAs eigenen Workaround `verify_ssl=False`,
home-assistant/core#138881). Wenn ein reiner HTTP-Lesezugriff auf so einem Gerät
fehlschlägt:

- In der Einrichtung **„Selbstsigniertes Zertifikat akzeptieren (HTTPS)"**
  (`insecure_tls`) setzen. Der Edge wählt dann `https://` und akzeptiert das
  selbstsignierte Zertifikat (`rejectUnauthorized: false`).

Auf Geräten ohne diese Umleitung bleibt `insecure_tls` **aus** (Standard) und es
wird schlicht `http://<IP>:80` verwendet.

## 3. API-Version: nur V1

`GetPowerFlowRealtimeData` ist ein **V1-Endpunkt** (GEN24 + Datamanager 2.0
Symo/Primo/Symo Hybrid). Ein reines **V0-Altgerät (Datamanager 1.0)** hat diesen
Endpunkt nicht - das ist ein bewusster **Nicht-Zielfall**: ein V0-Gerät 404t und
der Lesepfad bleibt idle-sicher (nie stiller Rückfall auf halbe Daten). Für die
seltenen V0-Altlogger ist ggf. ein separater Adapter nötig.

## 4. Feldzuordnung (Site-Objekt aus PowerFlow)

`decodePowerFlow` bildet das `Site`-Objekt (plus `Inverters["1"].SOC`) auf die
kanonischen Kanäle ab:

| VoltPilot-Kanal | Fronius-Feld | Umrechnung / Hinweis |
|---|---|---|
| `power_kw` (Netz) | `P_Grid` | W → kW. **Vorzeichen passt bereits** (+Bezug/−Einspeisung), also standardmäßig **keine** Invertierung. |
| `pv_power_kw` | `P_PV` | W → kW, ≥ 0. `null` (Wechselrichter schläft) → Feld **ausgelassen**, nie fabrizierte 0. |
| `load_kw` | **`−P_Load`** | Fronius meldet die Last **negativ** beim Verbrauch; VoltPilots `load_kw` ist nicht-negativ, also negieren (und auf ≥ 0 begrenzen). |
| `soc_pct` | `Inverters["1"].SOC` | Nur bei Hybrid mit Batterie vorhanden. Fehlend/außerhalb `(0,100]` → **ausgelassen**, nie fabrizierte 0 (dieselbe Regel wie Deye `socPlausible`). |
| Batterieleistung (nicht veröffentlicht) | `P_Akku` | Nur Kalibrierung/Gegenprobe - VoltPilot leitet `battery_kw` aus der Leistungsbilanz ab und veröffentlicht die Fronius-Zahl **nie** direkt. |
| `grid_limit_kw` (§14a) | – | In den geprüften Realtime-Endpunkten **nicht bestätigt** vorhanden; der Contract behandelt das Feld ohnehin als optional (fehlt sauber). |

### Vorzeichen sind AM GERÄT ZU PRÜFEN

Wie bei Deye („alle Skalierungen/Vorzeichen am Gerät prüfen"): die Annahmen oben
sind so umgesetzt (Netz: keine Invertierung; Last: `−P_Load`), aber vor dem
Produktivbetrieb **an einem echten Gerät verifizieren**:

- Mittags mit PV-Überschuss → Netz sollte **negativ** (Einspeisung) sein.
- Falls Bezug/Einspeisung vertauscht wirken, in der Einrichtung
  **„Netz-Vorzeichen invertieren"** (`invert_grid_sign`) setzen - der
  Ausweichschalter, standardmäßig **aus** (Fronius stimmt normalerweise).

## 5. Einrichten (Selbstverdrahtung - kein Flow-Edit)

1. Im Edge-App-Webportal (`:8484` → „Wechselrichter einrichten"): Marke
   **Fronius** wählen, IP eintragen, ggf. `insecure_tls` setzen, speichern.
2. Der Core veröffentlicht die Auswahl retained auf `edge/inverter/config`
   (`communication: "fronius_solar_api"`), siehe
   [`../INVERTER-CONFIG.md`](../INVERTER-CONFIG.md).
3. Der Node-RED-Tab **„Wechselrichter (automatisch)"** liest die Auswahl und
   fährt den Fronius-Lesepfad an: **ein** HTTP(S)-GET pro Poll auf
   `/solar_api/v1/GetPowerFlowRealtimeData.fcgi`, dekodiert die Messwerte und
   veröffentlicht sie über `vp-telemetrie` auf `edge/telemetry`. **Kein
   Flow-Edit pro Kunde.**

Ohne/bei unbekannter Auswahl bleibt der Tab idle-sicher.

## Ausgeklammert (bewusst)

- **Steuerung / Schreibpfad.** Fronius bleibt nur-lesend (nicht in
  `CERTIFIED_CONTROL_FAMILIES`). Eine spätere Steuerung würde die
  `config/timeofuse`-artigen GEN24-Endpunkte adressieren - deren Pfad Fronius über
  Firmware-Versionen schon verschoben/gebrochen hat (evcc #21472), also ein
  eigener Prüfstand-Durchgang, unabhängig von diesem Lese-Increment.
- **Fronius als zusätzliche Quelle (`fronius_solar_api`-Netz-Zähler/Erzeuger).**
  Der Multi-Source-Pfad liest heute nur `modbus_tcp`-Quellen; eine Fronius-Quelle
  wird vom Routing erkannt, ihr Einzel-Leser ist zurückgestellt (kleiner
  Folgeschritt, der dieses Decode-Modul wiederverwendet).
- **Echte, standardbasierte SunSpec-Modell-Erkennung** (größere, separate
  Fähigkeit) - Fronius unterstützt zwar Modbus/SunSpec, HA nutzt es aber bewusst
  nicht; die Solar API ist der einfachere, reichhaltigere Weg.

## Siehe auch

- [`fronius/solar-api.js`](fronius/solar-api.js) - Decode-Modul (Quelle der Wahrheit)
- [`../INVERTER-CONFIG.md`](../INVERTER-CONFIG.md) - `edge/inverter/config`-Contract
- [`DEYE.md`](DEYE.md) - das Schwestermodell (Solarman-V5), gleiche Disziplin
- Home Assistant Fronius / `pyfronius` - Referenzimplementierung
