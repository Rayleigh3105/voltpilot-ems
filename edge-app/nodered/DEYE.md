# Deye-Wechselrichter lesen (Solarman-V5) - Referenz + Kalibrierung

> **Selbstverdrahtung statt manueller Vorlage (seit Tranche 3b).**
> Deye wird jetzt aus der **Wechselrichter-Auswahl** des Kunden getrieben: der
> Kunde wählt im Edge-App-Portal Marke=Deye + Familie + Datenlogger-Daten, der
> Core veröffentlicht das retained auf `edge/inverter/config`, und der
> **immer aktive** Node-RED-Tab **"Wechselrichter (automatisch)"** liest per
> Solarman-V5 mit der gewählten `family`-Registerkarte - **kein Flow-Edit pro
> Kunde** (Contract: [`../INVERTER-CONFIG.md`](../INVERTER-CONFIG.md), Routing:
> [`inverter-routing.js`](inverter-routing.js)).
> Die frühere manuelle **"Deye (Vorlage)"**-Karte ist damit **entfallen**.
> Der Selbstverdrahtungs-Lesepfad nutzt **ausschließlich `solarman_v5`** (die
> Kommunikationsmethode ist pro Marke fix); die AT-CLI (`at_cli`) ist kein
> Flow-Pfad mehr (die `deye`-CLI bleibt im Image nur als Diagnose-Werkzeug).
>
> **Dieses Dokument bleibt die maßgebliche Referenz** für die Registerkarten je
> Familie, die On-Device-Verifikation mit `solarman-probe.js`, die
> Vorzeichen-Kalibrierung und das `power_scale`/HV-Thema - VoltPilot nutzt sie
> beim Anlegen einer Familie und beim Kalibrieren eines Geräts.
> Die Werte, die der Kunde im Portal einträgt (`ip`/`port`/`serial`/
> `mb_slave_id`/`family`/`invert_grid_sign`/`power_scale`), sind genau die
> `connection`-Felder unten.

Er liest Deye-Wechselrichter (alle großen Familien) über den WiFi-Datenlogger und speist die Messwerte als `edge/telemetry` in den VoltPilot-Core.
**Auswahlgetrieben:** der Kunde wählt die **Modell-Familie**, die passende Registerkarte greift automatisch.

Es gibt zwei Kommunikationsmethoden (Feld `communication` in der Konfiguration):

