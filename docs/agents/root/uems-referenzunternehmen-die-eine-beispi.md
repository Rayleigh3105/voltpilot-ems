# UEMS-Referenzunternehmen Ahrenberg: die EINE Beispielquelle aller Pakete

Angelegt am 11.09.2026 mit Fassung 1.1 der Datei (Abgleich mit den gemergten UEMS-Verträgen
AP-01 bis AP-07 und dem Rechte-Vertrag). **Fassung 1.2 seit 12.09.2026** (AP-09 IP-2 + AP-10 IP-2,
Entscheide E1–E17 und E19 = A).

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

## Was die Fassung 1.2 dazugelegt hat (12.09.2026)

Rein ADDITIV, mit ZWEI entschiedenen Berichtigungen. Jede andere Angabe der Fassung 1.1 steht
unverändert in 1.2 — das prüfen beide Zwillinge, und die Berichtigungen rechnen sich aus der
Datei selbst nach.

- **Bezugsgrößen** tragen neben ihrem freien Text die GESCHLOSSENEN Vokabulare des
  Bezugsdaten-Vertrags: `einheit_code`, `periode_code`, `wertart`, `messstelle`.
  `einheit` bleibt „kg Granulat“, `einheit_code` ist `kg` — der Stoff wandert nie in die
  Einheit. `geltung_art` nimmt zusätzlich die übrigen Geltungsbereiche aus AP-09 E1 an
  (die 1.1-Werte `prozess` und `ort` bleiben). Neu: **BZ-5** „Ladezeit Ladepunkt Halle 2“
  (`geltung_art: messstelle` → MS-14). Ein Stammdatum hat KEINE Periode, ein Periodenwert
  immer eine.
- **`MS-21.ablesungen[]`** — die beiden manuellen Gas-Ablesungen (01.10. 07:15 = 48 211 m³,
  02.11. 07:40 = 49 451 m³, beide von JW). Die Monatszuordnung steht an der SCHLIESSENDEN
  Ablesung; die erste eröffnet nur und ordnet nichts zu. Zwischen zwei Ablesungen wird nie
  interpoliert.
- **MS-22 „Lindach nicht zugeordnet“** — der Rest der Bilanz von AN-3 (`formel_typ: rest`,
  Ort „keiner“ wie MS-20, keine Kostenstellen-Anteile). Ohne ihn hätte Lindach eine
  unsichtbare Bilanzdifferenz von 1 200 kWh. Damit sind es **22 Messstellen, davon 5
  berechnete**.
- **`formel_typ`** je berechneter Messstelle, aus `messstelle-formel.md` §0: MS-09 · MS-15 ·
  MS-22 `rest`, MS-19 · MS-20 `gewichtete_summe`.
- **`beispielwerte.tag_2026_10_18_kwh`** — die Plan-Abnahme des Captains an echten Zahlen:
  MS-16 100, MS-17 60, MS-18 30, MS-22 10 kWh.
- **`beispielwerte.oktober_2026_laden_kwh`/`_entladen_kwh`** an MS-04 (7 900 / 7 100). Der
  Speicher geht mit ZWEI Anteilen in eine Bilanz ein, nie als Saldo 800.
- ⚠ **Zwei entschiedene Berichtigungen** (AP-10 E19 = A) — die EINZIGEN Stellen, an denen 1.2
  einen 1.1-Wert anfasst:
  **MS-09 Oktober 52 600 → 54 580 kWh** (Befund W10: die eigenen Eingänge der Formel ergeben
  54 580) und **`gueltig_bis: 2026-12-31` an den vier 9000-Anteilen** (MS-02, MS-03, MS-04,
  MS-09; Befund W8: kein Anteil gilt über das Bestehen seiner Kostenstelle hinaus). Die
  Nachfolge-Anteile bleiben OFFEN — ab 2027 ist MS-03 ehrlich „nicht verteilt“, nie still auf
  9010/9020 umgehängt.

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

Seit Fassung 1.2 zusätzlich (beide Zwillinge, dieselben Prüfungen):

- **Jede berechnete Messstelle rechnet ihren eigenen Oktober-Wert** aus den Beispielwerten
  ihrer eigenen Eingänge (MS-09, MS-15, MS-19, MS-20, MS-22). Das ist der DAUERHAFTE Nachweis
  der Berichtigung W10 — und der Grund, warum eine neue Zahl in der Datei nicht mehr still
  falsch sein kann.
- **Die Plan-Abnahme rechnet:** 100 − 60 − 30 = 10 kWh am 18.10.2026, Richtung „Bezug“, der
  Rest ohne Ort und ohne Gerät.
- **Kein Kostenstellen-Anteil gilt länger als seine Kostenstelle** (W8).
- **Die Ablesungen sind eine Kette steigender Stände**; die erste ordnet keinen Monat zu, ein
  zugeordneter Monat wird von seinem Ablesezeitraum berührt.
- **Jede Bezugsgröße nutzt das geschlossene Vokabular** von `bezugsdaten-vectors.json`
  (`einheiten`, `periode_art`, `wertart`, `geltung_art`); `formel_typ` das von
  `messstelle-formel.md` §0.

Gegen die Datei prüfen außerdem die Tests der Messstellen, der Herkunft, der Datenquellen, der
Rechte und die Migrationstests `UemsStandortMigrationTest`, `UemsOrteMigrationTest` und
`MessstelleMigrationTest` (Testcontainers). **Wer die Datei ändert, fährt alle
davon.** Sie laufen mit `./mvnw clean test -Dtest='com.voltpilot.api.uems.*Test'` und
`npx vitest run src/uems*.test.ts src/rechte.test.ts`.

## Gesehen, bewusst nicht angefasst

- **Claudia Berger und Werk Lindach.** Ihre Zuweisung „seit 01.10.2026“ gilt auch für Werk
  Lindach, das erst ab 15.10.2026 besteht (AP-03 §4.1).
- **`messstelle-vectors.json`, Fall `vorschlag-naechste-nummer`** sagt in seiner Begründung
  „Ahrenberg hat 21 Messstellen“ und pinnt `zaehler: 21` → `MS-0022`. Der Fall rechnet mit
  SEINEN EIGENEN Eingängen und bleibt grün; ihn zu ändern hieße, einen Abnahmefall zu ändern.
  Die Reihe MS-01…MS-22 der Referenzdatei kollidiert nicht mit dem Vorschlag MS-0022.
