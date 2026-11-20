# Eigenes Modbus-Gerät (Vertrag)

Ein Klimagerät, eine Wärmepumpe oder ein Kühlstellenregler, Register für Register vom Fachbetrieb beschrieben (Steuerlogik-Konzept, Schritte K2 und K3, Bericht Abschnitt 15) - oder, seit E8 (Pi-Ablösung-Konzept), ein reines Selbstbau-Messgerät ganz ohne Schreibwert.
Grundsatz bei einem Gerät mit Schreibwerten: Das Gerät regelt selbst - Verdichter, Abtauung, Sicherheitskette.
VoltPilot verschiebt den Sollwert in °C innerhalb des freigegebenen Bands, wählt die Betriebsart aus der Liste, die der Fachbetrieb zugeordnet hat, schaltet frei oder aus und meldet.
Die Definition steht wie jede Selbstbau-Definition in `connection_json` der Komponente und reist im Registry-Push als `driver.connection` (`communication: modbus_baukasten`); der Block `controls` ist dabei vollständig optional - fehlt er, ist das Gerät ein reiner Sensor, genau wie eines aus der Selbstbau-Tür.
Das OHNE-Schreibwerte-Gerät nimmt diese Tür nur für eine Anlage an, deren führende Box Edge Light ist (`ModbusGeraetService.speichern`): nur dort liest der Core ein solches Gerät selbst, da Edge Light kein Node-RED für den Lese-Flow der Selbstbau-Tür hat; auf der Docker-Box bleibt „Eigenes Gerät" ([SelfBuildComponentService](../../../services/api/src/main/java/com/voltpilot/api/components/SelfBuildComponentService.java)) der richtige Weg.
Der alte einzelne Schalter (`vp.modbus.switch`, Einheitsmodell Stufe 4) ist für den Fall Ein/Aus durch einen Schreibwert vom Typ `on_off` hier bereits abgedeckt - mit Band-, Zyklen- und Störungsschutz, den der alte Schalter nicht kennt; ein generischer Sollwert in einer frei gewählten Einheit (z. B. kW, der alte Schalter kennt dort jede Einheit) bleibt offen, da dieser Vertrag nur `setpoint_c` in °C kennt (Grenzen unten).

Leser und Schreiber: API `components/ModbusGeraetDefinition` (Regeln, Fähigkeiten, Schutz), `components/ModbusGeraetService` (Routen); Box `edge-app/core/internal/modbusgeraet` (Regeln, Dekodieren, Schreibplan) und `agent/modbusgeraet.go` (Verbindung, Lesen, Schreiben).
Gemeinsame Vektoren: [modbus-geraet-vectors.json](modbus-geraet-vectors.json) (Regeln mit Ablehnungs-Codes, Registerwerte, Schreibplan, Dekodieren, Rücklesen).

## Die Definition

| Feld | Bedeutung |
|---|---|
| `transport` | `host` (nur im eigenen Netz, [lan-host-vectors](../lan-host-vectors.json)), `port` (502), `unit_id` (1) |
| `channels[]` | höchstens 16 Lesewerte: `slug`, `label`, `unit`, `register {kind, address, data_type, word_order, bit}`, `scale`, `offset`, `min_read_interval_s` (mindestens 5 s, Vorgabe 10 s), optional `signal` |
| `controls.values[]` | 0 bis 3 Schreibwerte, je Art höchstens einer: `on_off`, `setpoint_c`, `mode`; leer oder ganz ohne `controls` ist das Gerät ein reiner Sensor |
| `controls.min_change_interval_s` | Abstand zwischen zwei Änderungen von Sollwert oder Betriebsart, 10 bis 3600 s, Vorgabe 60 s |
| `controls.min_on_seconds`, `min_off_seconds` | Mindestlauf und Mindestpause des Ein/Aus, 0 bis 86400 s |
| `controls.watchdog_address`, `watchdog_value` | optional: ein Register, das die Box bei jedem Schreiben mitschreibt, damit das Gerät bei einem Ausfall der Box selbst zurückfällt |
| `controls.freigabe` | `released_at`, `released_by`, `evidence`; setzt nur der Freigabe-Weg der API, ohne sie schreibt die Box nichts |

