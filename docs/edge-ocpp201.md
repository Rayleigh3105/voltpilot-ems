# OCPP 2.0.1 auf der Box (MiSpeL MP-35, MP-36)

Die Box ist seit MP-35 Zentrale für **OCPP 1.6J und OCPP 2.0.1** – auf **derselben Adresse**
`ws://<box>:8887/ocpp/<kennung>`. Welche Sprache eine Säule spricht, entscheidet der WebSocket-Handschlag
(`Sec-WebSocket-Protocol`). Code: `edge-app/core/internal/csms` – `subprotocol_mux.go` (Weiche),
`ocpp201map.go` (2.0.1-Spur), `ocpp201profiles.go` (2.0.1-Ladeprofile), `ocppmap.go` (1.6-Spur, unverändert im
Verhalten). Bauplan `vp-mispel-fundament` § 8 Zeilen MP-35 und MP-36; Anwendungsfälle nach OCPP 2.0.1 Edition 3,
Part 2 (Specification). Die MiSpeL-Festlegung selbst schreibt kein Protokoll vor; die Kompatibilität mit OCPP 2.0.1
fordert der BDEW in seiner Stellungnahme (S. 4, Sekundärquelle) – darum ist 2.0.1 Pflicht, nicht Kür.

## Aushandlung und Sicherheit

| Säule bietet an | Box antwortet | Grund |
|---|---|---|
| nur `ocpp1.6` | `ocpp1.6` | Bestand |
| nur `ocpp2.0.1` | `ocpp2.0.1` | neue Spur |
| beide, gleich in welcher Reihenfolge | `ocpp1.6` | Bestandsschutz: vor MP-35 bekam diese Säule 1.6. Seit MP-36 wird 2.0.1 gleichwertig gesteuert, die Vorliebe bleibt trotzdem – Protokoll-Journal, Cloud-Befehle und Cloud-Messabgleich sprechen nur 1.6, ein Wechsel nähme einer laufenden Säule genau das weg. Die Regel ist die des Handschlags selbst (gorilla `Upgrader`: erstes Protokoll der **Box**-Liste, das die Säule anbietet). |
| keines davon | Upgrade, dann Schließen mit 1002 | wie bisher |

- **Kein zusätzlicher Port**, gleiche Freigabeliste (nur registrierte Kennungen, sonst HTTP 401 vor dem Upgrade),
  gleiche Stufe wie 1.6: unverschlüsseltes WebSocket im Kundennetz, keine Basic-Auth, kein TLS. Die Weiche lässt
  Authentifizierung und Herkunftsprüfung nur für beide Spuren gemeinsam setzen.
- Eine Kennung hat genau eine lebende Verbindung; die Weiche merkt sich je Kennung die Spur ihres Sockets. Eine
  doppelte Verbindung lehnt die Bibliothek wie bisher ab, ohne die lebende umzuleiten.
- `ChargerState.OCPPVersion` ist `"2.0.1"`, solange die Säule über 2.0.1 verbunden ist, sonst leer – darum bleiben
  Schnappschuss, `chargers.json` und Draht für 1.6 byte-gleich (`TestOCPP16BestandBleibtByteGleich`, Fingerabdruck
  `testdata/ocpp16_bestand.golden.json`, aufgenommen auf dem Stand vor MP-35).

## Was die 2.0.1-Spur versteht

| Nachricht (Anwendungsfall) | Abbildung auf den Bestand |
|---|---|
| BootNotification (B01) | `onBoot` (Hersteller, Modell, Firmware, Seriennummer nur zur Anzeige), Antwort `Accepted` mit Herzschlag 300 s |
| Heartbeat (G02) | `touch`, Antwort mit der Uhr der Box |
| StatusNotification (G01) | `onStatus` mit 1.6-Wort, EVSE = Stecker-Nummer der Box (Tabelle unten) |
| Authorize (C01) | dieselbe Kartenregel wie 1.6 (`authorized` + `startReady`) |
| TransactionEvent Started/Updated/Ended (E01–E07, J02) | Sitzung, Messwerte, Ende (Abschnitt unten) |
| MeterValues (J01) | `onMeterSample` ohne Sitzung; EVSE 0 (Hauptzähler) erreicht wie 1.6-Stecker 0 nur die Messlaufzeit |
| NotifyReport (B07) | Device-Model-Abbild je Säule (`DeviceModel201`) |
| ReportChargingProfiles (K09) | Antwort auf `ChargingProfiles201` (Abschnitt Ladeprofile) |
| NotifyChargingLimit, ClearedChargingLimit (K12, K13) | quittiert und protokolliert; eine fremde Grenze wirkt in der Säule und zeigt sich im Readback |
| NotifyEVChargingNeeds (K15) | `Rejected`: einen ISO-15118-Ladeplan macht die Box erst mit MP-37 |
| NotifyEVChargingSchedule (K15) | `Accepted` (nur Kenntnisnahme) |
| alles andere | `NotImplemented` (Bibliothek) |

