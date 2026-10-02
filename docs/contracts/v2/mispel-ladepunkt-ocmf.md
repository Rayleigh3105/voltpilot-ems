# MiSpeL — signierte Ladepunkt-Messwerte (OCMF, MP-38)

Stand 03.10.2026 · Vertrag 1.0 · Quelle: BNetzA-Festlegung zur Marktintegration von Speichern und Ladepunkten
(„MiSpeL“, Beschluss 01.10.2026) — Anlage 1 (Abgrenzungsoption) und Tenor mit Begründung; Open Charge Metering
Format (OCMF) der S.A.F.E. e. V., Revision 1.4.1 (`github.com/SAFE-eV/OCMF-Open-Charge-Metering-Format`, `OCMF-en.md`).
Konzept: MiSpeL-Fundament §6, Bauplan §8 Zeile MP-38.

Dieser Vertrag sagt, **wie ein vom Zähler signierter Messwert des Ladepunkts zur Quelle des Zählers Z2 mit Eichstatus
wird**. Er ändert keine Abrechnungsregel: der Monatslauf (MP-8/MP-32) liest weiter die Werte der Zählerrolle (MP-6) und
die des Messstellenbetreibers (MP-15); die signierten Werte stehen daneben am Ladepunkt.

| Datei | Rolle |
|---|---|
| `edge-app/core/internal/ocmf` | OCMF lesen (`Parse`, `Decode`, `ReadingTime`) und Signatur prüfen (`Verify`), alle Verfahren der OCMF-Tabelle 22 |
| `edge-app/core/internal/csms/signed_meter.go` | 1.6 `SignedData` und 2.0.1 `signedMeterValue` abgreifen, prüfen, als Journal-Ereignis melden |
| `services/api/src/main/resources/db/migration/V20261003063800__mispel_ladepunkt_signierter_messwert.sql` | `ladepunkt_signierter_messwert` (je Ablesung, RLS + FORCE) |
| `services/api/.../ocpp/OcppRepository.java` | nimmt das Ereignis `SignedMeterValue` an |
| `services/api/.../mispel/LadepunktRepository.java` · `LadepunktRegeln.eichstatusSigniert` | letzte signierte Ablesung am Ladepunkt, Eichstatus daraus |

## 1. Warum

„Alle Messeinrichtungen zur Bestimmung und zum Nachweis der saldierungsfähigen und der förderfähigen Netzeinspeisung …
müssen mess- und eichrechtskonform sein und die erforderlichen Messwerte in viertelstundengenauer Auflösung
bereitstellen“ (A1 S. 23, Abschn. 3.2.1). Für Ladepunkte gibt es keine Ausnahme: die Forderung, „auch nicht mess- und
eichrechtskonform erfasste Messwerte … zu verwenden (vgl. z.B. Elli, VDA), scheidet … aus“ (Tenor S. 28,
Abschn. 3.2.3.2.1). Ein Ladepunkt belegt seinen Wert mit einem vom Zähler signierten OCMF-Datensatz. OCMF nennt dafür
ausdrücklich den Viertelstundentakt (`ClockAlignedDataInterval = 900`, „Fiscal Metering“, OCMF „Embedding in OCPP“).

## 2. Die Box

| Spur | Wo der Datensatz steht | Schlüssel |
|---|---|---|
| OCPP 1.6 | `SampledValue.format = SignedData` in `MeterValues` und `StopTransaction.transactionData`; Wert als OCMF-Text, hex oder base64 | keiner — 1.6 überträgt keinen; Prüfung endet `nicht_pruefbar` / `schluessel_fehlt` |
| OCPP 2.0.1 | `SampledValue.signedMeterValue` mit `encodingMethod = OCMF` in `MeterValues` und `TransactionEvent`; `signedMeterData` base64 | `publicKey` der Säule (base64, auch base64 über hex) |

Die Box prüft nach OCMF: Nutzdaten sind die **unveränderten Bytes** zwischen den beiden `|` („must not be manipulated
(removing and adding white spaces)“), Hash SHA-256, ECDSA; `SA` fehlt = `ECDSA-secp256r1-SHA256` („default since OCMF
Version 0.4“); `SE` `hex` (Vorgabe) oder `base64`; `SM` nur `application/x-der`. Schlüssel als DER-`SubjectPublicKeyInfo`
(OCMF-Tabelle 23). Verfahren: `secp192k1`, `secp256k1`, `secp192r1`, `secp256r1`, `brainpool256r1` (auch
`brainpoolP256r1`), `secp384r1`, `brainpool384r1` — je mit SHA-256 (OCMF-Tabelle 22). Ausgelassene Felder einer Ablesung
übernimmt sie aus der vorigen desselben Datensatzes (OCMF „Readings“); `TM` und `RV` nie.

| `signaturstatus` | `pruefgrund` | wann |
|---|---|---|
| `gueltig` | — | Signatur passt zu Nutzdaten und Schlüssel |
| `ungueltig` | `signatur_falsch` | Nutzdaten oder Signatur verändert, oder ein anderer Schlüssel derselben Kurve |
| `ungueltig` | `schluessel_fremd` | Schlüssel einer anderen Kurve als das Verfahren |
| `nicht_pruefbar` | `schluessel_fehlt` · `schluessel_defekt` · `verfahren_unbekannt` · `signatur_defekt` | ohne Schlüssel, Schlüssel unlesbar, Verfahren außerhalb Tabelle 22/8, Signatur kein DER |

Ein signierter Wert, der kein OCMF ist, bleibt nur im Rohwert des Protokoll-Journals (1.6) stehen. Nichts davon ändert
eine Protokollantwort, eine Sitzung oder die Messlaufzeit; die Registerwerte kommen weiter aus den `Raw`-Werten
(`TestOCPP16BestandBleibtByteGleich` unverändert grün).

