# UEMS-Führende Box: `LeadDeviceService` ersetzt die Einzel-Gateway-Weiche in Registry-Push und Flow-Aktivierung

Neu am 11.09.2026 (AP-06 IP-5, Backend-Teil). Dienst `services/api/.../entities/LeadDeviceService.java`
(Ergebnis `FuehrendeBox(box, grund)`), reine Ableitung `uems/FuehrendeBoxAbleitung.java` (die
Vorrang-Reihenfolge steht EINMAL in `DatenquelleRegeln.fuehrung`), `site.lead_device_id` liest
`EntityRegistryRepository.storedLeadDeviceId`. Vektoren `docs/contracts/v2/lead-device-vectors.json`
+ `lead-device.schema.json`, Prosa `data-source-assignment.md` §8 „Der Dienst (IP-5)“. Beweis:
`uems/FuehrendeBoxAbleitungVectorsTest` (Fälle, Schema, Referenzunternehmen, jeder
`fuehrende_box`-Fall des Vertrags, alle kleinen Welten), `entities/LeadDeviceServiceTest` (die
Vektoren durch den Dienst), `entities/LeadDeviceBestandVerhaltensgleichTest` (11 Bestandswelten ×
Push, Bootstrap, Vorschau, Übernahme-Frage, Sync-Status, Flow aktivieren/stoppen/neu
veröffentlichen gegen die wörtlich kopierte alte Weiche). Regeln: `uems-datenquelle-und-zustaendigkeit-als.md`.

## ⚠ Die Fallen

- **Eine Regel, zwei Aufrufer.** `EntityRegistryService` (bootstrap, bootstrapIfEligible, preview,
  pushRegistryBestEffort, gatewayDeviceFor, gatewayAmbiguous) und `FlowActivationService`
  (activate, deactivate, republishForSite, hasGatewayDevice) fragen NUR `LeadDeviceService`; die
  private Weiche und ihre Kopie sind weg. Wer für diese Wege eine Box je Anlage braucht, fragt
  dort — nie eine dritte Kopie.
- **Verhaltensgleich für den Bestand.** `lead_device_id` ist überall NULL (kein Backfill; gesetzt
  wird es erst mit der Wahl-Route des Portal-Teils). Dann gilt: Box des Speichers (OHNE
  Anmelde-Prüfung, wie die Weiche), sonst die einzige Box. Die Fehlerfälle behalten ihre Codes
  (`PushOutcome.noGateway()`, `refused(no_gateway_device)`, `SKIPPED_NO_GATEWAY`); das Log nennt
  zusätzlich den Grund.
- **Wörter nach Vertrag.** `gespeichert` · `speicher` · `einzige` · `keine_wahl` sind die des
  Vertrags, neu sind `keine_box` und `gespeichert_nicht_in_anlage`. Die Vorschau bildet 1:1 ab:
  `keine_box` → `no_claimed_device`, `keine_wahl` → `multiple_devices_no_battery_link`,
  `gespeichert_nicht_in_anlage` → `no_gateway_device` (OpenAPI-Enum unverändert).
- **`gatewayAmbiguous` ist NUR `keine_wahl`.** Der Portal-Satz `KEIN_EMPFAENGER_SATZ` nennt
  „mehrere Geräte und keinen zugeordneten Speicher“ als Ursache; `gespeichert_nicht_in_anlage`
  trägt diese Ursache nicht und hat noch keinen eigenen Satz (kommt mit dem Portal-Teil).
- **Gespeichert heißt: in DIESER Anlage angemeldet.** Sonst führt keine Box, nie still eine andere.
  Ein „ausgebaut“ gibt es in der DB noch nicht: Unclaim löscht die Zeile, `ON DELETE SET NULL`
  leert die Wahl. Führt AP-07 E8 „ausgebaut“ ein, muss die Box-Liste des Dienstes
  (`siteDeviceIds`) ausgebaute Boxen auslassen.
- **Nicht umgestellt** (AP-06 §2.4, IP-6/IP-8 ff.): Probe, Register schreiben, Handeingriffe,
  Fahrplan (Optimierer über `asset.device_id`), Ladepark, OCPP, Portal `boxOf`. Offen aus IP-5:
  Portal-Picker „Steuerndes Gerät“ → „Diese Box führt die Anlage“ samt Wahl-Route.