| Methode | Transport | Port | Empfehlung |
|---|---|---|---|
| **`solarman_v5`** | Modbus-RTU im **Solarman-V5-Rahmen** über **TCP** | **8899** | **Standard/empfohlen** - eine geordnete TCP-Verbindung, robust; das ist die Methode, die auch Home Assistant / pysolarmanv5 nutzen. |
| `at_cli` | AT-Kommando-Modbus-Tunnel über **UDP** (`deye`-CLI) | 48899 | Fallback - hinter NAT oft flaky (siehe [Abschnitt 6](#6-die-deye-cli-im-container)), nur wenn der Logger V5 nicht spricht. |

**Die Registerkarten und die Skalierung sind bei beiden Methoden identisch** - nur der Transport unterscheidet sich.
Quelle der Wahrheit + Offline-Tests: [`deye/deye-decode.js`](deye/deye-decode.js) (Registerkarten/Decode) und [`deye/solarman-v5.js`](deye/solarman-v5.js) (V5-Rahmen/Modbus-Codec).

Die Vorlage ist **deaktiviert ausgeliefert**. VoltPilot passt sie pro Kunde an (der Kunde nie); der Editor läuft LAN-only hinter Auth (siehe `edge-app/README.md`).

> **Scope (ehrlich):** Diese Vorlage liefert **Monitoring für alle Familien** plus die **Wirkleistungsbegrenzung (string/micro, Register 0x0028)**.
> Die **Batterie-Lade-/Entladesteuerung für Hybride ist bewusst NICHT enthalten** - sie ist sicherheitskritisch und ein separater Folgeschritt (siehe [Ausgeklammert](#ausgeklammert-hybrid-batteriesteuerung)).

---

## 0. Solarman V5 (empfohlene Methode, TCP 8899)

Deye-Wechselrichter hängen hinter einem **Solarman/Deye-WiFi-Datenlogger** (LSW3-"Stick").
Der zuverlässige, in der Community etablierte Weg, sie zu lesen, ist das **Solarman-V5-Protokoll**: ein Modbus-RTU-Frame, eingepackt in einen Solarman-V5-Rahmen, über **TCP-Port 8899** - genau das, was [StephanJoubert/home_assistant_solarman](https://github.com/StephanJoubert/home_assistant_solarman) und [pysolarmanv5](https://github.com/jmccrohan/pysolarmanv5) sprechen.
Es ersetzt die frühere AT-CLI über UDP 48899, die viele Dongles hinter NAT nur unzuverlässig beantworten (die Antwort kommt von einem anderen Quellport oder als Broadcast und wird von conntrack verworfen).

### Der V5-Rahmen

Der Codec liegt getestet in [`deye/solarman-v5.js`](deye/solarman-v5.js); der Flow-Knoten *"Solarman-V5 lesen"* trägt eine **Kopie** davon (ein Node-RED-Flow ist self-contained JSON und kann keine Repo-Datei requiren).

```
Anfrage:  A5 <len LE16> 4510 <seq LE16> <Logger-Serial LE32>
          02 0000 00000000 00000000 00000000 <Modbus-RTU> <V5-Prüfsumme> 15
Antwort:  A5 <len LE16> 1510 <seq LE16> <Logger-Serial LE32>
          <frametype> <status> <3x u32 LE> <Modbus-RTU> <V5-Prüfsumme> 15
```

- Alles im V5-Rahmen ist **little-endian**; der eingebettete **Modbus-RTU**-Frame ist big-endian und trägt seine **eigene CRC16** (Poly `0xA001`, low-byte-first).
- Die **V5-Prüfsumme** ist die Byte-Summe (mod 256) über alle Bytes **außer** Start (`0xA5`), Prüfsummen-Byte und Ende (`0x15`).
- Die **Logger-Seriennummer** wird als 32-Bit little-endian eingebettet - sie adressiert den Logger (nicht den Wechselrichter).
- Gelesen wird mit **Modbus fn 0x03** (Holding-Register); die Registerkarten pro Familie sind dieselben wie bei der AT-CLI ([Abschnitt 2](#2-familien--registerkarten)).

### Konfiguration

```js
flow.set('deye_wechselrichter', [
  {
    id: 'wr1',
    ip: '192.168.0.28',        // IP des Loggers im LAN
    communication: 'solarman_v5',
    port: 8899,                // Solarman-V5-Standardport
    serial: 2985159064,        // PFLICHT: DATALOGGER-Seriennummer (Zahl!) - NICHT die WR-Seriennummer
    mb_slave_id: 1,            // Modbus-Unit-ID (Standard 1)
    family: 'string',          // 'string' | 'hybrid_1p' | 'hybrid_3p' | 'micro'
    invert_grid_sign: false,
    invert_batt_sign: false,
    limit_stages: []
  }
]);
```

Damit der Flow-Funktionsknoten die TCP-Verbindung öffnen darf, exponiert [`settings.js`](settings.js) das Node-Built-in `net` in den `functionGlobalContext` (bereits eingerichtet - bei einem eigenen Node-RED-Setup nachziehen).

### Die Logger-Seriennummer finden (wichtig!)

`serial` ist die Nummer **des Loggers**, nicht des Wechselrichters. Verwechslung ist der häufigste Fehler.
Sie steht:

- im **WLAN-AP-Namen** des Loggers: `AP_<serial>` (z. B. `AP_2985159064` → `serial = 2985159064`),
- auf dem **Aufkleber** des Sticks ("S/N" / "Device SN", eine 10-stellige Zahl),
- auf der **Status-Seite des Loggers** im Browser (`http://<logger-ip>/`, Feld "Device serial number"),
- in der **Solarman-App** unter den Geräte-/Logger-Details.

Die **Wechselrichter**-Seriennummer (oft auf demselben Status-Screen) ist eine ANDERE Zahl und wird für V5 **nicht** verwendet.

### Auf echter Hardware testen (Operator, auf der Edge-VM)

Neben dem Node-RED-Flow gibt es ein **eigenständiges, abhängigkeitsfreies Node-Skript** [`deye/solarman-probe.js`](deye/solarman-probe.js) (nur Node-Built-ins, kein Node-RED nötig).
Es muss auf einem Rechner **im selben LAN wie der Logger** laufen (die VoltPilot-Crew erreicht den Logger nicht).
Es öffnet eine TCP-Verbindung, macht **einen** Solarman-V5-Lesevorgang mit der Seriennummer und druckt die Roh-Register **und** die decodierten Messwerte:

```bash
# FINALE LIVE-PRÜFUNG des Captain-Geräts (SG01HP3, 3-phasig HV Hybrid):
# decodiert SoC/Netz/Last/PV direkt über die hybrid_3p-Karte.
node edge-app/nodered/deye/solarman-probe.js \
  --ip 192.168.0.28 --serial 2985159064 --family hybrid_3p

# Fortlaufend (alle 5 s, Ctrl-C beendet):
node edge-app/nodered/deye/solarman-probe.js \
  --ip 192.168.0.28 --serial 2985159064 --family hybrid_3p --loop 5

# Roh-Messwertblock erkunden (0x024C..0x02A3 = SoC bis PV4):
node edge-app/nodered/deye/solarman-probe.js \
  --ip 192.168.0.28 --serial 2985159064 --start 0x0240 --count 100
```

> **Erwartung beim Live-Check (SG01HP3):** `soc_pct` 0..100, `load_kw ≥ 0`,
> `pv_power_kw` = Summe aller MPPTs (~ Wert der Logger-Statusseite "Current power",
> nachts ≈ 0). Die HV/LV-Skala erkennt der Decoder jetzt **automatisch** aus dem
> Geräteregister `0x0000` (HV → ×10), und Netz/Last werden als **32-Bit** gelesen -
> ein `power_kw`-Klemmen bei ±32,7 kW gehört damit der Vergangenheit an. Passt
> `pv_power_kw` trotz Auto-Erkennung noch gegen die Statusseite **~10× zu klein**,
> siehe die manuelle Übersteuerung im
> VERIFY-Hinweis in [Abschnitt 2, `hybrid_3p`](#hybrid_3p---3-phasige-hybride-high-map-sg04lp3-und-sg01hp3).
> Der frühere `--family string`-Lauf lieferte **Müll** (30 MW), weil er die
> Batterie-/Konfig-Register `0x0050..0x00CC` als Messwerte fehlinterpretierte -
> für dieses Gerät ist `hybrid_3p` korrekt.

Das Skript druckt jede gelesene Registeradresse mit u16-/s16-Wert und die decodierte `edge/telemetry`-Nachricht.
**Plausibilität:** PV nachts ≈ 0, `load_kw ≥ 0`, SoC 0..100, `power_kw` `+` = Netzbezug / `−` = Einspeisung.
Stimmt das Netz-Vorzeichen mittags (PV-Überschuss ⇒ sollte negativ sein) nicht, `--invert-grid` setzen bzw. `invert_grid_sign: true` in die Konfiguration.
Passen decodierte Werte gar nicht zur Familie, mit `--start/--count` die Rohregister prüfen und die Karte in [`deye/deye-decode.js`](deye/deye-decode.js) nachziehen.

> **Ehrlicher Status:** V5-Rahmen (Bauen + Parsen), Modbus-Codec und der Decode sind **offline unit-getestet** (`node --test edge-app/nodered/deye/*.test.js`, inkl. Prüfsummen-, Kurz-Frame- und Fehlerfälle) und der Flow-Knoten wurde gegen einen lokalen V5-Mock verifiziert.
> Der finale Nachweis "läuft am echten Dongle" ist der Hardware-Lauf oben - die Registerkarten/Vorzeichen sind trianguliert und **am Gerät zu bestätigen**.

---

## 1. Fallback-Transport: die `deye`-CLI (s10l/deye-logger-at-cmd)

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

Die Registerkarten stammen aus der Deye-Definitionsbibliothek von [StephanJoubert/home_assistant_solarman](https://github.com/StephanJoubert/home_assistant_solarman) - der Community-Referenz zum Lesen von Deye über einen Solarman-Logger.
Die **fünf** ha-solarman-Deye-Definitionen fallen auf **vier** unterschiedliche Karten (= Familien) zusammen:

### Modell → Familie (Auswahlhilfe)

> **Auswahl im Portal = einzelnes Modell (keine Familien-Gruppierung).** Im
> Edge-App-Webportal wählt der Kunde sein **genaues Modell** (z. B.
> `SUN-12K-SG04LP3-EU`); der Core löst es serverseitig auf die richtige Familie
> (Registerkarte) auf und veröffentlicht **beides** in `edge/inverter/config`
> (`model` + `family`). Node-RED routet weiterhin auf `family` - ein 12k-LV kann
> also nie mit einer HV-Karte gelesen werden. Die folgende Tabelle bleibt die
> maßgebliche **Modell → Familie**-Zuordnung (Pflege-Referenz); die vollständige
> Auswahlliste steht in `core/internal/inverter/inverter.go` (`deyeModels()`).

| Deye-Modelle (Beispiele) | ha-solarman-Definition | Familie | Telemetrie |
|---|---|---|---|
| **String / netzgekoppelt**, 1-2 MPPT, ohne Speicher: `SUN-4/5/6/8/10/12K-G03`, 3-phasige `-G04`-String | `deye_string.yaml` | **`string`** | `pv_power_kw` (= AC-Ausgang) |
| **Mikrowechselrichter** (Deye/Bosswerk): `SUN600/800/1000/1300/1600G3` (2 MPPT), `SUN2000G3` (4 MPPT), Bosswerk MI300-MI2000 | `deye_2mppt.yaml`, `deye_4mppt.yaml` | **`micro`** | `pv_power_kw` (= AC-Ausgang) |
| **1-phasige Hybride** (low map): `SUN-5/6/8/10/12K-SG03LP1` | `deye_hybrid.yaml` | **`hybrid_1p`** | `soc_pct`, `pv_power_kw`, `load_kw`, `power_kw`, `batt`\* |
| **3-phasige Hybride** (high map): LV `SUN-5..12K-SG04LP3` (2 MPPT), HV `SUN-29.9/30/35/40/50K-SG01HP3-EU-BM3/BM4` (3-4 MPPT) | `deye_sg04lp3.yaml` | **`hybrid_3p`** | `soc_pct`, `pv_power_kw`, `load_kw`, `power_kw`, `batt`\* |

\* `batt` (Batterieleistung) ist **kein** Cloud-Telemetriefeld - nur Kalibrier-/Statushilfe (siehe Ende von [Abschnitt 2](#micro---deyebosswerk-mikrowechselrichter)).

**String und Mikro liefern nur die Erzeugung** (AC-Ausgangsleistung des Wechselrichters) - sie haben **kein** Netz-/Last-Register (das ist ein Hybrid-Feature). Die AC-Ausgangsleistung summiert bereits **alle MPPT-Strings** (post-inverter), ist also MPPT-Zahl-unabhängig (1-4 Strings).

Alle Momentanleistungen sind **einzelne 16-Bit-Register (in W)**, sofern nicht als 32-Bit markiert; die Skalierung wird zu **kW (/1000)** gerechnet, PV wird bei geteilten Strings (Hybride) summiert.
`power_kw`-Konvention: **+ = Netzbezug / − = Einspeisung** (kalibrieren!).

> ⚠️ **Die Adressen sind autoritativ aus ha-solarman**; einzelne **Skalierungen und alle rohen Vorzeichen** sind firmwareabhängig und **am Gerät zu verifizieren** ([Abschnitt 5](#5-vorzeichen-kalibrierung-am-geraet)).

### `string` - netzgekoppelter String-Wechselrichter, **ohne** Batterie (kein SoC)

Ein String-Wechselrichter kennt nur seine **eigene AC-Ausgangsleistung** (= PV-Erzeugung). Er hat **kein** Netz-Import/Export- oder Hauslast-Register (das sind Hybrid-Features).
ha-solarman (`deye_string.yaml`) führt als Leistungs-Headline "Total Output AC Power":

| Feld | Register | Breite | Skalierung | Quelle |
|---|---|---|---|---|
| `pv_power_kw` (= AC-Ausgang) | `0x0050`/`0x0051` | 32-Bit, low-word-first | × 0,1 → W → /1000 | ha-solarman "Total Output AC Power" |

Die AC-Ausgangsleistung ist **post-inverter** und damit bereits die **Summe aller MPPT-Strings** (1-4), also MPPT-Zahl-unabhängig.
Ein Leseblock: `-xmb 00500002` (nur das AC-Ausgangs-Paar; ha-solarman liest 0x0003..0x0070 für den vollen Sensorsatz - wir brauchen nur die Erzeugung).

> Wer **je-String-DC-Detail** will: die Register `0x006D`/`0x006E` (PV1 U/I), `0x006F`/`0x0070` (PV2 U/I) usw. liefern Spannung/Strom (× 0,1); DC-Leistung = U × I je String. Für die Cloud genügt aber die AC-Erzeugungssumme oben.

### `hybrid_1p` - 1-phasige Hybride, low map (SUN-5/6/8/10/12K-SG03LP1)

Adressen **exakt** aus ha-solarman `deye_hybrid.yaml` (alle × 1 → W bzw. %):

| Feld | Register (dez.) | Breite |
|---|---|---|
| `soc_pct` | `0x00B8` (184) | 16-Bit (%) |
| `pv_power_kw` | `0x00BA` (186) + `0x00BB` (187), Summe PV1+PV2 | 16-Bit je |
| `power_kw` (Netz) | `0x00A9` (169) | 16-Bit, **vorzeichenbehaftet** |
| `load_kw` | `0x00B2` (178) | 16-Bit |
| `batt` (nur Kalibrierung) | `0x00BE` (190) | 16-Bit, **vorzeichenbehaftet** |

Ein Leseblock: `-xmb 00A90016` (0xA9..0xBE, 22 Register).

### `hybrid_3p` - 3-phasige Hybride, high map (SG04LP3 **und** SG01HP3)

Deckt zwei Baureihen mit **derselben** high-map ab:
- **SG04LP3** (LV-Batterie): `SUN-5..12K-SG04LP3`, 2 MPPT.
- **SG01HP3** (HV-Batterie): `SUN-29.9/30/35/40/50K-SG01HP3-EU-BM3/BM4`, 3-4 MPPT. **Das bestätigte Captain-Gerät** (WR-Serial `2407224048`, Logger `2985159064` @ `192.168.0.28`).

| Feld | Register (dez.) | Breite | Skala | Quelle |
|---|---|---|---|---|
| Geräte-Kennung (LV/HV) | `0x0000` (0) | 16-Bit | - | ha-solarman `deye_p3.yaml` ("Device"), `const.py` `AUTODETECTION_DEYE` |
| `soc_pct` | `0x024C` (588) | 16-Bit (%) | 1 | ha-solarman `deye_p3.yaml` |
| `pv_power_kw` | `0x02A0`..`0x02A3` (672-675, **Summe PV1..PV4**) | 16-Bit je | **`[1,10]` LV/HV** | ha-solarman + Deye-Modbus-Manual |
| `power_kw` (Netz) | `0x026B` (619, low) + `0x02C4` (708, high) - **externer CT am Hausanschluss**; Rückfall `0x0271`/`0x02B2` (625/690) | **32-Bit**, vorzeichenbehaftet | 1 (immer W) | ha-solarman ("External Power" / "Grid Power", rule 4) |
| `load_kw` | `0x028D` (653, low) + `0x0293` (659, high) | **32-Bit**, vorzeichenbehaftet | 1 (immer W) | ha-solarman ("Load Consumption Power", rule 4) |
| `batt` (nur Kalibrierung) | `0x024E` (590) | 16-Bit, vorzeichenbehaftet | **`[1,10]` LV/HV** | ha-solarman ("Battery Power") |

Zwei Leseblöcke: `-xmb 00000001` (Geräte-Kennung 0x0000) und `-xmb 024C0079` (0x024C..0x02C4, 121 Register - deckt SoC bis PV4, die 32-Bit-Last-Highwords **und** das externe CT-Paar `0x026B`/`0x02C4` ab, weiter unter dem 125-Register-Limit).

> **Warum der externe CT und nicht "Grid Power" (`0x0271`)?** `deye_p3.yaml` führt DREI Netz-Messungen: **Internal Power** `0x025F`/`0x02BF` (wechselrichterseitig), **External Power** `0x026B`/`0x02C4` (der externe CT am Netzverknüpfungspunkt) und **Grid Power** `0x0271`/`0x02B2` unter dem Kommentar *"The following three (four) registers change according to the built-in and external settings"* - ein **konfigurationsabhängiger Alias**. Live am Captain-`SUN-30K-SG01HP3` falsifiziert (2026-07-17): der Alias las **−23,7 kW** (exakt die eigene Deye-PV = der wechselrichterseitige Wert), während der wahre Export am Hausanschluss **54,2 kW** betrug (ganze Anlage inkl. ~49 kW AC-gekoppelter Fronius; das eigene Last-Register −30,5 = 23,7 − 54,2 beweist, dass der Deye intern selbst den externen CT nutzt). Der Decoder liest daher den externen CT als `power_kw`; der Alias bleibt **Rückfall** für Lesungen, die das externe Highword nicht abdecken (alter, schmalerer Block). **VERIFY-on-device bleibt:** eine Installation **ohne** externe CT-Klemmen liest hier 0 - Import/Export bei bekanntem Zustand prüfen (Vorzeichen-Kalibrierung wie gehabt).

Die **PV-Summe umfasst alle vier MPPT-Register** (BM3 nutzt 3, BM4 nutzt 4). Ein nicht bestücktes PV3/PV4 liest `0` und stört die Summe nicht.

> **HV/LV-Skalierung wird AUTOMATISCH erkannt** (wie ha-solarman). In `deye_p3.yaml` tragen **PV Power** und **Battery Power** eine doppelte `scale: [1, 10]` (LV = 1 W, HV = 10 W/Dekawatt); **Grid Power** und **Load Consumption Power** haben **keine** Skala (immer Watt). ha-solarman wählt LV vs. HV über das Geräteregister `0x0000` (`const.py` `AUTODETECTION_DEYE`: LV-Codes `0x0005`/`0x0500` → `mod 0` → Skala 1; HV-Codes `0x0006`/`0x0007`/`0x0600`/`0x0008`/`0x0601` → `mod 1` → Skala 10; `0x0008`/`0x0601` = "HV 3-Phase Inverter 20-50kw", genau die Klasse des `SUN-30K-SG01HP3-EU`). Der Decoder liest `0x0000`, mappt es auf die LV/HV-Skala und wendet sie **nur** auf PV + Batterie an - Netz/Last/SoC nie. Das Feld `power_scale` ist nur noch eine **manuelle Übersteuerung** (`1` oder `10` gewinnt gegen die Auto-Erkennung) bzw. der **Rückfall** auf `1`, wenn `0x0000` nicht lesbar ist (nie eine Klasse erfinden).

> **SoC-Plausibilität (drop-don't-fabricate).** Ein Solarman-Logger, der den
> Wechselrichter gerade **nicht** erreicht (typisch nachts), antwortet trotzdem
> mit einem **gültigen (CRC-ok) Rahmen** - meist ein Null-Block oder, bei einem
> verschobenen Frame, ein völlig überzogener Wert. Früher wurde daraus
> `soc_pct = 0` bzw. `soc_pct > 100` und die SoC-Zeitreihe zeigte 0/100-Spikes
> über der echten Kurve. Der Decoder (`deye/deye-decode.js`) **verwirft** bei
> Hybrid-Familien einen Messwert mit unplausibler SoC (nicht im Bereich `(0,100]`
> - ein echtes BMS meldet nie exakt 0) **vollständig**: es wird **kein Sample**
> veröffentlicht (nie eine 0), die Lücke zeigt der Chart als Unterbrechung.
> String/Micro haben keinen SoC und sind nicht betroffen (0 kW nachts ist echt).

> **Adressen sind autoritativ** aus StephanJoubert/home_assistant_solarman (`deye_sg04lp3.yaml`, das die SG01HP3-Nutzer laut Repo-Issue #444 ebenfalls verwenden) plus dem Deye-Modbus-Manual für PV3/PV4 (674/675).
>
> **VERIFY-on-device:**
> 1. **Netz-Vorzeichen** (`invert_grid_sign`) - firmwareabhängig; mittags per PV-Überschuss kalibrieren (siehe [Abschnitt 5](#5-vorzeichen-kalibrierung-am-gerät)).
> 2. **HV/LV-Skalierung** wird jetzt **automatisch** aus `0x0000` erkannt (siehe Kasten oben) - kein manueller Schritt mehr nötig. `power_scale` bleibt nur als **Übersteuerung**/Rückfall. Hinweis zur Historie: #49 hat die **Familien­auswahl** (`hybrid_3p` statt der falschen `string`-Karte) am Captain-Gerät bestätigt, **nicht** die Skala - die frühere Behauptung "Skala 1 am SG01HP3 in #49 gelesen" war eine Doku-Übertreibung ohne Live-Messung. Da die HV-Klasse laut ha-solarman `mod 1` = **Dekawatt (×10)** ist, wird ein SG01HP3 automatisch ×10 skaliert; nur wenn die Auto-Erkennung nicht greift (Register `0x0000` unlesbar oder Werte weiter unplausibel), lässt sich `power_scale` in der Wechselrichter-Konfiguration manuell auf `1` oder `10` stellen (multipliziert dann nur PV + Batterie, nie Netz/Last/SoC).

### `micro` - Deye/Bosswerk-Mikrowechselrichter (SUN*G3)

ha-solarman `deye_2mppt.yaml` (SUN600..1600G3, 2 MPPT) und `deye_4mppt.yaml` (SUN2000G3, 4 MPPT) führen die Erzeugung als **eine** "Total AC Output Power (Active)":

| Feld | Register | Breite | Skalierung | Quelle |
|---|---|---|---|---|
| `pv_power_kw` (= AC-Ausgang) | `0x0056`/`0x0057` | 32-Bit, low-word-first | × 0,1 → W → /1000 | ha-solarman "Total AC Output Power (Active)" |

Ein Leseblock: `-xmb 00560002`. Wie beim String ist der AC-Ausgang post-inverter = Summe aller MPPTs (2 oder 4), also MPPT-Zahl-unabhängig. Kein Netz, keine Last, kein SoC.
Zusätzlich bleibt die **Wirkleistungsbegrenzung** an `0x0028` ([Abschnitt 4](#4-wirkleistungsbegrenzung-stringmicro)) der Steuerpfad.

> **Warum wenige Blöcke statt vieler Einzel-Lesungen?** Ein Lesebefehl liefert einen zusammenhängenden Block; die Felder werden per absoluter Adresse extrahiert. Das hält die AT-Runden minimal und vermeidet gleichzeitige `deye`-Prozesse auf dem Logger. `hybrid_1p` liest einen 22-Register-Block; `hybrid_3p` liest **zwei** Blöcke (die 1-Register-Geräte­kennung `0x0000` für die LV/HV-Skala + den 103-Register-Messblock `0x024C..0x02B2`); string/micro nur ein 2-Register-Paar - alle unter dem 125-Register-Maximum von Modbus fn 0x03. Die Lese-Kette ist sequenziell und verträgt problemlos mehrere Blöcke.

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

## 7. Einrichten (Selbstverdrahtung - kein Flow-Edit)

Deye wird über die **Wechselrichter-Auswahl** im Edge-App-Portal eingerichtet; der immer aktive Tab **"Wechselrichter (automatisch)"** liest daraus per Solarman-V5. Es gibt **keine** manuelle Deye-Vorlage mehr.

1. Zuerst am Gerät verifizieren: `node deye/solarman-probe.js --ip <logger> --serial <n> --family <f>` ([Abschnitt 0](#0-solarman-v5-empfohlene-methode-tcp-8899)) - bestätigt Transport + Familie + Datenlogger-Seriennummer, bevor du sie einträgst.
2. Lokale Webansicht öffnen (`http://<geraet>:8484` → **"Wechselrichter einrichten"**) und wählen:
   - Marke **Deye**, **Familie** (`string` | `hybrid_1p` | `hybrid_3p` | `micro`),
   - Logger-**IP**, **Datenlogger-Seriennummer** (die Zahl aus der Probe - NICHT die Wechselrichter-Seriennummer), ggf. Modbus-Slave-ID,
   - **"Netz-Vorzeichen invertieren"** bleibt zunächst aus und wird bei der Kalibrierung gesetzt; **Leistungsskalierung** bleibt auf **"Automatisch"** (die LV/HV-Skala erkennt der Decoder aus dem Geräteregister `0x0000`).
   Diese Felder sind exakt die `connection`-Parameter aus [`../INVERTER-CONFIG.md`](../INVERTER-CONFIG.md); der Transport (Solarman-V5, TCP 8899) ist pro Marke fix.
3. Familie unbekannt? Mit `solarman-probe.js --ip <logger> --serial <n> --start 0x00B8 --count 1` (low map) vs `--start 0x024C --count 1` (high map) prüfen: genau eine liefert einen sinnvollen SoC (0..100) → `hybrid_1p` vs `hybrid_3p`. `string`/`micro` haben keinen SoC und werden manuell gewählt.
4. **Vorzeichen am Gerät kalibrieren** ([Abschnitt 5](#5-vorzeichen-kalibrierung-am-geraet)): stimmt das Netz-Vorzeichen nicht, in der Auswahl "Netz-Vorzeichen invertieren" setzen. Die HV/LV-Leistungsskala wird automatisch erkannt; nur falls sie nicht greift, "Leistungsskalierung" manuell auf ×10 (bzw. ×1) stellen.
5. Batterie-Limits im `.env` setzen (`VP_MAX_CHARGE_KW`, `VP_MAX_DISCHARGE_KW`, `VP_SOC_*`) und `docker compose up -d`.

Die Auswahl treibt den Lesepfad `read → vp-telemetrie`, `Link-Status → vp-status`; alles Cloud-seitige bleibt im Core.
Der Messwert-Kontrakt (Felder/Einheiten/Vorzeichen, QoS/Kadenz) steht in [`CUSTOM-INVERTER.md`](CUSTOM-INVERTER.md).

---

## Batteriesteuerung: ZWEI Pfade (Fernsteuerung bevorzugt, ToU als Rückfall)

**Sicherheitskritisch. Nichts davon schreibt live, bevor das Modell am Prüfstand freigegeben ist** ([`CONTROL-BENCH.md`](CONTROL-BENCH.md)).

Lange galt: *Deye-Hybride haben keinen direkten Batterie-Watt-Sollwert.* Das war für die **alten** Protokollstände richtig - und ist seit **Protokoll V105.1 (2023-10-06)** falsch. Deye hat einen „Customized register"-Block **1100–1121** ergänzt, der eine echte externe-EMS-Schnittstelle ist. Deshalb gibt es jetzt zwei Pfade, und der Adapter **erkennt selbst**, welcher gilt:

| | **Fernsteuerung (Remote Mode)** — Tier 2, bevorzugt | **Zeitfenster (Time-of-Use)** — Tier 3, Rückfall |
|---|---|---|
| Sollwert | **vorzeichenbehaftete Leistung**, 0,1 % der Nennleistung (≈30 W bei 30 kW) | Richtungs-Erlaubnis (Ziel-SoC) + grobe Leistungs-**Kappe** |
| Speicher | **RAM** → keine EEPROM-Abnutzung, Neuschreiben im 10-s-Takt | EEPROM → Write-on-Change, `dwell_s ≥ 900` |
| Totmann | **im Wechselrichter** (Register 1101): läuft er ab, verlässt das Gerät die Fernsteuerung von selbst | keiner - der Controller muss ihn selbst bauen |
| Rückgabe | `1100 ← 0`, oder einfach aufhören zu schreiben | aktiver Restore aus dem Snapshot |
| Installateur-Einstellungen | **werden NICHT angefasst** | Energy Pattern / Solar Sell / Max Sell Power / ToU-Slot werden verändert (und müssen zurückgesetzt werden) |
| Fremdes ToU-Programm | irrelevant | kann unseren Slot verdrängen (N2) |
| Verfügbarkeit | **firmwareabhängig** - wird erkannt | überall |

**Erkennung statt Annahme - und die Entscheidung ist STICKY (Live-Regression Pilsting 2026-07-28).** Eine Deye-Firmware hat die Fernsteuerung bei einem Nutzer schon einmal *entfernt* und ein späteres Update sie wieder gebracht. Der Executor liest deshalb (rein lesend, zwei FC3-Lesebefehle) das Identitätsregister `0x0000` **und** den Block `0x044C…0x0461` und stuft das Ergebnis ein (`classifyDeyeCapability`). Dabei gilt seit dem Neustart-Vorfall des Piloten:

- **Nur eine belastbare Antwort ist Evidenz.** Ein wohlgeformter Block mit echten Werten entscheidet (auch der bereits *gefahrene* Zustand `1101 = 60` zählt als Fernsteuerung - die Fabrik-Signatur `0xFFFF` ist keine Voraussetzung). **Definitiv „abwesend"** sind nur die eigene Registerlage einer Fernsteuerungs-losen Firmware, die ältere V105.1-Lage und die Modbus-Ausnahmen 0x01/0x02/0x03 (die die *Anfrage* beanstanden). **Transient** (erneuter Versuch nach 60 s, niemals ein Pfadwechsel) sind: Nur-Null-Antworten (der Logger-Stub für „Wechselrichter antwortet gerade nicht"), die Gateway-Ausnahmen 0x0A/0x0B und Transportfehler.
- **Der Pfad wird EINMAL entschieden und dauerhaft gemerkt** (`deye_path:<logger>` im file-Kontext; Hysterese: erst **3 aufeinanderfolgende definitive Gegenbefunde** oder ein Bedienereingriff wechseln ihn - nie ein einzelner Sondentakt). Ein gelandeter Fernsteuerungs-Schreibzyklus verankert den Pfad zusätzlich; der Kern liefert ihn als `device_certified_path` mit der First-Light-Freigabe.
- **Ein freigegebenes Gerät schreibt ToU nur BEWUSST**: auf einen definitiven Befund, per `remote_mode = Aus` oder in einem Kalibriertest. Ein Gerät, dessen Fernsteuerung nachgewiesen ist, wechselt **nie stillschweigend** auf die EEPROM-schreibende Zeitfenster-Steuerung - es hält laut an („Steuerpfad noch unbestätigt" / „wird nicht automatisch aktiviert") und nimmt die Fernsteuerung wieder auf, sobald die Prüfung antwortet.

Der aktive Pfad steht in der Rückmeldung (`control_path`) und auf der `:8484`-Karte - **nie stillschweigend ins Leere schreiben**. Operator-Hebel: `remote_mode = Aus` erzwingt den ToU-Pfad sofort und bewusst.

### Fernsteuerung: der Registerblock (1100–1121)

Quelle: Deyes eigenes *MODBUS RTU* V105.1 + [`ha-solarman` PR #978](https://github.com/davidrapan/ha-solarman/pull/978) samt Wiki. **Am Gerät des Kapitäns bewiesen** (SUN-30K-SG01HP3-EU, Live-Lesetest 2026-07-27, Logger `192.168.254.210:8899`): `1100=0x0000`, `1101=0xFFFF` (der dokumentierte „Watchdog aus"-Standard), `1104=0x0000`, `1105=0x0002`, `1121=0x0000` → **PR-#978-Lage**, der Sollwert liegt also auf **1109**.

| Dez | Hex | Rolle | Bedeutung |
|---|---|---|---|
| 1100 | `0x044C` | `remote_mode` | 0 = aus, 1 = Fernsteuerung 1 |
| 1101 | `0x044D` | `remote_watchdog` | **Totmann in Sekunden**, [10, 18000]; `0xFFFF` = aus. Läuft er ab, verlässt der Wechselrichter die Fernsteuerung selbst |
| 1104 | `0x0450` | `power_control_mode` | 0 = AC-seitig, **1 = batterieseitig**, 2 = netzseitig |
| 1105 | `0x0451` | `battery_strategy` | **2 = Leistung (Standard)**, 5 = Leistung + SoC (opt-in, `remote_battery_strategy = 5`) |
| 1108 | `0x0454` | `battery_soc_belt` | Konstant-SoC-Sollwert (die Grenze im Gerät, **nur bei Strategie 5** - im Standard NICHT geschrieben) |
| 1109 | `0x0455` | `battery_power` | **Leistungssollwert**, [-1200, 1200] in **0,1 % der Nennleistung**, **− = laden / + = entladen** |
| 1121 | `0x0461` | `remote_status` | Status (nur lesen) - unsere Beobachtung, **nie** ein Soll-Ist-Vergleich |

**Umrechnung:** `Register = −round(kW / Nennleistung_kW × 1000)`, geklemmt auf ±1200. Das Minus ist der Vorzeichenwechsel: unser Kontrakt ist `+ = laden`, das Deye-Register `− = laden`. Die **Nennleistung kommt aus dem Katalog** (`inverter.Model.RatedKw`, als `rated_kw` auf `edge/inverter/config` veröffentlicht) - **niemals hart kodiert**; ist sie unbekannt, verweigert der Adapter den Plan. Bei 30 kW ist 1 kW ≙ 33 Einheiten (≈30 W Auflösung).

**Schreibreihenfolge - tragend, der Fail-Safe zuerst, die Aktivierung zuletzt:**

| # | Register | Wert | warum an dieser Stelle |
|---|---|---|---|
| 1 | `1101` Totmann | 60 s (konfigurierbar) | **den Totmann scharf schalten, bevor sich irgendetwas bewegen kann** |
| 2 | `1104` Regelseite | 1 = batterieseitig | AC-/netzseitig würde die **PV drosseln**; batterieseitig lässt die Erzeugung unangetastet und passt zu `battery_setpoint_kw` |
| 3 | `1105` Strategie | **2 = Leistung (Standard)**; 5 nur bei `remote_battery_strategy = 5` | Standard: nur den Sollwert vorgeben, kein SoC-Ziel im Gerät |
| 4 | `1108` SoC-Grenze | **nur bei Strategie 5**: Boden beim Entladen, Decke beim Laden | die Grenze **im Gerät** - im Standard **entfällt dieser Schritt** |
| 5 | `1109` Sollwert | aus dem bereits guard-begrenzten kW | die eigentliche Anweisung |
| 6 | `1100` Fernsteuerung | 1 | **ZULETZT** - der Wechselrichter läuft nie mit halb geschriebenem Plan |

**Kadenz: `dwell_s = 0`, `min_change = 0`, `always: true`.** Das sind RAM-Register - die EEPROM-Disziplin entfällt hier vollständig, und das **Neuschreiben im normalen ~10-s-Takt IST der Totmann-Tritt** (genau das vorgesehene Muster). Würde ein unveränderter Wert übersprungen, liefe der Totmann mitten im Betrieb ab.

**Rückgabe.** Ausdrücklich: `1100 ← 0` (sofort). Implizit: **einfach aufhören zu schreiben** - der Totmann läuft ab und der Wechselrichter kehrt von selbst zurück, *ohne dass irgendetwas verstellt ist*. Das ist der Fail-Safe letzter Instanz und der Grund, warum der ToU-Snapshot/Restore **für diesen Pfad** überflüssig ist. Ein noch vorhandener ALTER ToU-Snapshot wird trotzdem zurückgeschrieben - nach dem Abschalten der Fernsteuerung.

> ### ⚠ Die SoC-Klammer ist hier sicherheitskritisch
> Ein Feldbericht (openEMS #2541) sagt: *„die im Deye konfigurierten Batterie-Grenzwerte greifen im Remote Mode offenbar nicht."* Das ist **einmal berichtet**, wird aber als harte Anforderung behandelt: **`guards.Clamp` besitzt das SoC-Band absolut** - es klemmt ein **Laden bei SoC ≥ SoC-Max auf 0** und ein **Entladen bei SoC ≤ SoC-Min auf 0**, in jedem Takt neu ausgewertet; der Adapter schreibt den bereits begrenzten Wert unverändert und weitet ihn nie.
>
> **Standard = Strategie 2 (nur Leistung), kein 1108.** Der on-device SoC-Gurt (Strategie 5 + Register 1108) ist **opt-in** (`remote_battery_strategy = 5`). Grund (Live-Gerät SUN-30K-SG01HP3-EU, 2026-07-27): mit `1108 = 5 %` und voller Batterie fuhr der Wechselrichter **auf die 5 % als ZIEL zu** und lieferte **~-8,0 kW bei befohlenen -1,0 kW** - jedes Register korrekt zurückgelesen (33 Einheiten = 1 kW von 30 kW), der Wechselrichter las 1108 als Ziel, nicht als Grenze, und unser Leistungswert war nicht die bindende Rate. Deshalb bekommt der Wechselrichter im Standard **nur** den Leistungssollwert; `guards.Clamp` bleibt die einzige SoC-Autorität. Strategie 5 bleibt zum bewussten Nachtesten verfügbar.

**Nicht auf diesem Pfad: PV-Begrenzung/Curtailment.** Die Einspeisekappe des Deye ist ein **Installateur-Register im EEPROM** (`0x00E7`); sie zu schreiben würde genau die Eigenschaft brechen, die diesen Pfad sicher macht. Ein Curtailment-Befehl wird deshalb ehrlich als nicht unterstützt gemeldet (`pvLimitSupported: false`), nie still verworfen und nie still geschrieben.

### Zeitfenster (ToU): der Rückfall

Ohne die Fernsteuerungs-Firmware bleibt die indirekte Steuerung über *Work Mode* + ein *Time-of-Use-Programm* (Ziel-SoC + Watt + Netzlade-Auswahl) plus **Lade-/Entlade-STROM-Grenzen (Ampere!)**. Sie ist modellabhängig, verändert Installateur-Einstellungen und ein falscher Schreibbefehl kann die Batterie **beschädigen** - deshalb Snapshot-and-Restore und Prüfstand pro Modell.

**Steuerregister - jetzt QUELLENBASIERT aus ha-solarman (nicht mehr trianguliert), aber weiterhin pro Modell/Firmware am Prüfstand zu bestätigen.**

Quelle: [`davidrapan/ha-solarman`](https://github.com/davidrapan/ha-solarman) (MIT), `custom_components/solarman/inverter_definitions/` - `deye_p3.yaml` (SG04LP3 LV **und** SG01HP3 HV → unsere `hybrid_3p`; dort *"Tested with 25K-SG01HP3 12K-SG04LP3"*) und `deye_hybrid.yaml` (SG0\*LP1 → `hybrid_1p`).
ha-solarman steuert **denselben Solarman-V5-WiFi-Logger** wie wir (FC6/FC16-Modbus im V5-Frame) - beweist also, dass der Logger Steuerschreibvorgänge durchreicht, und liefert die verlässlichen Adressen. Register-**Adressen/Skalen/Enums sind Fakten** und mit Quellenangabe übernommen; kein ha-solarman-**Code** wurde kopiert.

> **Korrektur (data/learnings.md 2026-07-08):** Der frühere `0x0F00`-Ansatz war FALSCH - ein Lese-Dump des SG04LP3 des Kapitäns zeigte, dass `0x0F00…` **Live-Telemetrie** hält, nicht die ToU/Work-Mode-Config. Die echten Hebel liegen im Holding-Register-Block `0x008D…0x00B1` (3p) bzw. `0x00F3…0x0117` (1p), **außerhalb** des Telemetriefensters (`0x024C…`/`0x0F00…`).

ToU-Programme sind 6 zusammenhängende Slots; VoltPilot steuert über **genau EINEN Live-Slot (Programm 1)**. Adressen je Familie (`inverter-control-routing.js` `DEYE_CONTROL_REG`):

| Zweck | Rolle | `hybrid_3p` (deye_p3) | `hybrid_1p` (deye_hybrid) | Hinweis |
|---|---|---|---|---|
| Energy Pattern | - | `0x008D` | `0x00F3` | Battery First(0) / Load First(1) |
| Work Mode | `work_mode` | `0x008E` | `0x00F4` | Export First(0) / Zero Export To Load(1) / …To CT(2) |
| Time-of-Use aktivieren + Wochentagsmaske | `tou_enable` | `0x0092` | `0x00F8` | Bit0 = Enabled; `0x00FF` = „Week" (alle Tage) |
| Programm 1..6 Startzeit (HHMM) | - | `0x0094…0x0099` | `0x00FA…0x00FF` | pro Slot |
| Programm 1..6 Leistung (W) | `battery_power` | `0x009A…0x009F` | `0x0100…0x0105` | Skala `[1,10]` (LV=1 W / HV=10 Dekawatt) via `power_scale` |
| Programm 1..6 Ziel-SoC (%) | `battery_target_soc` | `0x00A6…0x00AB` | `0x010C…0x0111` | Richtung über Ziel-SoC (laden→hoch / entladen→Boden) |
| Programm 1..6 Charging | `grid_charge_enable` | `0x00AC…0x00B1` | `0x0112…0x0117` | Enum: Disabled(0)/Grid(1)/Generator(2)/Both(3) - **EEG-gated** |
| Max. Ladestrom (A) | - | `0x006C` | `0x00D2` | **Strom, nicht Leistung** |
| Max. Entladestrom (A) | - | `0x006D` | `0x00D3` | **Strom, nicht Leistung** |
| Netz-Einspeisegrenze (W) | `pv_limit` | `0x00E7` „Grid Max Export power" (Skala 10) | `0x00F5` „Max Sell Power" (Skala 1) | Curtailment-Kappe; absent = keine Grenze |

> **String/Micro** (ohne Batterie) haben kein ToU: dort bleibt die **Wirkleistungsbegrenzung `0x0028`** ([Abschnitt 4](#4-wirkleistungsbegrenzung-stringmicro)) der einzige Steuerhebel - der Deye-Adapter plant für diese Familien NUR `pv_limit` an `0x0028`. Auf **Hybriden** war `0x0028` bislang FALSCH verdrahtet und wurde entfernt.
> **Vorzeichen/Skalen bleiben VERIFY-on-device** (`invert_control_sign`, `power_scale`), genau wie beim Lesen.

**Schreibweg = Standard-Modbus im V5-Frame.** ha-solarman schreibt mit `WRITE_SINGLE_REGISTER` (FC6) / `WRITE_MULTIPLE_REGISTERS` (FC16) - byte-identisch zu unseren `deye/solarman-v5.js`-Buildern (`writeSingleRegisterRequest`/`writeMultipleRegistersRequest`, unit-getestet). Kein Frame-Fix nötig.

**Die Steuer-Abstraktion + der Solarman-V5-Schreib-Executor sind GEBAUT und OFFLINE bewiesen** (`inverter-control-routing.js` `controlRoute`/`controlRelease` + der Node-RED-Knoten `auto-control-exec-deye` in `build-flows.js`, der über `deye/solarman-v5.js` FC6 schreibt und per FC3 zurückliest; `deye-control.e2e.test.js` fährt Schreiben→Zurücklesen→Abgleich, EEPROM-Write-on-Change und den Fail-Safe-Release gegen einen echten In-Process-Solarman-V5-Server). Der Deye-Adapter ist **un-gated** (dieselbe Zwei-Tor-Logik wie SunSpec: `writes` fließen nur bei `certified && control_enabled`), aber `hybrid_3p`/`hybrid_1p` bleiben **bewusst `bench_pending` und aus der Allowlist** (`CERTIFIED_CONTROL_FAMILIES = {sunspec}`), **egal dass `VP_CONTROL_ENABLED` jetzt standardmäßig EIN ist** - die Allowlist ist die eigentliche Geräte-Klammer, also **kein Live-Schreiben** bis die Prüfstand-Checkliste pro Modell abgehakt ist: **[`CONTROL-BENCH.md`](CONTROL-BENCH.md)**. Erst dann kommt die Familie in die Allowlist. **Dual-Controller:** eine geschriebene, aber nicht gehaltene Register-Rückmeldung wird als möglicher Konflikt („VoltPilot muss der einzige Controller sein") über den Rückleseweg sichtbar gemacht (`edge/control/readback` → `:8484`).

### Korrigierter ENTLADE-Schreibplan (report `vp-deye-tou-dir-q5` §8, `bench_pending`)

**Strategie A (Ziel-SoC-Boden + Leistungskappe + Netzladen aus) ist RICHTIG fürs LADEN, aber grundlegend UNVOLLSTÄNDIG fürs ENTLADEN.** Der ToU-Ziel-SoC ist ein Entlade-**Boden** (eine Erlaubnis), **kein Entladebefehl**, und in *Export/Selling First* lädt der Deye einen PV-Überschuss **erst in die Batterie**, bevor er einspeist - ein „Entlade auf den Boden"-Programm *erlaubt* eine Entladung, *erzwingt* sie aber nie, während der Wechselrichter stattdessen lädt (das Live-Symptom: befohlen −0,3 kW, Batterie lud +12 kW). `invert_control_sign` ist dabei ein **Ablenkungsmanöver** (§5): die Richtung wird über den Ziel-SoC kodiert, nicht über einen Vorzeichenwert; umgedreht schreibt „Entladen" ein „Laden auf 100 %", was bei voller Batterie ein stiller No-Op ist und einen Fix *vortäuschen* kann.

`deyeControl` synthetisiert deshalb eine echte Entladung mit den fehlenden Hebeln, in dieser Reihenfolge (Aktivierung STRIKT ZULETZT):

| # | Register (hybrid_3p) | Wert (Entladen) | neu? |
|---|---|---|---|
| 1 | Energy Pattern `0x008D` | **Load First (1)** - PV nicht erst in die Batterie | **NEU** |
| 2 | Work Mode `0x008E` | Export First (0) | vorhanden |
| 3 | Solar Sell `0x0091` | **AN (1)** - Export-Pfad freigeben | **NEU** |
| 4 | Programm-1-Startzeit `0x0094` | 00:00 (Basisfenster, report §6) | vorhanden |
| 5 | Programm-1-Charging `0x00AC` | Disabled (EEG-gated) | vorhanden |
| 6 | Programm-1-Ziel-SoC `0x00A6` | Boden (`soc_min`) - die Erlaubnis | vorhanden |
| 7 | **Max Sell Power `0x008F`** | **X** (der sanfte Erzwingungs-Hebel „6b") | **NEU** |
| 8 | Programm-1-Leistung `0x009A` | X (N1-skaliert) | vorhanden |
| 9 | ToU aktivieren `0x0092` | `0x00FF` - **ZULETZT** | vorhanden |

**Der schwerere „6a"-Hebel (Max-Ladestrom `0x006C` ≈ 2 A klemmen) ist BEWUSST NICHT verdrahtet** (Owner-Entscheidung); der Code ist so strukturiert, dass 6a später als Fallback ergänzt werden kann, falls der Prüfstand zeigt, dass diese Firmware 6b nicht befolgt. **LADEN** behält Strategie A plus Energy Pattern → **Battery First (0)** und stellt `Max Sell Power` aus dem Snapshot auf den Vor-Steuerungswert zurück.

**Snapshot-and-Restore (Deye hat KEINEN Revert-Timer).** Alles, was wir ändern, bleibt im EEPROM, bis wir es zurücksetzen. Der Executor liest daher **vor dem ersten Schreibbefehl** die Installateur-Werte der Register per FC3 aus (`snapshotPlan`) und speichert sie **dauerhaft** (Node-RED `contextStorage` `file`, überlebt Neustart/Re-Seed); `controlRelease` schreibt sie auf JEDER Rückgabe zurück (TTL/Abbruch/Not-Aus/Verbindungsverlust laufen im Plan-Knoten in denselben `controlRelease`; Absturz-Wiederherstellung beim Start ist ein eigener Knoten). ToU-Aktivierung wird ZULETZT zurückgesetzt; ohne Snapshot bleibt der Release wie bisher (nur `tou_enable = 0`).

**N1 (Skala) - der behobene 10×-Livefehler.** `progPower` UND `maxSellPower` nutzen `power_scale` ([1,10]; HV=10 Dekawatt). Bisher fiel eine unbestätigte Skala **still auf 1 zurück** - ein HV-SG01HP3 wurde damit **10-fach zu groß** geschrieben: aus 0,3 kW wurden 3000 W, und die mit angehobene Verkaufs-Kappe ließ die Anlage 14,6 kW ins Netz entladen. Auflösung jetzt: (1) explizites `power_scale` 1/10, sonst (2) die **aus dem Gerät erkannte** LV/HV-Klasse aus Register `0x0000` (dieselbe Auto-Erkennung wie der Lesepfad, aus der Fähigkeitsprüfung), sonst (3) **Verweigerung**: der GESAMTE ToU-Plan wird zurückgehalten (`powerScaleSuppressed`), denn ihn ohne die Leistungsregister zu schreiben wäre genauso gefährlich - ToU + Export First + Solar Sell wären dann gegen die *installateurseitige* Verkaufs-Kappe scharf. Der Executor warnt mit der konkreten Abhilfe. **Der Fernsteuerungspfad kennt `power_scale` gar nicht** - er rechnet aus der Nennleistung. **N2 (Slot-Zeit):** der Executor liest alle 6 Programm-Startzeiten und **warnt** (+ `active_slot_conflict`), wenn ein späteres Programm (2-6) „jetzt" aktiv ist und Programm 1 verdrängt - **wir schreiben Programme 2-6 NIE um**. Einmalige Inbetriebnahme (report §8.9): Programme 2-6 so setzen, dass Programm 1 der aktive Slot ist (oder das Raster auf Programm 1 = ganztags kollabieren).

**Feinregelungs-/Fallback-Register** (alle `bench_pending`, `hybrid_1p` analog): die Strom-Grenzen `0x006C`/`0x006D` (6a-Fallback) bleiben in `DEYE_CONTROL_REG` dokumentiert.

> **Prüfstand:** die Entladung ist bei 100 % SoC praktisch unbeobachtbar - die Batterie zuerst auf ≈40-70 % entladen. Vollständige Prüfstand-Prozedur: [`CONTROL-BENCH.md`](CONTROL-BENCH.md).

---

## Siehe auch

- [`CUSTOM-INVERTER.md`](CUSTOM-INVERTER.md) - der lokale Bus-Kontrakt (Messwert-Payload, Einheiten/Vorzeichen, QoS/Kadenz).
- [`deye/solarman-v5.js`](deye/solarman-v5.js) + [`deye/solarman-v5.test.js`](deye/solarman-v5.test.js) - der getestete Solarman-V5-Rahmen + Modbus-Codec (empfohlener Transport).
- [`deye/solarman-probe.js`](deye/solarman-probe.js) - das eigenständige Hardware-Testskript (Operator, auf der Edge-VM).
- [`deye/deye-decode.js`](deye/deye-decode.js) + [`deye/deye-decode.test.js`](deye/deye-decode.test.js) - getestete Registerkarten, Parser und Decode (beide Methoden).
- [`edge-app/README.md`](../README.md) - Edge-App-Überblick, vp-palette, "Einen neuen Kunden verdrahten".
- <https://github.com/StephanJoubert/home_assistant_solarman>, <https://github.com/jmccrohan/pysolarmanv5> - die Solarman-V5-Referenzen.
- <https://github.com/s10l/deye-logger-at-cmd> - die `deye`-CLI (Fallback-Transport).