**An die Cloud:** internes Journal-Ereignis (Schema `mqtt-ocpp-events` 1.0, `direction = internal`,
`message_type = Event`, `action = SignedMeterValue`). Die Ereigniskennung ist je Säule, Stecker und Datensatz stabil
(UUID Version 5 aus SHA-256) — ein wiederholter Datensatz ist eine Tatsache. Das Journal ist der absturzsichere Speicher
der Box, bis die Cloud quittiert.

```json
{"connector_id": 1, "transaction_id": 7, "ocpp": "2.0.1", "quelle": "TransactionEvent",
 "ocmf": "OCMF|{…}|{…}", "signaturstatus": "gueltig", "signaturverfahren": "ECDSA-secp256r1-SHA256",
 "schluessel": "<wie geliefert>", "schluessel_sha256": "<hex>", "schluessel_quelle": "saeule",
 "zaehlerkennung": "<MS>", "zaehlerhersteller": "<MV>", "zaehlermodell": "<MM>", "paginierung": "<PG>",
 "ablesungen": [{"zeit": "<TM wörtlich>", "gemessen_am": "<RFC 3339>", "zeitstatus": "S", "anlass": "B",
                 "wert": "<RV wörtlich>", "obis": "<RI>", "einheit": "kWh", "stromart": "AC", "fehler": "", "zaehlerstatus": "G"}]}
```

## 3. Die Cloud

`ladepunkt_signierter_messwert`: je Ablesung eine Zeile (Schlüssel `event_id`, `ablesung`), der Datensatz in jeder
Zeile **unverändert als Text** (`ocmf`, nie `jsonb`), Wert wörtlich (`wert_text`) und als Zahl (`wert`). Ein Ereignis
außerhalb des Vokabulars bleibt nur im Protokoll (`ocpp_protocol_event`) und hält den Listener nicht an. Löschen mit den
OCPP-Daten: Mandant (`TenantRepository`), Gerät (`SeriesRepository.OCPP_TABLES`); Gesamtabzug als Messreihe.

**Am Ladepunkt** (MP-31, `GET /api/v1/sites/{siteId}/ladepunkte[/{komponenteId}]`): `signierter_messwert` = die letzte
signierte Ablesung vor dem Ende des Tages `am` über die OCPP-Kennungen der Komponente (`device_charge_point.entity_id`),
`null` ohne eine. Felder: `gemessen_am`, `zeit`, `anlass`, `wert`, `einheit`, `obis`, `zaehlerkennung`,
`signaturstatus`, `pruefgrund`, `schluessel_quelle`, `schluessel_sha256`, `eichstatus`.

| Signatur | `eichstatus` | Bedeutung |
|---|---|---|
| `gueltig` | `eichrechtskonform` | geeichter Wert des Ladepunkts (Vokabular der Zählerrolle, MP-6) |
| `ungueltig`, `nicht_pruefbar`, keine | `null` | Gerätewert ohne Eichstatus — „scheidet … aus“ (Tenor S. 28) |

## 4. Grenzen (offen)

- **Vertrauensanker des Schlüssels:** `gueltig` belegt, dass der Datensatz mit dem Schlüssel signiert ist, den die Säule
  nennt. Ob das der Schlüssel des geeichten Zählers ist, entscheidet OCMF „out-of-band“ (Typschild, zentrales Register;
  OCMF „Relation of Serial Numbers, Charge Point and Public Key“). Dafür bleibt `schluessel_sha256` stehen; der Abgleich
  mit einem hinterlegten Schlüssel braucht einen Erfassungsweg (Hersteller, Bedienkonzept) — Welle 4.
- **OCPP 1.6 ohne Schlüssel:** 1.6-Datensätze werden aufbewahrt und gemeldet, aber nie `gueltig`, bis ein Schlüssel
  hinterlegt werden kann. Herstellerspezifisches `DataTransfer` bleibt abgelehnt (herstellerneutral).
- **Paginierung und Zusammenhang** über mehrere Datensätze (Lücken, Beginn/Ende, gleiche Seriennummer; OCMF „Signing
  and Verification Process“) prüft die Box nicht; `paginierung` und `anlass` stehen für eine spätere Prüfung bereit.
- **Echte Messwerte eines Herstellers** (Prüfstand mit Pilot-Wallbox, MP-40/MP-42): offen. Die Prüfnachweise nutzen
  öffentliche Beispieldatensätze (KEBA KC-P30, NZR EcoCount SL, DZG DVH4013) aus den Testdaten der
  S.A.F.E.-Transparenzsoftware (Apache-2.0), siehe `edge-app/core/internal/ocmf/testdata/`.
- **Datenschutz:** der Datensatz trägt die Identifikation (`ID`, z. B. RFID-UID) im Klartext und lässt sich ohne
  Signaturbruch nicht schwärzen — wie schon der 1.6-Rohwert im Protokoll-Journal.
- Die Zählerrolle (MP-6) und der Monatslauf lesen den signierten Wert noch nicht; das ist eine Änderung der
  Abrechnungsregel und braucht einen eigenen Vertragsschritt.

## Prüfen

```bash
(cd edge-app/core && go test -race ./internal/ocmf/ ./internal/csms/)   # öffentliche Datensätze, 1.6 + 2.0.1, 1.6-Fingerabdruck
(cd services/api && ./mvnw test -Dtest='LadepunktRegelnTest')          # rein
(cd services/api && ./mvnw test -Dtest='LadepunktBidirektionalApiTest') # Testcontainers: Ablage, Ansicht, Eichstatus, RLS
```
