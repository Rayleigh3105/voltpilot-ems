# Kunden-Route für die Ladegrenze — AP-01 IP-13

`PUT /api/v1/sites/{id}/charging-frame` schreibt ausschließlich die Anschlussgrenze des
Ladeparks. Die Route verlangt `grenze.eintragen` an der Anlage und prüft vor dem bestehenden
Speicher-/Publisherpfad:

- Die tagesgültige Bindung aus `anlage_netzanschluss` bestimmt den Netzanschluss. Ist sie
  vorhanden, gilt nur dessen `vereinbart_kw`; `vereinbartKw` aus dem Rumpf wird ignoriert.
- Ohne Bindung ist `vereinbartKw` der ausdrücklich beschriftete Übergangswert des Dialogs.
- `gridLimitKw` darf die vereinbarte Leistung nicht überschreiten. Außerdem bilden
  `frame.maxHouseLoadKw` (Grundlast der letzten sieben Tage) und `frame.houseReserveKw` die
  bestehende Rahmen-Grundlage; nach ihrem Abzug muss ein positives Ladebudget bleiben.
- Jede fachliche Ablehnung ist 422 mit deutschem Grund und schreibt/publiziert nichts. Form- und
  Wertebereichsfehler bleiben 400; Mandantenfremdes bleibt 404.

Die Admin-Route `/api/v1/admin/sites/{id}/charging-frame` bleibt der einzige Schreibweg für
Hausreserve, Sicherheitsabstand, Mindestleistung, Wechsel-Takt, Grundlast und statisches Budget.
Der MQTT-Vertrag und die Plausibilitätsprüfung der Box ändern sich nicht.

Im Portal wohnt die Grenze seit dem Nachzug „Steuerung neu“ im Rahmen-Blatt von Steuerung › Laden
(`steuerung/LadenReiter.tsx`, `RahmenBlatt`; die frühere `LadeparkRahmenKarte` hat main gelöscht), nicht in
Navigation oder Assistent: Netzanschluss und vereinbarte Leistung werden beim Öffnen zum heutigen Tag gelesen,
die Prüfung mit dem Wortlaut des Servers steht als reine Ableitung in `steuerung/laden.ts` (`grenzePruefung`),
der Übergangssatz und das Feld „Vereinbarte Leistung (kW)“ erscheinen nur ohne Bindung, und der Stepper
bleibt hinter `Recht aktion="grenze.eintragen"`. Das Blatt schreibt über `saveCustomerChargingFrame`; der
allgemeine Weg `PUT /charging-config` mit `gridLimitKw` prüft nichts und ist für die Kunden-Grenze tabu.
Ein reiner Betriebskunde erhält keine neue Fläche (O18).

Prüfen: `FunktionApiTest#kundenGrenze220Bei200VereinbartIst422MitGrundUndSchreibtNichts`,
`steuerung/RahmenBlatt.test.tsx`, `steuerung/laden.test.ts`, `e2e/ladegrenze.spec.ts`, `migration.test.ts`, `copy.test.ts`,
`RechteKennungenDerRoutenTest`, `RechtRoutenArchitekturTest`, Typecheck und Portal-Build.
