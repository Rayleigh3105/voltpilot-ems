# UEMS-WAGO: Katalog-Quelle `wago` und Schema `modbus_input` / `range` (AP-05 IP-4 + IP-5)

Neu am 16.09.2026, drittes Bau-Paket von AP-05 (Konzept `vp-uems-ap05-wago/report.md` §8 IP-4/IP-5,
Fundament PR 831). Katalog-Inhaltsstand **2026.09.16.1**, der Laufzeitstand bleibt **2026.08.26.3**.

- `catalog/measurement-points/sources/wago/registerbild-v1.json` — Normalform des Vertrags
  [`wago-registerbild.md`](../../contracts/v2/wago-registerbild.md): Familien `wago.pm494` und `wago.pm495`
  mit je 27 Vorlagen `…karte[*].<feld>` (12 Messwerte, 12 Statuswörter, Gültigkeit, Kartenregister 32/35 als
  Rohwert). Adapter `generate_wago` in `tools/generate.py`, Manifest-Adapter `wago`.
- Schema `catalog.schema.json`: Quellenarten `modbus_input` und `wago_registerbild`, Adress-Art
  `registerbild_relative` (`12+index*42+<offset>`, `base: parameter`), `scale.kind: unknown`, optional
  `range {min,max,invalid}` und `angaben` (Herkunft je Zahl), `families[].an_der_box`. `validate.py` prüft
  jedes davon; `tests/test_catalog.py` `WagoQuelleTest` hält es gegen `wago-registerbild-vectors.json`.
- Katalog-README: „Wertebereich eines Rohwerts“, „WAGO-Energiekarten“, „Familien noch nicht an der Box“.
- api: `MeasurementCatalog.familienNochNichtAnDerBox` lässt die Punkte beim Laden aus (keine Suche, keine
  Auswahl). Portal: `registerFamilie.ts` führt die Familien nicht, der Test liest `an_der_box`.

## Fallen

- ⚠ **Die 750-494 erbt keine Zahl der 750-495** (Befund 4 aus IP-2). Eine Handbuch-Angabe gilt nur für die
  Artikel in `gilt_fuer`; ohne eigene Angabe steht `value_type` und `scale` auf `unknown`, ohne Einheit,
  ohne `range`, `readable: false`. Heute sind ALLE zwölf Messwerte der 494 so, belegt sind nur Adressen,
  Statuswörter (Koppler 750-362) und die Rohwort-Felder. Bei der 495 fehlt der Datentyp von
  `energy_export_total` (zu erheben) — auch sie ist nicht lesbar.
- ⚠ **Laufzeitstand nicht heben (firstmate 001 = B):** neue Punkte gehören zur Box-Sicht. Die Familien
  stehen deshalb in `cataloglib.NOCH_NICHT_AN_DER_BOX`; Box-Sicht, Palette-`catalog.json` und
  Metadaten-Migration bleiben byte-gleich. **IP-6 streicht den Eintrag, hebt `RUNTIME_VERSION`, packt die
  Palette neu und legt eine neue Metadaten-Migration an — nur mit einem Edge-Release.** Nie eine
  ausgelieferte Familie eintragen: `validate.py` lehnt das ab.
- ⚠ **`range` ist ein Box-Feld ohne Leser (firstmate 001, IP-5 = B2):** kein Edge-Code in diesem Paket.
  IP-6 MUSS den Leser mit dem Edge-Test „INVALID-Wert führt zu keinem Messwert“ bringen — Bedingung in
  `data/vp-uems-ap05-wago/befunde.md` Befund 7. Die api dekodiert keine Register.
- ⚠ **Funktionscode und Wortfolge sind Parameter der Anlage**, nicht Katalog: darum `wago_registerbild`
  statt `modbus_holding`, `address.base: parameter`, `endian: null`.
- ⚠ **Neue Zähler-Art `faktor_zu_erheben`** (die zwei Zählerstände der 494 in `semantics.py`). Die
  Betriebsabfrage `tools/betriebsabfragen/katalog-zaehler-einheiten-nutzung.sql` bleibt beim Katalog
  2026.09.11.1 — WAGO-Punkte kann noch niemand auswählen.
- ⚠ **Nach einem Katalog-Wechsel `./mvnw clean test`**, sonst liegen zwei Katalog-Dateien in
  `target/classes` („expected exactly one packaged measurement catalog, got 2“).
- Faktoren nach Messbereich (1 A / 5 A) und Kartenregister 35 stehen als `conditional_factor` mit Tabelle
  (nur die zitierten Register-Werte 0, 4, 6); die Box liefert dafür keinen dekodierten Wert. Die Wirkleistung
  trägt keine Richtung, ihr Vorzeichen ist zu erheben. Zusatzpunkte je weiterer Messwert-ID gibt es nicht:
  der Karten-Block v1 hat keinen Platz, eine Erweiterung ist eine additive Registerbild-Stufe.
- Nachfolger: IP-6 (Leser, Laufzeitstand), IP-9 (Vorlage je Kartentyp mit Messbereich), IP-14 (der Pilot trägt
  erhobene Angaben nach → neuer Inhaltsstand, Quelle + Vektor-Datei + `WagoQuelleTest` zusammen).