**Status** – 2.0.1 trennt, was 1.6 in einem Wort sagte, in `connectorStatus` (G01) und den `chargingState` der
Transaktion:

| 2.0.1 | 1.6-Wort der Box |
|---|---|
| Unavailable, Faulted | Unavailable, Faulted (gewinnen immer) |
| offene Transaktion: Charging / SuspendedEV / SuspendedEVSE | Charging / SuspendedEV / SuspendedEVSE |
| offene Transaktion: EVConnected, Idle | Preparing |
| Available, Reserved (ohne Ladezustand) | Available, Reserved |
| Occupied ohne Transaktion | Finishing, wenn dort seit dem letzten Available eine Transaktion endete, sonst Preparing |

**Transaktion** – die Säule benennt sie (`transactionId`, ≤ 36 Zeichen); die Box behält ihre eigene fortlaufende
Nummer, die alle Verbraucher kennen, und speichert die Stationskennung daneben (`Session.StationTransactionID`,
`station_transaction_id` in `chargers.json`). So findet eine Wiederverbindung und auch ein Box-Neustart dieselbe
Sitzung wieder.

- Die Sitzung öffnet mit dem **ersten Ereignis, das ein idToken trägt** – dem Zeitpunkt, an dem 1.6 StartTransaction
  schickte. Ein `Started` ohne idToken (E02 „Kabel zuerst“) bleibt bis dahin vorgemerkt; Beginn und Startstand der
  Sitzung kommen aus dem `Started`-Ereignis.
- Startstand = `Energy.Active.Import.Register` des Ereignisses. Fehlt er, ist er **unbekannt**
  (`MeterStartUnknown`), nie 0 – der Agent nennt dann keine geladene Energie der Sitzung.
- Lehnt die Kartenregel ab, antwortet die Box `idTokenInfo.status = Invalid`; die Säule beendet nach ihrer
  Einstellung `StopTxOnInvalidId`.
- `Ended` faltet die Endwerte ein und schließt die Sitzung wie StopTransaction.

**Messwerte** – je `sampledValue` wird der Zahlenwert mit dem Zehnerexponenten (`unitOfMeasure.multiplier`)
skaliert; danach laufen sie durch denselben Leser (`ParseMeterValues`) und dieselbe Weitergabe an die
Messlaufzeit (`OnSampledValues`) wie bei 1.6. Beide Register gehen unverändert weiter:
`Energy.Active.Import.Register` → Z2V, `Energy.Active.Export.Register` → Z2E – „Viertelstundenwert des Verbrauchs
bzw. der Erzeugung im Stromspeicher und/oder Ladepunkt“ (MiSpeL Anlage 1 S. 32, Abschn. 4.2.1), getrennt je
Richtung, nie als eine Zahl mit Vorzeichen; im Ladepunkt verbraucht bzw. erzeugt gilt nach dem Begriff „Ladepunkt“
(Anlage 1 S. 7). Die Viertelstundenbildung und die Rolle Z2 bleiben beim Rechenwerk und beim
[Vertrag bidirektionaler Ladepunkt](contracts/v2/mispel-ladepunkt-bidirektional.md) § 4. Nur frische Werte
(≤ 30 s, nicht aus der Zukunft, strikt neuer als der letzte) erreichen die Regelung – OCPP-Zeitstempel tragen
ganze Sekunden.

## Device Model und Inbetriebnahme

Nach dem `Accepted` auf BootNotification richtet die Box mit der **ersten folgenden Nachricht** der Säule die
Messwerte ein (B05) und **liest sie zurück** (B06); das Ergebnis ist der Rückleseweg, nicht der Wunsch
(`Metering201`: `confirmed` | `partial` | `failed`):

| SampledDataCtrlr | Wert |
|---|---|
| `TxUpdatedMeasurands` | Import- und Exportregister, `Power.Active.Import`, `Power.Active.Export`, `SoC`; lehnt die Säule ab: nur Importregister und `Power.Active.Import` |
| `TxStartedMeasurands`, `TxEndedMeasurands` | beide Register; Rückfall: nur Importregister |
| `TxUpdatedInterval` | 10 s (`DefaultMeterInterval`, wie 1.6) |

