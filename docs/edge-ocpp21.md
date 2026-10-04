# OCPP 2.1 V2X auf der Box (MiSpeL MP-37)

Seit MP-37 hat die Box-Zentrale eine **dritte Spur `ocpp2.1`** neben 1.6 und 2.0.1 – auf derselben Adresse
`ws://<box>:8887/ocpp/<kennung>`, mit derselben Freigabeliste und derselben Sicherheitsstufe wie die
[2.0.1-Spur](edge-ocpp201.md). Code: `edge-app/core/internal/csms/ocpp21v2x.go`. Bauplan `vp-mispel-fundament` § 8
Zeile MP-37; Feldnamen und Wortschätze nach den OCPP-2.1-JSON-Schemas (NotifyEVChargingNeedsRequest,
SetChargingProfileRequest, TransactionEventRequest).

**Bezug zur Festlegung.** Die MiSpeL-Festlegung nennt kein Protokoll (R1 „Protokolle“; den Wunsch nach OCPP 2.0.1 und
ISO 15118-20 äußert der BDEW, St-BDEW S. 4, Sekundärquelle). Sie regelt, was am Ladepunkt gemessen und gerechnet wird:
Ladepunkt im Sinne der Festlegung ist nur der **bidirektional nutzbare** (Anlage 1 S. 7; S. 26, Abschn. 3.2.5);
Laden ist **Verbrauch im Ladepunkt**, Rückspeisung **Erzeugung im Ladepunkt** (Anlage 1 S. 7), je Richtung ein
Viertelstundenwert Z2V/Z2E (Anlage 1 S. 32, Abschn. 4.2.1). Diese Spur liefert dafür die Fahrzeugseite: ob das
angesteckte Fahrzeug bidirektional überträgt, Ladestand, Energiebedarf, Abfahrt und Grenzen. Gemessen wird weiter über
die beiden Register wie bei 2.0.1 – nie als eine Zahl mit Vorzeichen.

## Aushandlung

| Säule bietet an | Box antwortet | Grund |
|---|---|---|
| nur `ocpp2.1` | `ocpp2.1` | neue Spur |
| `ocpp2.1` und `ocpp2.0.1` | `ocpp2.0.1` | Bestandsschutz: vor MP-37 bekam diese Säule 2.0.1 |
| `ocpp2.1` und `ocpp1.6` (auch mit 2.0.1) | `ocpp1.6` | Bestandsschutz wie bei MP-35 |

Die Vorliebe ist die Reihenfolge der Spuren (1.6, 2.0.1, 2.1). **Eine V2X-Wallbox muss darum auf „nur OCPP 2.1“
eingestellt sein** (Inbetriebnahme durch den Installateur). `ChargerState.OCPPVersion` ist dann `"2.1"`; für 1.6- und
2.0.1-Säulen ändert sich nichts (`TestOCPP16BestandBleibtByteGleich`, die 2.0.1-Tests).

## Was die 2.1-Spur versteht

OCPP 2.1 behält jede 2.0.1-Nachricht, die die Box benutzt. Die Spur fährt darum **dieselbe 2.0.1-Umsetzung**:
Boot, Status, Karte, TransactionEvent, MeterValues, Device Model, Messwert-Einrichtung mit Rücklesen und das ganze
Lastmanagement mit Ladeprofilen (Höchstgrenze, Vorgabewert, TxProfile mit 120-s-Sicherung, Readback) – Tabellen in
[edge-ocpp201.md](edge-ocpp201.md). Neu oder anders:

| Nachricht | 2.1-Spur | 2.0.1-Spur (unverändert) |
|---|---|---|
| NotifyEVChargingNeeds (2.1-Form) | Fahrzeugdaten → `Connector.EV`, Antwort `NoChargingProfile`; unlesbar → `Rejected` | `Rejected` |
| NotifyEVChargingSchedule | `Accepted` (Kenntnisnahme; 2.1-Zeitpläne dürfen Perioden nur mit Sollwert tragen) | `Accepted` |
| TransactionEvent mit 2.1-Auslöser | Auslöser auf ein 2.0.1-Wort abgebildet (Tabelle unten), Ereignis und Messwerte kommen an | – |

