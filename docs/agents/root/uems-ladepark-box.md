# UEMS-Ladepark: genau eine Box je Anlage

AP-06 IP-9 verengt den bestehenden Ladepark-Push: Rahmen, Rangliste, Allowlist
und Fahrzeugprofile reisen über `ChargingConfigService` nur an die aktive Box,
die in `device_charge_point` mindestens eine Station der Anlage gemeldet hat.
Mehrere belegte Boxen führen aus Sicherheitsgründen zu keinem Push.

Solange noch keine Station gemeldet ist, bleibt eine Ein-Box-Anlage auf ihrem
bisherigen Empfänger. Bei mehreren Boxen muss der OCPP-Anbinde-Assistent eine
Box angeben; nur dieser erste, ausdrückliche Schritt darf die Allowlist an die
gewählte Box schicken. Meldet bereits eine andere Box Ladepunkte, lehnt die API
die zweite Box mit 422 und einem Kundensatz zur gemeinsamen Steuerung ab.

Die Ladepunkt-Lesefläche liefert additiv `budgets` je Box. `budget` bleibt für
Bestandsleser bestehen. Der Assistent paart ausschließlich die LAN-Adresse der
gewählten Box mit deren gemeldetem OCPP-Port und -Pfad.

Maßgebliche Stellen:

- Zielauflösung und Ablehnung: `ChargingConfigService.zielBoxen` /
  `zielBoxFuerAnbinden`
- physischer Beleg: `ChargingConfigRepository.deviceIdsWithChargePoints`
- Portalfluss: `components/LadesaeuleAnbinden.tsx`
- A14 und Bestandsschutz: `ChargerApiTest` /
  `ChargingConfigPublisherTest.singleBoxPushStaysByteIdentical`
- Browserweg: `e2e/ladepark-box.spec.ts`