Eine unidirektionale Säule ohne Exportregister landet so bei `partial` – Z2E fehlt dann sichtbar, statt als 0
zu erscheinen. Für Inbetriebnahme und Fehlersuche gibt es die Go-Schnittstelle `GetVariables201`,
`SetVariables201`, `RequestBaseReport201` (B07) und `DeviceModel201`; eine Fläche dafür gibt es nicht (erst nach
einem abgestimmten Bedienkonzept).

## Ladeprofile und Lastmanagement (MP-36)

Eine 2.0.1-Säule wird **genauso** gesteuert wie eine 1.6-Säule: dieselbe Kette in `smartcharging.go`
(`Commission` → `ApplyLimit` → `ReadBack` → `ClearLimit`), dieselben Grenzen (Standort-Höchstgrenze, sicherer
Vorgabewert, Phasen- und Ampere-Regeln aus `stationProfile`), dieselben Wächter (Einrichtung je Verbindung und Boot,
`SafetyKey`, Kartenfreigabe, 120-s-Sicherung des TxProfile) und derselbe Agent. `liveLane` wählt nur die Spur:
`profileLane` ist für 1.6 der unveränderte `transport`, für 2.0.1 `transport201`.

| Schritt der Kette | OCPP 1.6 | OCPP 2.0.1 |
|---|---|---|
| Fähigkeiten lesen | GetConfiguration | GetVariables (B06) auf `SmartChargingCtrlr` |
| Kartenfreigabe absichern | ChangeConfiguration + Rücklesen | SetVariables (B05) + GetVariables, Tabelle unten |
| Messtakt | `MeterValueSampleInterval` | `SampledDataCtrlr.TxUpdatedInterval` |
| Höchstgrenze | `ChargePointMaxProfile`, Stecker 0 | `ChargingStationMaxProfile`, EVSE 0 (K01) |
| sicherer Vorgabewert | `TxDefaultProfile`, Stecker 0 | `TxDefaultProfile`, EVSE 0 (K01) |
| Live-Zuteilung | `TxProfile`, Dauer 120 s, `transactionId` der Box | `TxProfile`, Dauer 120 s, **`transactionId` der Säule** (`Session.StationTransactionID`) |
| Stapel bereinigen / Grenze löschen | ClearChargingProfile (Id, Zweck) | ClearChargingProfile (`chargingProfileId`, `chargingProfileCriteria`) (K10) |
| Readback | GetCompositeSchedule | GetCompositeSchedule (K08) |
| Inventur (nebenbei) | GetConfiguration ohne Schlüssel | GetBaseReport `FullInventory` (B07) |
| Profile auflisten | – | GetChargingProfiles + ReportChargingProfiles (K09), `ChargingProfiles201` |

- Einheit W (oder A mit Phasenzahl), ein absoluter Ladeplan, Profil-Id = Plan-Id, Ids wie 1.6 (1 Höchstgrenze,
  2 Vorgabewert, 10 + EVSE live). Nur Laden: jede Grenze ist ≥ 0; Entladen und V2X sind MP-37/MP-39.
- **TxProfile ohne Säulen-Transaktion wird nicht gesendet.** 2.0.1 bindet es an die `transactionId` der Säule; vor
  dem ersten idToken (E02 „Kabel zuerst“) gibt es keine Sitzung und es gilt das TxDefaultProfile.
- Die Kartenfreigabe schreibt dieselben acht Einstellungen, jetzt als Device-Model-Variablen (`config201`):

| 1.6-Schlüssel | 2.0.1-Variable |
|---|---|
| `AllowOfflineTxForUnknownId` | `AuthCtrlr.OfflineTxForUnknownIdEnabled` |
| `AuthorizationCacheEnabled` | `AuthCacheCtrlr.Enabled` |
| `LocalPreAuthorize` / `LocalAuthorizeOffline` | `AuthCtrlr.LocalPreAuthorize` / `AuthCtrlr.LocalAuthorizeOffline` |
| `LocalAuthListEnabled` | `LocalAuthListCtrlr.Enabled` |
| `StopTransactionOnInvalidId` / `MaxEnergyOnInvalidId` | `TxCtrlr.StopTxOnInvalidId` / `TxCtrlr.MaxEnergyOnInvalidId` |
| `AuthorizeRemoteTxRequests` | `AuthCtrlr.AuthorizeRemoteStart` |
| `ChargingScheduleAllowedChargingRateUnit` | `SmartChargingCtrlr.RateUnit` |
| `ChargeProfileMaxStackLevel` / `ChargingScheduleMaxPeriods` | `SmartChargingCtrlr.ProfileStackLevel` / `.PeriodsPerSchedule` |
| `MaxChargingProfilesInstalled` | keine lesbare Variable (Kennwert `maxLimit` von `SmartChargingCtrlr.Entries`) – bleibt „unbekannt“, nie geraten |

