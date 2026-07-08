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
> nachts ≈ 0). Passt `pv_power_kw` gegen die Statusseite **~10× zu klein** oder
> klemmt `power_kw` bei ±32,7 kW, ist es die HV-Dezawatt-Skalierung → siehe
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

| Feld | Register (dez.) | Breite | Quelle |
|---|---|---|---|
| `soc_pct` | `0x024C` (588) | 16-Bit (%) | ha-solarman `deye_sg04lp3.yaml` |
| `pv_power_kw` | `0x02A0`..`0x02A3` (672-675, **Summe PV1..PV4**) | 16-Bit je | ha-solarman + Deye-Modbus-Manual |
| `power_kw` (Netz) | `0x0271` (625) | 16-Bit, **vorzeichenbehaftet** | ha-solarman ("Total Grid Power") |
| `load_kw` | `0x028D` (653) | 16-Bit | ha-solarman ("Total Load Power") |
| `batt` (nur Kalibrierung) | `0x024E` (590) | 16-Bit, **vorzeichenbehaftet** | ha-solarman ("Battery Power") |

Ein Leseblock: `-xmb 024C0058` (0x024C..0x02A3, 88 Register - deckt SoC bis PV4 ab, unter dem 125-Register-Limit).

Die **PV-Summe umfasst alle vier MPPT-Register** (BM3 nutzt 3, BM4 nutzt 4). Ein nicht bestücktes PV3/PV4 liest `0` und stört die Summe nicht.

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
> **VERIFY-on-device (offen bis zum Live-Read):**
> 1. **Netz-Vorzeichen** (`invert_grid_sign`) - firmwareabhängig; mittags per PV-Überschuss kalibrieren (siehe [Abschnitt 5](#5-vorzeichen-kalibrierung-am-gerät)).
> 2. **Skalierung auf dem HV-Gerät** (`power_scale`, Default `1`). Die Karte nutzt Watt (`scale = 1`) wie ha-solarman - so am Captain-SG01HP3 in #49 gelesen. Falls die Live-Werte auf **einem anderen** HV-Gerät gegen die Logger-Statusseite **~10× zu klein** wirken oder `power_kw` bei ±32,7 kW klemmt (int16-Sättigung), nutzt diese HV-Firmware **Dezawatt** - dann **`power_scale: 10`** in die Wechselrichter-Konfiguration setzen (kein Code-/Karten-Edit; `power_scale` multipliziert alle Leistungsfelder pv/grid/load/batt, niemals SoC).

### `micro` - Deye/Bosswerk-Mikrowechselrichter (SUN*G3)

ha-solarman `deye_2mppt.yaml` (SUN600..1600G3, 2 MPPT) und `deye_4mppt.yaml` (SUN2000G3, 4 MPPT) führen die Erzeugung als **eine** "Total AC Output Power (Active)":

| Feld | Register | Breite | Skalierung | Quelle |
|---|---|---|---|---|
| `pv_power_kw` (= AC-Ausgang) | `0x0056`/`0x0057` | 32-Bit, low-word-first | × 0,1 → W → /1000 | ha-solarman "Total AC Output Power (Active)" |

Ein Leseblock: `-xmb 00560002`. Wie beim String ist der AC-Ausgang post-inverter = Summe aller MPPTs (2 oder 4), also MPPT-Zahl-unabhängig. Kein Netz, keine Last, kein SoC.
Zusätzlich bleibt die **Wirkleistungsbegrenzung** an `0x0028` ([Abschnitt 4](#4-wirkleistungsbegrenzung-stringmicro)) der Steuerpfad.

> **Warum ein Block statt vieler Einzel-Lesungen?** Ein Lesebefehl liefert einen zusammenhängenden Block; die Felder werden per absoluter Adresse extrahiert. Das hält die AT-Runden minimal und vermeidet gleichzeitige `deye`-Prozesse auf dem Logger. Die Hybrid-Familien lesen einen 22- (`hybrid_1p`) bzw. 88-Register-Block (`hybrid_3p`), string/micro nur ein 2-Register-Paar - alle unter dem 125-Register-Maximum von Modbus fn 0x03. Die Lese-Kette ist sequenziell und verträgt bei Bedarf auch mehrere Blöcke.

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
   - **"Netz-Vorzeichen invertieren"** und **Leistungsskalierung (×10)** bleiben zunächst aus und werden bei der Kalibrierung gesetzt.
   Diese Felder sind exakt die `connection`-Parameter aus [`../INVERTER-CONFIG.md`](../INVERTER-CONFIG.md); der Transport (Solarman-V5, TCP 8899) ist pro Marke fix.
3. Familie unbekannt? Mit `solarman-probe.js --ip <logger> --serial <n> --start 0x00B8 --count 1` (low map) vs `--start 0x024C --count 1` (high map) prüfen: genau eine liefert einen sinnvollen SoC (0..100) → `hybrid_1p` vs `hybrid_3p`. `string`/`micro` haben keinen SoC und werden manuell gewählt.
4. **Vorzeichen am Gerät kalibrieren** ([Abschnitt 5](#5-vorzeichen-kalibrierung-am-geraet)): stimmt das Netz-Vorzeichen nicht, in der Auswahl "Netz-Vorzeichen invertieren" setzen; zeigt eine HV-Firmware die Leistung 10× zu niedrig, Leistungsskalierung ×10.
5. Batterie-Limits im `.env` setzen (`VP_MAX_CHARGE_KW`, `VP_MAX_DISCHARGE_KW`, `VP_SOC_*`) und `docker compose up -d`.

Die Auswahl treibt den Lesepfad `read → vp-telemetrie`, `Link-Status → vp-status`; alles Cloud-seitige bleibt im Core.
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

**Die Steuer-Abstraktion ist inzwischen GEBAUT** (`inverter-control-routing.js` `controlRoute` + Rücklesen; FC6/FC16-Schreibframes in `deye/solarman-v5.js`), aber diese Register bleiben **`bench_pending` und der Deye-Adapter nur lesend**, bis pro Modell die Prüfstand-Checkliste abgehakt ist: **[`CONTROL-BENCH.md`](CONTROL-BENCH.md)**. Erst danach kommt die Familie in die Zertifizierungs-Allowlist und Steuerung wird pro Gerät scharfgeschaltet.

---

## Siehe auch

- [`CUSTOM-INVERTER.md`](CUSTOM-INVERTER.md) - der lokale Bus-Kontrakt (Messwert-Payload, Einheiten/Vorzeichen, QoS/Kadenz).
- [`deye/solarman-v5.js`](deye/solarman-v5.js) + [`deye/solarman-v5.test.js`](deye/solarman-v5.test.js) - der getestete Solarman-V5-Rahmen + Modbus-Codec (empfohlener Transport).
- [`deye/solarman-probe.js`](deye/solarman-probe.js) - das eigenständige Hardware-Testskript (Operator, auf der Edge-VM).
- [`deye/deye-decode.js`](deye/deye-decode.js) + [`deye/deye-decode.test.js`](deye/deye-decode.test.js) - getestete Registerkarten, Parser und Decode (beide Methoden).
- [`edge-app/README.md`](../README.md) - Edge-App-Überblick, vp-palette, "Einen neuen Kunden verdrahten".
- <https://github.com/StephanJoubert/home_assistant_solarman>, <https://github.com/jmccrohan/pysolarmanv5> - die Solarman-V5-Referenzen.
- <https://github.com/s10l/deye-logger-at-cmd> - die `deye`-CLI (Fallback-Transport).
