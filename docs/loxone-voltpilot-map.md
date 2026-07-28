# Loxone-Anlage der VoltPilot-Standardkarte (Modbus-Datenspiegel, Geräte-ID 100)

Kopierfertige Sensor-Liste für ein Loxone-**„Modbus Server"**-Objekt gegen den
VoltPilot-Datenspiegel (siehe [`edge-app/MODBUS-SPIEGEL.md`](../edge-app/MODBUS-SPIEGEL.md)).
Die Karte ist markenunabhängig und auf **jeder** VoltPilot-Anlage identisch –
einmal angelegt, per Loxone-Config **„Als Vorlage speichern"** exportieren und
für jede weitere Anlage wiederverwenden (nur die IP ändern).

> Warum keine fertige XML-Vorlage im Repo: Das „Als Vorlage speichern"-Format
> ist nicht öffentlich dokumentiert (die Attributnamen existieren nur in von
> Loxone Config selbst erzeugten Dateien). Eine geratene XML, die beim Import
> scheitert oder Datentypen still falsch abbildet, wäre schlechter als diese
> exakte Tabelle. Die erste selbst gespeicherte Vorlage übernimmt danach die
> Rolle der Repo-XML.

## Modbus-Server-Objekt

| Eigenschaft | Wert |
|---|---|
| Adresse | `<edge-ip>` (die IP des VoltPilot-Edge-Geräts) |
| Port | `502` (bzw. `VP_MIRROR_PORT` aus der `.env`) |
| Fragmentierte Pakete | darf aktiviert bleiben |

## Analoge Sensoren (alle: Befehl **FC3 – Holding Register lesen**, Geräte-/Unit-ID **100**, Zyklus **5 s** oder größer)

| Sensor | IO-Adresse | Datentyp | Einheit | Korrektur/Formel | Hinweis |
|---|---|---|---|---|---|
| VP Karten-Magic | 0 | 16-Bit unsigniert | – | – | muss `22096` (0x5650) lesen – Verdrahtungsprüfung |
| VP Schema-Version | 1 | 16-Bit unsigniert | – | – | muss `1` lesen |
| VP Datenalter | 2 | 16-Bit unsigniert | s | – | `65535` = noch keine Daten |
| VP Qualität | 3 | 16-Bit unsigniert | – | – | 0 = ok, 1 = veraltet, 2 = keine Daten |
| PV-Leistung | 4 | 32-Bit signiert (Big-Endian) | W | ÷1000 für kW | Sentinel −2147483648 = nicht vorhanden |
| Hausverbrauch | 6 | 32-Bit signiert (Big-Endian) | W | ÷1000 für kW | Sentinel wie oben |
| Netzleistung | 8 | 32-Bit signiert (Big-Endian) | W | ÷1000 für kW | **+ Bezug / − Einspeisung** – passt direkt auf `Gpwr` des Energiemanagers |
| Batterieleistung | 10 | 32-Bit signiert (Big-Endian) | W | ÷1000 für kW; für `Spwr` **negieren** (`Spwr` erwartet negativ = Laden) | + Laden / − Entladen |
| Batterie-Ladestand | 12 | 16-Bit unsigniert | % | ÷10 | `65535` = nicht vorhanden |
| Netzlimit (§14a) | 13 | 32-Bit signiert (Big-Endian) | W | ÷1000 für kW | nur vorhanden, wenn die Anlage eines meldet |

Anmerkungen:

- **Adressen sind 0-basiert** (Register 4 = das fünfte Register). Zählt Ihre
  Loxone-Version ab 1 bzw. ab 40001, entsprechend versetzen – der
  Karten-Magic-Sensor (muss `22096` liefern) verrät sofort, ob der Versatz stimmt.
- 32-Bit-Werte sind **Big-Endian** (High-Word zuerst) – Loxones Standard für
  „32-Bit"-Datentypen.
- FC4 (Input Register) liefert dieselben Daten wie FC3.
- Die Sentinels (−2147483648 bzw. 65535) bedeuten „Messwert nicht vorhanden" –
  in der Logik ausblenden statt als 0 weiterrechnen.
- Veraltete Daten (Qualität = 1) werden weiter ausgeliefert; wer hart reagieren
  will, verknüpft die Qualität. Der **native Deye-Bereich** (Geräte-ID 1)
  antwortet bei veralteten Daten stattdessen mit „Gerät antwortet nicht" –
  Loxone zeigt den Sensor dann ungültig.
