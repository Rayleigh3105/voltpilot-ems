# UEMS-Referenzunternehmen Ahrenberg: die EINE Beispielquelle aller Pakete

Angelegt am 11.09.2026 mit Fassung 1.1 der Datei (Abgleich mit den gemergten UEMS-Verträgen
AP-01 bis AP-07 und dem Rechte-Vertrag).

**[`docs/contracts/v2/uems-referenzunternehmen.json`](../../contracts/v2/uems-referenzunternehmen.json)**
+ Schema ist die EINZIGE Quelle für Kennzeichen, Werte und Zeitpunkte der „Kunststoffwerk
Ahrenberg GmbH“. Ein Fall, der ein Ahrenberg-Objekt benutzt, nennt dessen Kennzeichen und
übernimmt dessen Werte, nie abweichend. Was ein Fall dazuerfindet, steht in seinem `annahme`.

## Die Formen, die jedes Paket übernimmt

- **Zwei Zeitformen.** TAGESGENAU (AP-02 E9): Ort → Elternknoten, Anlage → Standort,
  Messstelle → Ort, elektrische Stellung, Kostenstellen-Anteile, Kostenstellen und
  Bezugsflächen. `gueltig_ab` ist ein Tag (`2024-03-12`), `gueltig_bis` der LETZTE gültige Tag,
  einschließlich; die alte endet am Vortag der neuen. MINUTENGENAU (AP-04 E2, AP-06 E1):
  führende Quellen, Geräte-Einbauten, Stromwandler und Datenquelle → Box, halboffen
  `[ab, bis)`. Alles andere ist ein Zeitpunkt. Wer einen Tag als Zeitpunkt braucht, nimmt
  00:00 Uhr am Standort (TS `mitternacht` aus `uemsOrtsbaum.ts`) und rechnet sonst nichts um.
- **Orte sind zeitgültig** (`zuordnungen`, Art `ort_eltern`). Beim Standort ist das sein
  Bestehen, `nach` bleibt `null`. Die festen Felder `gebaeude[].standort` und
  `bereiche[].eltern` zeigen den Stand zur Momentaufnahme.
- **`U` ist das Unternehmen als Ort** (MS-19). `KB-AHRENBERG` ist der Kundenbereich
  (`unternehmen.kundenbereich`).
- **Rückwirkend (AP-02 E2):** eine Tages-Zuordnung oder Fläche, die nach ihrem „gültig ab“
  eingetragen wurde, trägt `eingetragen_am` und das `abzeichen` des Ortsbaum-Vertrags
  (Tage = Eintragstag − gilt ab). Die Bestandsanlage AN-1 bringt ihren Verlauf ab 12.03.2024
  mit, eingetragen am 01.10.2026, also „rückwirkend (933 Tage)“. Der Anbau Halle 2 hat
  „rückwirkend (14 Tage)“.
- **Protokolle** stehen im Vokabular des Datenquellen-Vertrags (`modbus_tcp`, `ocpp`). Bei OCPP
  ist die Adresse die Stations-Kennung.
- **Unterstützung:** `seit` ist ein Zeitpunkt, `gueltig_bis` das ENDDATUM — ein Kalendertag,
  einschließlich (Elektro Brunner bis 15.12.2026, der Zugriff endet am 16.12.2026 00:00). Nur ein
  Notfall-Zugriff endet auf die Minute, 24 h nach `seit`.
- **Vergleichsquelle:** MS-01 ← K-1 · Einspeise-/Bezugsleistung am Wechselrichter, Zweck
  „Plausibilität“, ab 20.11.2026 08:30 (eingetragen von Ines Kaltenbach). Die Form ist die
  `vergleichsbindung` des Messstellen-Vertrags, je Größe (`vergleichsquellen`, sonst `[]`).
- **Box Halle 2 am 03.11.2026:** 14:00 Ausfall, die Box puffert. Um 17:30 kommt sie zurück und
  liefert nach. Das Netzteil ist defekt, die Box läuft aber bis zum Tausch weiter. Am
  04.11.2026 um 09:38 übernimmt E-2′.

## Die Prüfungen

Die Zwillinge Java `uems/UemsReferenzunternehmenVectorsTest` und TS
`src/uemsReferenzunternehmen.test.ts` prüfen dieselben Invarianten:

- Schema über `UemsSchemaLaeufer`.
- Kein Ziel vor seinem Bestehen (Ortsbaum `ziel_gab_es_noch_nicht`).
- Jeder Wechsel stößt an: am Folgetag oder auf die Minute.
- Das Abzeichen jedes rückwirkenden Eintrags ist das des Ortsbaum-Vertrags; die Zeitachse
  nennt kein anderes.
- Die Ortsfelder stimmen mit der Zuordnung zur Momentaufnahme überein.
- Eine Vergleichsquelle überlappt nie mit demselben Messwert und ist nie zugleich führend.
- Dazu Hauptzähler, 100 % Anteile, eine Box je Datenquelle, eindeutige Kennzeichen und kein
  Verweis ins Leere.

Gegen die Datei prüfen außerdem die Tests der Messstellen, der Herkunft, der Datenquellen, der
Rechte und die Migrationstests `UemsStandortMigrationTest`, `UemsOrteMigrationTest` und
`MessstelleMigrationTest` (Testcontainers). **Wer die Datei ändert, fährt alle
davon.** Sie laufen mit `./mvnw clean test -Dtest='com.voltpilot.api.uems.*Test'` und
`npx vitest run src/uems*.test.ts src/rechte.test.ts`.

## Gesehen, bewusst nicht angefasst

- **Claudia Berger und Werk Lindach.** Ihre Zuweisung „seit 01.10.2026“ gilt auch für Werk
  Lindach, das erst ab 15.10.2026 besteht (AP-03 §4.1).