`NoChargingProfile` (2.1) sagt der Säule ehrlich: die Box nimmt die Daten zur Kenntnis und rechnet daraus in diesem
Paket keinen ISO-15118-Ladeplan; das TxProfile des Lastmanagements gilt weiter als Grenze.

**2.1-Auslöser** – die Box wertet `triggerReason` nicht aus; ohne die Abbildung würde die Bibliothek (sie kennt nur
2.0.1) das ganze Ereignis samt Messwerten als ungültig zurückweisen:

| 2.1 | 2.0.1-Wort |
|---|---|
| LimitSet, OperationModeChanged | ChargingRateChanged |
| SoCLimitReached, CostLimitReached | EnergyLimitReached |
| TxResumed | ChargingStateChanged |
| RunningCost | MeterValuePeriodic |
| TariffChanged, TariffNotAccepted | Trigger |

## ISO-15118-20-Daten → Fahrzeugdaten (`Connector.EV`, JSON `ev_needs`)

Jeder Wert wie gemeldet, in kW, kWh, %; was das Fahrzeug nicht meldet, ist `null` – **unbekannt, nie 0**.
`reported_at` ist die Empfangszeit der Box (veraltete Daten sind nicht aktuell). Beim nächsten `Available` des Steckers
löscht die Box den Eintrag: das nächste Fahrzeug ist ein anderes.

| 2.1-Feld (NotifyEVChargingNeeds.chargingNeeds) | Box | Bezug im [Vertrag bidirektionaler Ladepunkt](contracts/v2/mispel-ladepunkt-bidirektional.md) |
|---|---|---|
| `requestedEnergyTransfer` (AC_BPT, DC_BPT, …), `availableEnergyTransfer` | `energy_transfer`, `available_energy_transfer`, `bidirectional` (= BPT-Modus) | § 2 Fähigkeit: bidirektional nutzbar ja/nein – hier das, was das Fahrzeug **jetzt** kann |
| `controlMode` | `control_mode` (ScheduledControl / DynamicControl) | – |
| `departureTime` | `departure_at` | § 5 `anwesenheit[].abfahrt` (Erwartung) ↔ gemeldete Abfahrt (Ist) |
| `v2xChargingParameters.targetSoC` | `target_soc_pct` | § 5 `abfahrt_soc_pct` |
| `dcChargingParameters.stateOfCharge` | `soc_pct` (AC: Messwert `SoC` → `Connector.SocPct`) | § 5 „der gemeldete Ladestand bleibt Telemetrie der Säule“ |
| `dcChargingParameters.evEnergyCapacity` | `capacity_kwh` | § 5 `kapazitaet_kwh` |
| `evTargetEnergyRequest`, `evMinEnergyRequest`, `evMaxEnergyRequest` (AC/DC: `energyAmount` als Rückfall für das Ziel) | `target_energy_kwh`, `min_energy_kwh`, `max_energy_kwh` | Energiebedarf bis Ziel / Minimum / Maximum |
| `evMinV2XEnergyRequest`, `evMaxV2XEnergyRequest` | `min_v2x_energy_kwh`, `max_v2x_energy_kwh` (positiv = unter dem V2X-Bereich) | § 5 `mindest_soc_pct`: Energie bis zur Untergrenze, unter der nicht entladen wird |
| `minChargePower`, `maxChargePower` (DC: `evMaxPower` als Rückfall) | `min_charge_kw`, `max_charge_kw` | Grenzen des Fahrzeugs beim Laden |
| `minDischargePower`, `maxDischargePower` (Schema: ≥ 0) | `min_discharge_kw`, `max_discharge_kw` – **Beträge** | Grenzen beim Rückspeisen; Laden und Entladen teilen nie ein Vorzeichenfeld |

Das **Fahrzeugfenster** des Vertrags (§ 5) bleibt die Planungsangabe des Kunden; `ev_needs` ist der Ist-Stand daneben.
Optimierer (MP-33) und Rechenwerk (MP-32) lesen die Werte über den Ladepunkt-Zustand der Box. In die Cloud gehen
seit MP-37b `bidirectional` und der Ladestand (der jüngere aus `soc_pct` hier und dem Messwert `SoC`, mit eigener Uhr
`soc_measured_at`) je Stecker im Herzschlag ([Vertrag § 5b](contracts/v2/mispel-ladepunkt-bidirektional.md)); die
übrigen Werte bleiben auf der Box.