- **Readback in der finalen Schemaform.** ocpp-go bildet `GetCompositeScheduleResponse.schedule` in einer
  Entwurfsform ab (`startDateTime`, `chargingSchedule`) und verwirft die Felder der finalen 2.0.1-Form
  (`scheduleStart`, `chargingRateUnit`, `chargingSchedulePeriod`) ohne Fehler. Die Spur liest die finale Form deshalb
  zusätzlich aus dem Rohrahmen (`scheduleTap201`); ohne das wäre jeder Readback einer echten Säule „unbekannt“.
- Simulator: `ocppsim.Station201` (gleicher Profilstapel wie die 1.6-Säule, lehnt ein TxProfile ohne passende
  Transaktion ab, verwirft es mit dem Transaktionsende).

## Bewusst nicht enthalten

- **V2X / ISO 15118-20**: MP-37. **Entladebefehl mit Schutzgrenzen**: MP-39. **Signierte Messwerte (OCMF)**: MP-38
  liest und prüft sie neben diesem Pfad ([Vertrag](contracts/v2/mispel-ladepunkt-ocmf.md)).
- **Protokoll-Journal** (Slice 10, Ereignisse an die Cloud): zeichnet nur die 1.6-Spur auf; 2.0.1-Rahmen brauchen
  eine Vertragsfassung des Journals.
- **Sicherheitsprofile 1–3** (Basic-Auth, TLS, Client-Zertifikat): heute für keine der beiden Spuren; ein Profil
  gilt dann für beide.
- Ein EVSE mit mehreren Steckern wird als ein Stecker der Box geführt (die Box zählt Stecker je Säule, 2.0.1
  Transaktionen je EVSE).
- **Cloud-Befehle und Cloud-Messabgleich** sprechen 1.6-Draht und erreichen 2.0.1-Säulen nicht (`errWrongLane`,
  `ErrNotOCPP16`); eine 2.0.1-Fassung braucht einen Befehlsvertrag.
- **Fremde Profile auf derselben Stapelhöhe:** 1.6 ersetzt sie, eine 2.0.1-Säule darf ein Profil mit gleicher
  Stapelhöhe und gleichem Zweck, aber anderer Id ablehnen. Dann scheitert die Einrichtung sichtbar
  („Höchstgrenze abgelehnt“) und die Säule wird nicht gesteuert – sicher, aber erst am Prüfstand zu klären.
- Eine Oberfläche für `ChargingProfiles201` oder die Device-Model-Werkzeuge gibt es nicht (erst nach einem
  abgestimmten Bedienkonzept).

## Prüfen

```bash
cd edge-app/core
go test -race ./internal/csms/ -run 'OCPP201|OneEndpoint|OCPP16Bestand|FinalSchema|Every16Guard'   # 2.0.1 + 1.6-Fingerabdruck
go test -race ./internal/agent/ -run TestA16AndA201StationShareOneBudget   # Lastmanagement 1.6 + 2.0.1
go test -race ./internal/csms/ ./internal/agent/ ./internal/ocppsim/ ./internal/ladepunktsim/
```

MP-36: `TestOCPP201ProfilesSetChangeAndClear` (Einrichten, Setzen, Ändern, Pause, Höchstgrenze, Readback, K09,
Löschen gegen `ocppsim.Station201`), `TestOCPP201ConnectionLossDuringAProfile` (Box schweigt → Säule fällt nach der
120-s-Sicherung selbst auf den Vorgabewert; nach Wiederverbindung erst Einrichtung, dann Befehl),
`TestOCPP201AuthorizationGuardIsTheSameAsFor16`, `TestA16AndA201StationShareOneBudget` (eine 1.6- und eine
2.0.1-Säule unter einer Standortgrenze, gleiche Teilung, gleicher Vorgabewert).

`TestOCPP201StationBootsChargesReconnectsAndEnds` spielt eine ocpp-go-2.0.1-Säule mit dem Fahrzeug aus
`ladepunktsim` (MP-34): Boot, Einrichtung mit Rücklesen, Started ohne Karte, Autorisierung, Laden mit beiden
Registern, Verbindungsabbruch, Wiederverbindung, Box-Neustart mitten in der Sitzung, Ended, Device Model.
Simulatorbelege ersetzen keinen Hardware-Prüfstand.
