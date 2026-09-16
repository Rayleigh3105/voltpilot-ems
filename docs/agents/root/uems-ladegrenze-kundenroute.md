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

Das Portal erweitert die bestehende `LadeparkRahmenKarte`, nicht Navigation oder Assistent:
Netzanschluss und vereinbarte Leistung werden zum heutigen Tag gelesen, der Übergangssatz erscheint
nur ohne Bindung, und alle Eingaben/Knöpfe bleiben hinter `rollen.ts`/`Recht`. Ein reiner
Betriebskunde erhält keine neue Fläche (O18).

Prüfen: `FunktionApiTest#kundenGrenze220Bei200VereinbartIst422MitGrundUndSchreibtNichts`,
`LadeparkRahmenKarte.test.tsx`, `migration.test.ts`, `copy.test.ts`,
`RechteKennungenDerRoutenTest`, `RechtRoutenArchitekturTest`, Typecheck und Portal-Build.