Lesen: `holding`, `input` (Datentyp `u16`, `s16`, `u32`, `s32`, `float32`), `coil`, `discrete`, oder ein `bit` 0 bis 15 eines 16-Bit-Registers (Statusbits).
Ein Signal ist ein Wort aus der Tabelle `signal` der [Steuerlogik-Wortliste](steuerlogik-woerter.json); eine Logik liest es als `<gerät>.<signal>`.
Ja/Nein-Signale (`open`, `door_open`, `defrost`, `fault`, `running`) liegen auf einem Bit, einer Spule oder einem diskreten Eingang, alle anderen auf einem Wert; Temperaturen tragen °C, `humidity` trägt %.
Jedes Signal kommt an einem Gerät höchstens einmal vor.

Schreiben: ein Holding-Register (`u16` oder `s16`, Funktionscode 16 als Vorgabe oder 6) oder eine Spule (Funktionscode 5).
`readback` nennt ein Register (oder eine Spule) zum Zurücklesen; ohne Angabe liest die Box das Schreibregister selbst.

| Art | Felder | Ruhewert `rest` |
|---|---|---|
| `on_off` | `on_value`, `off_value` (verschieden; an einer Spule 0 und 1) | `true` oder `false` |
| `setpoint_c` | `min`, `max` (das Band), `step`, `scale`, `offset`; geschrieben wird (Wert − offset) / scale, vom Nullpunkt weg gerundet, `s16` im Zweierkomplement | °C im Band |
| `mode` | `modes`: Wort der Steuerlogik (`normal`, `boost`, `cool`, `heat`, `fan_only`, `dry`, `auto`, `start`) auf Registerwert, 1 bis 8, Werte verschieden | ein Wort aus `modes` |

Band, Ruhewert und Registerwerte müssen sich im Register darstellen lassen; die Prüfung sammelt alle Ablehnungen (Codes in den Vektoren, deutsche Sätze in der API).

## Fähigkeiten und Schutz im Registry-Push

Vor der Freigabe ist das Gerät ein Sensor: Typ `modbus-generic`, nur `measure`, `failsafe: measure-only`.
Nach der Freigabe: Typ `modbus-device` (Katalog, Freigabe je Gerät), `actuate` je Schreibwert (`setpoint_c` mit `min`, `max`, `step`; `mode` mit `modes`; je `rest`), `guards.limits.min_change_interval_s`, `min_on_seconds`/`min_off_seconds`, `failsafe: rest` ([edge-entity](edge-entity.schema.json)).

Im Arbiter der Box ([Arbitrierung](edge-desired-arbitration.md)):

- `setpoint_c` wird auf den Schritt gerundet (ab `min`, halbe Schritte nach oben) und auf das Band begrenzt (Stufe `guard:setpoint_band`); ohne vollständiges Band gibt es keinen Befehl.
- Eine Betriebsart außerhalb von `modes` fällt weg.
- Ein Halter besitzt das ganze Gerät: was er nicht nennt, bekommt den Ruhewert, damit die Box genau das schreibt, was die Wächter gesehen haben.
- Der Abstand zwischen zwei Änderungen von Sollwert oder Betriebsart hält eine zu frühe Änderung beim vorigen Wert (Stufe `guard:change_interval`), auch für die Ruhewerte; der erste Wert wird nie gehalten.
- Ein/Aus läuft durch den vorhandenen Zyklus-Wächter (Mindestlauf, Mindestpause).
- Ohne Wunsch gelten die Ruhewerte (`failsafe: rest`).

## Was die Box tut

Ein Gerät dieser Tür gehört ganz dem Core, auf beiden Box-Arten für ein Gerät mit `controls`, nur auf Edge Light auch ohne `controls`; für ein solches Gerät gibt es keinen Node-RED-Flow, die API zieht einen vorhandenen Leseplan zurück.
Fähigkeit: `modbus_geraet` ([supports](edge-supports.md)); die API nimmt eine Definition mit `controls` für jede Box an, die diese Fähigkeit meldet, eine Definition ohne `controls` nur für eine, die zusätzlich Edge Light ist (`ModbusGeraetService.speichern`, `UpdateStatusRepository.boxArt`) - die Docker-Box liest ein solches Gerät weiterhin über die Selbstbau-Tür.

