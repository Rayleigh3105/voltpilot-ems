# UEMS-WAGO: Katalog-Quelle `wago` und Schema `modbus_input` / `range` (AP-05 IP-4 + IP-5)

Neu am 16.09.2026, drittes Bau-Paket von AP-05 (Konzept `vp-uems-ap05-wago/report.md` §8 IP-4/IP-5,
Fundament PR 831). **Seit IP-6b (23.09.2026) an der Box:** Inhalts- und Laufzeitstand **2026.09.23.3** —
wirksam erst mit dem Box-Release, das diese Palette trägt (Abschnitt „Aktivierung“ unten).

- `catalog/measurement-points/sources/wago/registerbild-v1.json` — Normalform des Vertrags
  [`wago-registerbild.md`](../../contracts/v2/wago-registerbild.md): Familien `wago.pm494` und `wago.pm495`
  mit je 27 Vorlagen `…karte[*].<feld>` (12 Messwerte, 12 Statuswörter, Gültigkeit, Kartenregister 32/35 als
  Rohwert). Adapter `generate_wago` in `tools/generate.py`, Manifest-Adapter `wago`.
- Schema `catalog.schema.json`: Quellenarten `modbus_input` und `wago_registerbild`, Adress-Art
  `registerbild_relative` (`12+index*42+<offset>`, `base: parameter`), `scale.kind: unknown`, optional
  `range {min,max,invalid}` und `angaben` (Herkunft je Zahl), `families[].an_der_box` sowie das
  cloud-seitige `families[].single_reader: true`. `validate.py` prüft
  jedes davon; `tests/test_catalog.py` `WagoQuelleTest` hält es gegen `wago-registerbild-vectors.json`.
- Katalog-README: „Wertebereich eines Rohwerts“, „WAGO-Energiekarten“, „Familien noch nicht an der Box“.
- api: `MeasurementCatalog.familienNochNichtAnDerBox` ist seit 2026.09.23.3 leer — Suche und Auswahl bieten
  die Karten an. Portal: `registerFamilie.ts` führt `wago.pm494`/`wago.pm495`, der Test liest `an_der_box`.

## Fallen

- ⚠ **Die 750-494 erbt keine Zahl der 750-495** (Befund 4 aus IP-2). Eine Handbuch-Angabe gilt nur für die
  Artikel in `gilt_fuer`; ohne eigene Angabe steht `value_type` und `scale` auf `unknown`, ohne Einheit,
  ohne `range`, `readable: false`. Heute sind ALLE zwölf Messwerte der 494 so, belegt sind nur Adressen,
  Statuswörter (Koppler 750-362) und die Rohwort-Felder. Bei der 495 fehlt der Datentyp von
  `energy_export_total` (zu erheben) — auch sie ist nicht lesbar.
- ⚠ **Aktivierung (IP-6b, 23.09.2026): wirksam mit dem Box-Release.** Der Eintrag in
  `cataloglib.NOCH_NICHT_AN_DER_BOX` ist gefallen (die Liste ist leer, der Mechanismus bleibt),
  `RUNTIME_VERSION` stieg von 2026.09.23.2 (Einheiten, PR 1136) auf 2026.09.23.3, `package_edge_runtime.py` packte Palette-`catalog.json`
  (+54 Punkte, sonst byte-gleich bis auf den Stand) und die Metadaten-Migration
  `V20260924030000__measurement_catalog_metadata_runtime_2026_09_23_3.sql`. Ab dem api-Deploy veröffentlicht die
  api diesen Stand; eine Box mit älterer Palette lehnt jede Mess-Konfiguration als `unsupported_catalog`
  ab und misst mit ihrem letzten angewandten Plan weiter — api-Deploy und Box-Release gehören zusammen.
  Mitgezogen: die festgenagelten Konfig-Beispiele `mqtt-measurement-config.valid*.json` (drei),
  `MeasurementContractsTest`, `tools/nw3-box-image/strecke-seed.sql`, beide Kernspiegel-Dateien (Stand an
  `runtime_catalog_versions` ANGEHÄNGT). Nie eine
  ausgelieferte Familie wieder eintragen: `validate.py` lehnt das ab (Test für `wago.pm495`).
- ⚠ **Aktiviert heißt noch nicht gelesen (Befund IP-6b).** Die Box-Sicht führt die Karten, aber die Laufzeit
  reicht die Parameter je Anlage nicht an den Planer: die api veröffentlicht kein `registerbilder`,
  `mqtt-measurement-config` kennt das Feld nicht, `measurement-runtime.js`/`vp-measurements.js` setzen
  `options.registerbilder` nicht, `readModbus` fährt für `wago_registerbild` immer FC 3, und Kopfprüfung
  (IP-7) wie Ereignisse (IP-8) laufen in keiner Laufzeit. Folge heute: ein 495-Punkt wird je Punkt als
  `driver_unavailable` abgelehnt, ein 494-Messwert (`readable: false`) als `unknown_point`, der Rest der
  Konfiguration läuft weiter — nie ein Lesen an Adresse 0 (Test in `wago-registerbild.test.js`).
- ⚠ **`range` ist ein Box-Feld (firstmate 001, IP-5 = B2):** den Leser brachte IP-6 (PR 942, Test „INVALID-Wert
  führt zu keinem Messwert“); seit 2026.09.23.3 reist `range` in der Palette mit. Die api dekodiert keine
  Register.
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