## V2X-Sollwert (hinter dem Schalter, Vorgabe AUS)

`Server.SetV2XSetpoint21(ctx, kennung, stecker, sollwertKw)` sendet einer 2.1-Säule ein **V2X-TxProfile**:

| Feld (ChargingSchedulePeriodType 2.1) | Wert |
|---|---|
| `operationMode` | `CentralSetpoint` (das Fahrzeug folgt dem Sollwert der Zentrale) |
| `setpoint` | Sollwert in W, **negativ = Entladen** (Vorzeichen von OCPP 2.1) |
| `limit` / `dischargeLimit` | `max(Sollwert, 0)` / `min(Sollwert, 0)` – Überschwingen bleibt beim Sollwert |
| Profil | Id `10 + Stecker`, Zweck TxProfile, Dauer 120 s, `transactionId` der Säule – **dasselbe** Profil wie die Live-Zuteilung |

- **Schalter:** `csms.Options.V2XDischarge`, Vorgabe `false`. Aus → `ErrV2XDischargeOff`, **nichts** wird gesendet. Die
  Box setzt ihn aus `Config.V2XEntladen` (Vorgabe aus, **keine Umgebungsvariable**); einziger Aufrufer in der Regelung
  ist der Entladewächter (MP-39, [unten](#entladen-mit-schutzgrenzen-mp-39)).
- Nur über 2.1 (`ErrNotOCPP21` sonst), nur mit offener Sitzung und Transaktionskennung der Säule.
- Die Sicherung gilt auch hier: erneuert die Box den Sollwert nicht, fällt die Säule auf das TxDefaultProfile
  zurück – und das lädt nur. Ladende Sollwerte tragen 120 s, **Entlade-Sollwerte 30 s** (`csms.V2XDischargeFuse`,
  MP-39): verliert die Box die Säule, endet die Rückspeisung spätestens nach 30 s.
- `SetV2XSetpoint21` schreibt unter derselben Sperre wie `ApplyLimit` (`profileMu`) – ein Profilschreiber je Box.
- `Connector.V2X` (`v2x_setpoint`) hält Sollwert, Antwort der Säule und Sendezeit. Plan, angenommener Auftrag und
  gemessene Wirkung bleiben getrennt: ob das Fahrzeug zurückspeist, zeigt nur das Exportregister (Z2E).
- Die Nachricht läuft durch die Warteschlange der Bibliothek (OCPP-J: ein offener CALL je Verbindung), als eigener
  2.1-Anfragetyp unter dem Namen `SetChargingProfile`.

## Entladen mit Schutzgrenzen (MP-39)

Die Cloud plant, die Box entscheidet: `internal/entladeschutz` (`Entscheiden` rein, `Waechter` sendet), verdrahtet in
`internal/agent/v2x_entladen.go`. Der Wächter läuft **nur bei `Config.V2XEntladen`** in einem eigenen 2-s-Takt neben
dem Lastmanagement und fragt je Stecker: darf das Fahrzeug jetzt zurückspeisen, und wie viel?

**Woher die Wünsche kommen.** Der Plan (`…/v2/plan`, [Fahrplan 2.0](contracts/v2/mqtt-schedule-2.0.md#fahrzeug-an-bidirektionalen-ladepunkten-mispel-mp-39))
trägt am Ladepunkt-Eintrag den Block `fahrzeug` (Freigabe `rueckspeisen` aus/v2h/v2g, Reserve, Abfahrt, Ziel,
Kapazität, Rückspeiseleistung); ein **negativer** `setpoint_kw` dieses Eintrags ist der Rückspeisewunsch. Der Agent
hält ihn vom Schiedsrichter fern (der würde einen Sollwert am Ladepunkt ablehnen) – nur der Wächter liest ihn.
**Fehlt der Block oder steht `rueckspeisen` auf `aus`, speist die Box nie zurück.**

**Die Grenzen** – jede einzeln getestet (`entladeschutz_test.go`); was unbekannt oder veraltet ist, ergibt 0 kW
(„im Zweifel laden statt entladen“):

| Grenze | Regel | Grund |
|---|---|---|
| Schalter | `Config.V2XEntladen` aus → nichts | `schalter_aus` |
| Halte-Grund (MP-39b) | Lademodus „Aus“ oder „Schnell“ auf dieser Ladung (der Handeingriff des Lastmanagements, `boostStore`, an die Sitzung gebunden) oder „Automatik pausieren“ → sofort nichts, auch gegen den Plan; eine Szene kommt mit dem Plan (Block fehlt) | `lademodus_aus`, `lademodus_schnell`, `automatik_pausiert` |
| Freigabe des Fahrers | fehlt/`aus`/unbekanntes Wort → nichts | `freigabe_aus` |
| nur ins Haus (V2H) | Rückspeisung ≤ Bezug am Netzzähler ohne Ladepunkt − 0,2 kW: keine „Erzeugung im Ladepunkt“, „während es gleichzeitig eine Netzeinspeisung gibt“ (Anlage 1 S. 11, Abschn. 2.1.3; S. 26 Fn. 21; S. 27 Fn. 22) | `nur_haus` |
| Exportgrenze (V2G) | Einspeisung danach ≤ Exportgrenze des Netzanschlusses − 0,2 kW (`grid_export_limit_kw`, dieselbe Grenze wie der Einspeisewächter); ohne Grenze speist V2G nichts ein | `exportgrenze` |
| § 14a EnWG | die beobachtete § 14a-Hülle (Bezugsgrenze am Netzpunkt) ist die Ladeleistung, mit der das Abfahrtsziel erreichbar bleiben muss | `abfahrtsziel` |
| Mindest-Ladestand | Ladestand ≤ Reserve + 1 %-Punkt → nichts; Reserve nicht gesagt → nichts (wie der Optimierer, MP-33); Fahrzeug meldet Energie unter seinem V2X-Bereich → nichts | `mindest_soc`, `mindest_soc_unbekannt`, `unter_v2x_bereich` |
| Abfahrtsziel | das höhere Ziel (Plan/Fahrzeug) bis zur früheren Abfahrt − 15 min mit der kleinsten bekannten Ladeleistung (Säule, Fahrzeug, § 14a) und √0,85 je Weg ((14)A2,A3,A4 = 0,85, A1 S. 35) immer erreichbar | `abfahrtsziel`, `abfahrt_unbekannt` |
| Abstecken | Stecker frei/keine Sitzung → sofort nichts, Reservierung im selben Takt aufgehoben | `abgesteckt` |
| Verbindungsverlust | Säule getrennt oder > 90 s still; Cloud getrennt; Plan veraltet; Netzzähler > 30 s; Ladestand > 5 min | `verbindung_verloren`, `cloud_getrennt`, `plan_veraltet`, `netz_unbekannt`, `ladestand_unbekannt` |
| Leistung | min(Wunsch, Rückspeiseleistung, Fahrzeug, Säule); unter 0,5 kW oder unter der Mindestleistung des Fahrzeugs → nichts | `leistungsgrenze`, `fahrzeug_mindestleistung` |

**Senden.** Rückspeisung erlaubt → `SetV2XSetpoint21` mit negativem Sollwert; jede Senkung sofort, sonst alle 10 s
erneuert. Der Stecker ist ab dem ersten Senden **reserviert**: `ocppApply` schreibt dort weder Ladegrenze noch
`ClearLimit` (gleiche Profil-Id). Endet die Erlaubnis, sendet der Wächter sofort Sollwert 0 (wenn Säule und Fahrzeug
noch da sind), hebt die Reservierung auf und weckt das Lastmanagement – das Fahrzeug bekommt sein Ladeprofil zurück.
Lehnt die Säule ab, wartet der Wächter 10 s bis zum nächsten Versuch.

**Beweis im Simulator** (`szenario_test.go`, Wallbox aus MP-34, technisch V2H **und** V2G): V2H-Abend mit dem Wächter
als Regler – Z1NE 0,000 kWh, Z2E 10,52 kWh, die Rückspeisung endet bei 40,98 % (Reserve 40 %), Abfahrt 07:00 mit 80 %;
V2G bleibt unter der Exportgrenze 7 kW, ohne Grenze speist es nichts ein; Freigabe aus → Z2E 0; Abstecken 20:00 →
kein Befehl danach.

## Bewusst nicht enthalten

- **Live-Freigabe:** Prüfstand mit echter V2X-Wallbox und echtem Fahrzeug (MP-42, Partner) ist Voraussetzung jeder
  Live-Freigabe; erst danach entscheidet der Captain über Box-Release und eine Umgebungsvariable für
  `Config.V2XEntladen` (sie muss dann bis Beispiel-Env, Compose und Installations-Compose reichen). Die Regelung im
  2-s-Takt ist ein Software-Nachweis; ob sie „technisch sichergestellt“ im Sinne von A1 S. 11 ist, misst der Prüfstand.
- **Plan aus der Cloud:** seit MP-33f veröffentlicht der Optimierer den Block `fahrzeug` mit den negativen Sollwerten,
  nur hinter dem Betreiber-Schalter `VOLTPILOT_MISPEL_FAHRZEUG_SITES` (Vorgabe leer) und nur mit Freigabe des Fahrers
  ([Fahrplan 2.0](contracts/v2/mqtt-schedule-2.0.md#fahrzeug-an-bidirektionalen-ladepunkten-mispel-mp-39)). **Fläche**
  (Freigabe, Abfahrt, „Rückspeisen ja/nein“): MP-41 nach dem abgestimmten Bedienkonzept BK-41.
- Mehrere angesteckte Fahrzeuge an einer Säule: der Plan kennt einen Wunsch je Eintrag; ihn bekommt der erste
  angesteckte Stecker, die übrigen speisen nicht zurück (ein bidirektionaler Ladepunkt je Anlage, wie MP-33). Eine
  Aufteilung je Stecker braucht Plan und Vertrag je Stecker.
- **Prüfung mit einer realen V2X-Wallbox** (ISO 15118-20 bidirektional): offen, braucht Hersteller und Testgerät
  (MP-37 Prüfnachweis, Prüfstand MP-42). Simulatorbelege ersetzen keinen Hardware-Prüfstand.
- Ein **ISO-15118-Ladeplan** aus den Fahrzeugdaten (Antwort `Accepted` + Plan je Fahrzeug), `ChargingProfileKind`
  `Dynamic`, Frequenz-/DER-Betriebsarten (`CentralFrequency`, `LocalFrequency`, `ExternalLimits`, …), Blindleistung.
- Weitere 2.1-Neuerungen, die die Bibliothek nicht kennt (neue Messgrößen wie `Display.PresentSOC`, neue
  Nachrichten): neue Nachrichten beantwortet sie mit `NotImplemented`; die Box richtet nur 2.0.1-Messgrößen ein.
- Cloud-Befehle, Cloud-Messabgleich und Protokoll-Journal sprechen weiter nur 1.6 (wie bei 2.0.1).
- **Signierte Messwerte (OCMF, MP-38) einer 2.1-Säule** liest die Spur wie bei 2.0.1 (`signedSamples201`); das Ereignis
  trägt `"ocpp": "2.0.1"`, weil das geschlossene Vokabular der Cloud nur `1.6`/`2.0.1` annimmt (`OcppRepository`) und
  ein `2.1` dort verworfen würde. `2.1` als Wert braucht Vertrag ([OCMF](contracts/v2/mispel-ladepunkt-ocmf.md)) und API
  gemeinsam – eigener Schritt.

## Prüfen

```bash
cd edge-app/core
go test -race ./internal/csms/ -run 'OCPP21|OCPP201|OneEndpoint|OCPP16Bestand'
go test -race ./internal/csms/ ./internal/agent/ ./internal/ocppsim/ ./internal/ladepunktsim/
go test -race ./internal/entladeschutz/ ./internal/plan2/          # MP-39: Grenzen, Wächter, Simulator-Szenarien
```

`TestOCPP21NegotiatesAndReportsISO15118Data` (Aushandlung in fünf Angeboten; roher OCPP-2.1-Testclient mit dem
Fahrzeug aus `ladepunktsim`: Boot, Einrichtung mit Rücklesen, Sitzung, NotifyEVChargingNeeds DC_BPT → alle Werte in
Box-Einheiten, 2.1-Auslöser mit Messwert, unlesbarer Bericht `Rejected`, Abstecken löscht),
`TestOCPP21DischargeSetpointOnlyBehindTheSwitch` (Schalter aus → nichts gesendet; an → genau ein V2X-Profil in
2.1-Form mit Sollwert −3 500 W, von der Gegenstelle bestätigt; Ablehnung der Säule wird festgehalten; 2.0.1-Säule →
`ErrNotOCPP21`).