- **Eine Verbindung**: jedes Lesen und Schreiben, auch der Schalt-Test, läuft nacheinander über dieselbe Verbindung; die LAN-Regel prüft die Box beim Öffnen noch einmal.
- **Lesen**: jeder Kanal in seinem Abstand, die Rücklesung der Schreibwerte alle 5 s; die Kanäle gehen als Entitäts-Telemetrie hinaus (`edge/entities/{id}/telemetry`, wie `vp.modbus.read`), die Signale sind Eingänge der [Steuerlogik](steuerlogik.md), die Rücklesung ist der beobachtete Stand (`gerät.setpoint`, `gerät.mode`, „ist“ im Herzschlag-Block `logik`).
- **Schreiben**: aus dem gewährten Befehl des Arbiters je Schreibwert ein Registerwert (noch einmal geklemmt, der Executor glaubt seiner Eingabe nichts); bei einer Änderung sofort, sonst alle 60 s erneut; danach der Watchdog, wenn es einen gibt.
- **Störung**: Meldet das Gerät eine Störung (Signal `fault` an) oder hat es einen Störungskanal ohne frischen Wert (60 s), bekommt jeder Schreibwert seinen Ruhewert - die Box arbeitet nie gegen eine Störung des Geräts.
- **Steuerung aus** (einer der zwei Schalter der Box zu) und **ohne Freigabe**: die Box schreibt nichts, auch keine Ruhewerte, wie jeder andere Treiber.
- **Schalt-Test**: `switch_test` an die Adresse dieses Geräts schreibt über seine Verbindung; das automatische Zurück nach 30 s schreibt den Ruhewert.

## Routen der API

Wie die Selbstbau-Tür mandanten-gefenced, Rechte wie dort.

| Route | Recht | Wirkung |
|---|---|---|
| `POST /api/v1/sites/{siteId}/components/custom/geraet` `{label, definition}` | `geraet.einrichten` | anlegen; Verbindungstest-Pflicht wie beim Selbstbau; eine Definition ohne Schreibwerte (ganz ohne `controls` oder mit leerem `values`) nur, wenn die führende Box Edge Light ist, sonst „Ein Gerät ohne Schreibwerte legen Sie über «Eigenes Gerät» an“; gespeichert wird sie dann mit einem (leeren) `controls`-Block, damit die alte Selbstbau-Tür sie erkennt |
| `PUT …/components/custom/{id}/geraet` | `geraet.einrichten` | Definition ersetzen (auch ein bisher nur messendes Selbstbau-Gerät); gleiche Schreibwerte behalten die Freigabe, geänderte verlieren sie |
| `POST …/{id}/geraet/test` `{slug, wert}` | `schalttest.durchfuehren` | einen Schreibwert einmal testen; ein Testwert außerhalb des Bands wird abgelehnt, nicht geklemmt; der Beleg hängt an Verbindung und ganzer Form des Schreibwerts |
| `POST …/{id}/geraet/freigabe` `{physicallyConfirmed}` | `freigabe.erteilen` | nur mit bestandenem Test JEDES Schreibwerts und bestätigter Wirkung |
| `DELETE …/{id}/geraet/freigabe` | `freigabe.erteilen` | Rücknahme: die Box liest weiter, schreibt nichts mehr |

Die alte Tür (`PUT …/components/custom/{id}`, `switch-test`, `switch-release`) lehnt ein Gerät mit `controls` ab (409): sie kennt Schreibwerte und Signale nicht und würde sie verwerfen.
Die Spur steht in `consumer_audit_event` mit den Arten `switch_tested`, `switch_released`, `switch_revoked`.

## Grenzen

- Simulatornachweise ersetzen keinen Prüfstand; Freigaben sind gerätebezogen.
- Ein Gerät ohne Watchdog bleibt bei einem Ausfall der Box auf dem letzten Wert stehen.
- Auf der Docker-Box lesen ein reines Messgerät und der alte einzelne Schalter (`switch`) weiter über die Selbstbau-Tür und Node-RED; auf Edge Light laufen sie seit E8 über diese Tür (ohne `controls` bzw. mit einem Schreibwert vom Typ `on_off`), siehe [Paritätsliste](../../../edge-light/docs/paritaet.md).
- Der alte Schalter kennt einen Sollwert in jeder vom Kunden gewählten Einheit (z. B. kW); dieser Vertrag kennt nur `setpoint_c` in °C. Ein Selbstbau-Sollwertschalter in einer anderen Einheit bleibt auf Edge Light offen.

## Versionsregeln

`schema_version` der Definition bleibt `"1.0"`; `controls`, `signal`, `bit`, `coil` und `discrete` sind additiv.
Neue Ablehnungs-Codes, Felder oder Wörter nur gemeinsam in API, Box und Vektoren ändern.
