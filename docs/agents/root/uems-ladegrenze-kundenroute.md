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

Im Portal wohnt das Formular der Grenze seit „Ein Ort fürs Laden“ Scheibe 4 (E5 = A, 27.10.2026) in den
Einstellungen (`pages/AnlageTechnik.tsx`, Zeile „Anschlussgrenze“ neben Einspeisegrenze und Netzladen;
`components/AnschlussgrenzeBlatt.tsx` holt Netzanschluss und `ChargingConfig` selbst und reicht sie an das
unveränderte `steuerung/LadenReiter.tsx`-`RahmenBlatt` weiter) - nicht mehr im Reiter Steuerung › Laden: der
zeigt seitdem höchstens EINEN Satz („Mehr lässt Ihr Hausanschluss gerade nicht zu.“, `laden.ts` `bandBremst`),
nur solange die Grenze tatsächlich bremst, und trägt keinen Rahmen-Knopf mehr. Die Geräte-Seite der Steuerung
nennt die Grenze weiter in „Was immer gilt“, jetzt als reiner Hinweis mit Link in die Einstellungen
(`steuerung/Blaetter.tsx` `NetzanschlussBlatt`, `BlattZustand` `'netzanschluss'` statt des früheren `'rahmen'`).
Netzanschluss und vereinbarte Leistung werden beim Öffnen zum heutigen Tag gelesen, die Prüfung mit dem
Wortlaut des Servers steht als reine Ableitung in `steuerung/laden.ts` (`grenzePruefung`), der Übergangssatz
und das Feld „Vereinbarte Leistung (kW)“ erscheinen nur ohne Bindung, und der Stepper bleibt hinter
`Recht aktion="grenze.eintragen"`. Das Blatt schreibt über `saveCustomerChargingFrame`; der allgemeine Weg
`PUT /charging-config` mit `gridLimitKw` prüft nichts und ist für die Kunden-Grenze tabu. Ein reiner
Betriebskunde erhält keine neue Fläche (O18).

Prüfen: `FunktionApiTest#kundenGrenze220Bei200VereinbartIst422MitGrundUndSchreibtNichts`,
`steuerung/RahmenBlatt.test.tsx`, `steuerung/laden.test.ts`, `components/AnschlussgrenzeBlatt.test.tsx`,
`pages/AnlageTechnik.test.tsx`, `e2e/ladegrenze.spec.ts`, `migration.test.ts`, `copy.test.ts`,
`RechteKennungenDerRoutenTest`, `RechtRoutenArchitekturTest`, Typecheck und Portal-Build.
