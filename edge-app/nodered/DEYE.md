# Deye-Wechselrichter über die deye-CLI (Node-RED-Vorlage)

Operator-Anleitung für den **"Deye (Vorlage)"**-Tab in `flows.json`.
Er liest Deye-Wechselrichter (alle großen Familien) über den WiFi-Datenlogger und speist die Messwerte als `edge/telemetry` in den VoltPilot-Core - genau wie die SunSpec-Vorlage, nur über die `deye`-CLI statt Modbus-TCP.
**Konfigurationsgetrieben:** der Operator wählt die Modell-Familie pro Wechselrichter, die passende Registerkarte greift automatisch.

Die Vorlage ist **deaktiviert ausgeliefert**. VoltPilot passt sie pro Kunde an (der Kunde nie); der Editor läuft LAN-only hinter Auth (siehe `edge-app/README.md`).

> **Scope (ehrlich):** Diese Vorlage liefert **Monitoring für alle Familien** plus die **Wirkleistungsbegrenzung (string/micro, Register 0x0028)**.
> Die **Batterie-Lade-/Entladesteuerung für Hybride ist bewusst NICHT enthalten** - sie ist sicherheitskritisch und ein separater Folgeschritt (siehe [Ausgeklammert](#ausgeklammert-hybrid-batteriesteuerung)).

---

## 1. Das Werkzeug: `deye` (s10l/deye-logger-at-cmd)

Ein abhängigkeitsfreies Go-CLI, das den AT-Kommando-Modbus-Tunnel des Deye-WiFi-Loggers spricht.
Es ist **im Container gebündelt** (`/usr/local/bin/deye`, siehe [Abschnitt 6](#6-die-deye-cli-im-container)).

```
Lesen (Modbus fn 0x03):
  deye -t <logger-ip>:48899 -xmb  <REGHEX4><COUNTHEX4>
  Antwort: +ok=0103<byteCountHEX><datenHEX><crc16HEX>

Schreiben (Modbus fn 0x10):
  deye -t <logger-ip>:48899 -xmbw <REGHEX4><COUNTHEX4><VALLENHEX2><VALUEHEX>
```

- Der Logger lauscht per Default auf **Port 48899** (UDP-Assistent-Endpunkt).
- Ein Lesebefehl gibt einen zusammenhängenden Registerblock zurück; **32-Bit-Werte sind LOW-WORD-FIRST**: `wert = (reg[addr+1] << 16) + reg[addr]`.
- Beispiel (aus dem README des Tools): `+ok=01030204017B44` = Slave `01`, Funktion `03`, `02` Byte Nutzlast (`0401`), CRC `7B44`.

Der `+ok=0103`-Parser, die Registerkarten und die Skalierung liegen getestet in **[`deye/deye-decode.js`](deye/deye-decode.js)** (Node-Test: `node --test edge-app/nodered/deye/`).
Die Funktionsknoten im Flow tragen eine **Kopie** dieser Logik (ein Node-RED-Flow ist reines JSON und kann keine Repo-Datei zur Laufzeit `require`n); `deye-decode.js` ist die Quelle der Wahrheit - beide synchron halten.

---

## 2. Familien & Registerkarten

Alle Momentanleistungen sind **einzelne 16-Bit-Register (in W)**, sofern nicht als 32-Bit markiert; die Skalierung wird zu **kW (/1000)** gerechnet, PV wird bei geteilten Strings summiert.
`power_kw`-Konvention: **+ = Netzbezug / − = Einspeisung** (kalibrieren!).

> ⚠️ **Skalierung und Vorzeichen sind trianguliert** (aus sunsynk / ha-solarman / deye-controller) und **am Gerät zu verifizieren** ([Abschnitt 5](#5-vorzeichen-kalibrierung-am-geraet)).

### `string` - 3-phasig netzgekoppelt + Zähler, **ohne** Batterie (kein SoC)

| Feld | Register | Breite | Skalierung |
|---|---|---|---|
| `pv_power_kw` | `0x0050` | 32-Bit | × 0,1 → W → /1000 |
| `load_kw` | `0x00C6` | 32-Bit | × 1 → W → /1000 |
| `power_kw` (Netz) | `0x00CB` | 32-Bit, **vorzeichenbehaftet** | × 1 → W → /1000 |

Ein Leseblock: `-xmb 0050007D` (0x50..0xCC, 125 Register = Modbus-fn-0x03-Maximum).

### `hybrid_1p` - SUN-5/6/8K-SG03LP1 (low map)

| Feld | Register | Breite |
|---|---|---|
| `soc_pct` | `0x00B8` | 16-Bit (%) |
| `pv_power_kw` | `0x00BA` + `0x00BB` (PV1+PV2, Summe) | 16-Bit |
| `power_kw` (Netz) | `0x00A9` | 16-Bit, **vorzeichenbehaftet** |
| `load_kw` | `0x00B2` | 16-Bit |
| `batt` (nur Kalibrierung) | `0x00BE` | 16-Bit, **vorzeichenbehaftet** |

Ein Leseblock: `-xmb 00A90016` (0xA9..0xBE, 22 Register).

### `hybrid_3p` - SUN-5..12K-SG04LP3 / SG01HP3 (high map)

| Feld | Register (dez.) | Breite |
|---|---|---|
| `soc_pct` | `0x024C` (588) | 16-Bit (%) |
| `pv_power_kw` | `0x02A0` + `0x02A1` (672/673, Summe) | 16-Bit |
| `power_kw` (Netz) | `0x0271` (625) | 16-Bit, **vorzeichenbehaftet** |
| `load_kw` | `0x028D` (653) | 16-Bit |
| `batt` (nur Kalibrierung) | `0x024E` (590) | 16-Bit, **vorzeichenbehaftet** |

Ein Leseblock: `-xmb 024C0056` (0x24C..0x2A1, 86 Register).

### `micro` - Deye/Bosswerk-Mikrowechselrichter

Monitoring minimal; der Deliverable ist die **Wirkleistungsbegrenzung** an `0x0028` ([Abschnitt 4](#4-wirkleistungsbegrenzung-stringmicro)).
Es werden keine Messwertregister gelesen (kein Telemetrie-Block).

> **Warum ein Block statt vieler Einzel-Lesungen?** Ein Lesebefehl liefert einen zusammenhängenden Block; die Felder werden per absoluter Adresse extrahiert. Das hält die AT-Runden minimal und vermeidet gleichzeitige `deye`-Prozesse auf dem Logger.
> Falls ein Logger den 125-Register-Block der `string`-Familie ablehnt, den Leseplan im Knoten *Leseplan bauen* in zwei Blöcke teilen (`0x0050`/Länge 2 für PV und `0x00C6`/Länge 7 für Last+Netz) - die Lese-Kette ist bereits sequenziell und verträgt mehrere Blöcke.

`batt` ist **kein** Cloud-Telemetriefeld: es wird nur gelesen, um Vorzeichen zu kalibrieren und im Knotenstatus/Debug anzuzeigen. Die Cloud leitet die Batterieleistung aus der Leistungsbilanz ab (siehe `CUSTOM-INVERTER.md`).
`grid_limit_kw` (§14a-Hüllkurve) liefern diese Deye-Register nicht direkt; das Feld bleibt daher leer (optional). Wer es aus einem separaten Zähler/Register hat, ergänzt es im Decoder-Knoten.

---

## 3. Familien-Autoerkennung

Bei Hybriden lässt sich die Familie automatisch bestimmen: die Sonde vergleicht die SoC-Register **beider** Karten -
`-xmb 00B80001` (low map) vs. `-xmb 024C0001` (high map). **Genau eine** liefert einen sinnvollen Wert 0..100 → das ist die Familie.

Im Editor: den Inject **"Familie erkennen"** auslösen. Ergebnis erscheint im Debug-Fenster und im Knotenstatus, z. B. `Familie erkannt: hybrid_1p (low=55, high=304)`.
Ist das Ergebnis unklar (beide/keine sinnvoll), handelt es sich um `string`/`micro` (kein SoC) - diese Familie manuell in der Konfiguration setzen.

---

## 4. Wirkleistungsbegrenzung (string/micro)

Der bewährte Schreibpfad des Operators auf **Register `0x0028`** (aktive Leistungsbegrenzung, 0..100 %).
Klar benannte Steuerstelle im Knoten *Prozent → 0x0028-Schreibbefehl*:

- Eingang `msg.payload` = gewünschte Begrenzung in **Prozent** (0..100), wird geklammert.
- `cfg.limit_stages` (optional) rastet auf die vom Gerät akzeptierten **Stufen** (z. B. `[0, 25, 50, 75, 100]`); leer = 1-%-Schritte. Hier bildet VoltPilot seine §14a-/Kurven-Vorgabe auf die Gerätestufen ab.
- Ergebnis: `deye -t <ip>:48899 -xmbw 00280001 02 <WERTHEX4>`, z. B. 100 % → `00280001020064`.

Zum Test liegt ein Inject **"Begrenzung 100 % (Test)"** bei. Für Hybride verweigert der Knoten den Schreibbefehl bewusst (dort steuert die Batterie, siehe unten).

---

## 5. Vorzeichen-Kalibrierung (am Gerät)

Rohvorzeichen für Netz und Batterie **variieren je Firmware** (sunsynk invertiert, ha-solarman nutzt roh) - **keiner Bibliothek blind vertrauen**.
Pro Wechselrichter gibt es zwei Konfigurations-Flags mit sinnvollem Default `false`:

| Flag | Wirkt auf | Prüfung am Gerät |
|---|---|---|
| `invert_grid_sign` | `power_kw` | **Mittags mit PV-Überschuss** muss `power_kw` **negativ** (Einspeisung) sein. Ist es positiv, `invert_grid_sign: true` setzen. |
| `invert_batt_sign` | `batt` (Status/Debug) | Bei **erzwungener Ladung** muss `batt` **positiv** sein (Laden = +). Ist es negativ, `invert_batt_sign: true` setzen. |

Kontrolle im Knotenstatus des Decoders (`pv … kW, SoC … %, Batt … kW`) oder im lokalen Web-App/`GET /api/state` des Core (`last_telemetry`, live `soc_pct`/`pv_kw`/`load_kw`).
Plausibilität: nachts `pv_power_kw ≈ 0`, `load_kw ≥ 0`, SoC 0..100.

---

## 6. Die deye-CLI im Container

Der Container-Build (`edge-app/nodered/Dockerfile`) baut `deye` in einer Go-Build-Stufe aus `github.com/s10l/deye-logger-at-cmd` und kopiert das statische Binary nach `/usr/local/bin/deye`.
Unter `buildx` läuft die Go-Stufe je Zielplattform, also entsteht das richtige Arch nativ (arm64 für den Pi, amd64).
Pinnen einer Version: `--build-arg DEYE_REF=<tag-oder-commit>`.

**Offline/ohne Build-Netz:** ein Release-Binary von <https://github.com/s10l/deye-logger-at-cmd/releases> passend zur Geräte-Architektur herunterladen, nach `/usr/local/bin/deye` legen und `chmod 0755` - danach funktionieren die exec-Knoten unverändert.

Prüfen: `docker compose exec nodered deye` zeigt die Usage; ein Live-Lesetest: `docker compose exec nodered deye -t <logger-ip>:48899 -xmb 00B80001`.

**Read liefert leer / Timeout trotz richtiger Logger-IP?** Das ist fast immer der UDP-über-NAT-Fall: der Bridge-Container schickt das Paket ab, aber die Antwort des Dongles (oft von einem anderen Quellport oder als Broadcast) wird von conntrack verworfen. Gegentest: `docker compose exec nodered deye ...` bleibt leer, während `nc -zu <logger-ip> 48899` **vom Host** klappt. Fix: Node-RED auf **Host-Networking** umstellen (kein NAT, Container direkt aufs LAN) - `docker compose -f docker-compose.yml -f docker-compose.hostnet.yml up -d`; die vollständige Anleitung mit Caveats steht in [`../DEPLOY.md`](../DEPLOY.md#lan-logger-nicht-aus-dem-container-erreichbar-host-networking).

---

## 7. Aktivieren & konfigurieren

1. Editor öffnen (`http://<geraet>:1881`, Service-Zugang - siehe `edge-app/README.md`).
2. Tab **"Deye (Vorlage)"**, Knoten **"Deye-Konfiguration"** öffnen und das Array anpassen:

   ```js
   flow.set('deye_wechselrichter', [
     {
       id: 'wr1',
       ip: '192.168.1.50',    // IP des Deye-WiFi-Loggers
       port: 48899,
       family: 'hybrid_1p',   // 'string' | 'hybrid_1p' | 'hybrid_3p' | 'micro'
       invert_grid_sign: false,
       invert_batt_sign: false,
       limit_stages: []       // nur string/micro: z. B. [0, 25, 50, 75, 100]
     }
   ]);
   ```

   (Diese Form spiegelt die `config.wechselrichter`-Struktur des Operators, `type` implizit `deye`.)
   Mehrere Wechselrichter: das Array erweitern und den Tab pro Gerät duplizieren (die Lese-Kette bedient Index 0).
3. Familie unbekannt? Inject **"Familie erkennen"** auslösen (nur Hybride).
4. Diesen Tab **aktivieren**, den Tab **"SunSpec (Simulator)"** deaktivieren, **deploy**.
5. Vorzeichen am Gerät kalibrieren ([Abschnitt 5](#5-vorzeichen-kalibrierung-am-geraet)).
6. Batterie-Limits im `.env` setzen (`VP_MAX_CHARGE_KW`, `VP_MAX_DISCHARGE_KW`, `VP_SOC_*`) und `docker compose up -d`.

Struktur wie bei SunSpec: `read → vp-telemetrie`, `Link-Status → vp-status`; alles Cloud-seitige bleibt im Core.
Der Messwert-Kontrakt (Felder/Einheiten/Vorzeichen, QoS/Kadenz) steht in [`CUSTOM-INVERTER.md`](CUSTOM-INVERTER.md).

---

## Ausgeklammert: Hybrid-Batteriesteuerung

**Bewusst NICHT in dieser Vorlage** (sicherheitskritischer Folgeschritt).

Deye-Hybride haben **keinen direkten Batterie-Watt-Sollwert**. Die Steuerung erfolgt **indirekt** über den *System Work Mode* + ein *Time-of-Use-Programm* (Ziel-SoC + Watt + Netzlade-Bit) plus **maximale Lade-/Entlade-STROM-Grenzen (Ampere!)**.
Sie ist modellabhängig, und ein falscher Schreibbefehl kann die Batterie **beschädigen**.
VoltPilots kontinuierlichen `edge/setpoint` (kW, + laden / − entladen) darauf abzubilden erfordert Software-Klammern **plus Prüfung pro Gerät am Prüfstand** - das ist ein eigenes, sicherheitsgesichertes Arbeitspaket.

**TODO (recherchierte Steuerregister für den Folgeschritt - vor Nutzung pro Modell verifizieren):**

| Zweck | Register (hybrid_3p / high map) | Hinweis |
|---|---|---|
| System Work Mode / Energy pattern | `0x0F01` (3841) | Modus-Auswahl (Self-use / Time-of-use …) |
| Time-of-Use aktivieren + Wochentagsmaske | `0x0F02` (3842) | Bitmaske |
| ToU-Slot-Startzeiten | `0x0F26`… (3878+) | pro Slot |
| ToU-Slot-Leistung (Watt) | `0x0F3D`… (3901+) | pro Slot |
| ToU-Slot-Ziel-SoC (%) | `0x0F44`… (3908+) | pro Slot |
| ToU-Slot-Netzlade-Bit | `0x0F4B`… (3915+) | Grid-Charge an/aus pro Slot |
| Max. Ladestrom (A) | `0x0F09` (3849) | **Strom, nicht Leistung** |
| Max. Entladestrom (A) | `0x0F0A` (3850) | **Strom, nicht Leistung** |

> Diese Adressen sind aus öffentlichen Karten (deye-controller / sunsynk) trianguliert und variieren je Modell/Firmware. Sie dienen nur als Ausgangspunkt für das Folge-Arbeitspaket - **erst am Prüfstand pro Gerät verifizieren**, mit Klammern gegen Strom-/SoC-/Leistungsgrenzen, bevor irgendein Schreibbefehl scharf geschaltet wird.

---

## Siehe auch

- [`CUSTOM-INVERTER.md`](CUSTOM-INVERTER.md) - der lokale Bus-Kontrakt (Messwert-Payload, Einheiten/Vorzeichen, QoS/Kadenz).
- [`deye/deye-decode.js`](deye/deye-decode.js) + [`deye/deye-decode.test.js`](deye/deye-decode.test.js) - getestete Registerkarten, Parser und Decode.
- [`edge-app/README.md`](../README.md) - Edge-App-Überblick, vp-palette, "Einen neuen Kunden verdrahten".
- <https://github.com/s10l/deye-logger-at-cmd> - die `deye`-CLI.
