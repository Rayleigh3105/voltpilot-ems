# Katalog-Neustruktur (Anlegen-Rework Stufe 1): Gerätetyp · Marke · Modell — und der WEG gehört dem Modell

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 18).


Konzept `data/vp-anlegen-rework/konzept.md` (Captain-Entscheide 22.08.2026, alle
vier angenommen). **Sie ist eine PRÄSENTATIONS-Neuordnung: kein Bestandsgerät
ändert Verhalten oder Identität** — der Beweis ist ein Kontinuitäts-Test nach dem
Muster aus PR 425. Der neue Anlege-Fluss selbst ist Stufe 2; der bestehende
Drawer läuft mit diesem Baum unverändert weiter.

- **⚠ DER VERBINDUNGSWEG IST EINE EIGENSCHAFT DES MODELLS, NIE DES MARKENNAMENS.**
  Der Katalog (`edge-app/core/internal/inverter` `DefaultCatalog()`) kennt seit
  dieser Stufe `Brand.Transports` (die Wege einer Marke) und `Model.Transports`
  (die eines Geräts, erster = Vorgabe). Das löste die zweite „Marke" *Fronius
  (Modbus / SunSpec)* auf: ein Eco 27 spricht SunSpec Modbus, ein GEN24 die Solar
  API, und beide sind ein Fronius. **Die Familie folgt dabei dem WEG**, wo das
  Modell keine eigene nennt (Fronius/generisch: ein Decode-Profil je Weg); bei
  Deye/KOSTAL gehört die Registerkarte dem PRODUKT und `Model.Family` trägt sie
  weiter.
- **Der Experten-Ausweg** („die Solar API dieses GEN24 antwortet nicht") ist das
  Auswahlfeld „Verbindungsweg" → `Connection.Transport`, ein reines
  ANFRAGE-Feld: `Normalize` löst es zu `Selection.Communication` auf und LÖSCHT
  es. Es wird nie persistiert und steht in keinem `BusPayload` — der Weg IST
  `communication`, zwei Wahrheiten darüber wären eine zu viel. **Cloud-seitig
  gibt es ihn bewusst NICHT:** eine Vorlage speichert EINE `communication` und
  EINE `family`, ein Feld anzubieten, das dort nichts ändern kann, wäre die
  Sorte Behauptung, die dieses Haus nicht macht — der Ausweg im Portal ist der
  ehrliche Modell-Eintrag „Anderes Fronius-Modell".
- **⚠ DIE ALIAS-EBENE trägt die harte Kompatibilitäts-Regel, auf BEIDEN Seiten.**
  Edge: `Brand.Hidden` + `Brand.SupersededBy` — die Marke `fronius_sunspec` ist
  VERSTECKT und inhaltlich EINGEFROREN, beantwortet aber jede Nachfrage
  unverändert (`Normalize`/`Backfill`/`RatedKw`). Cloud: die zwei additiven
  nullbaren Spalten `component_template.device_type` + `superseded_by`
  (Migration `V20260835000000`); **`superseded_by IS NULL` filtert NUR in
  `findNewest`** (die Kunden-Liste) — `findNewestByRef` und
  `findNewestByBrandModel` finden die abgelöste Zeile weiterhin, und genau daran
  hängen die zwei Fronius Eco der Anlage Herzogau (ihr `template_ref` in
  `component_definition` und der Marke+Modell-Weg der Bestands-Übernahme).
- **`device_type`** (inverter · wallbox · switch, plus das reservierte Vokabular
  meter/charge_point/custom) ersetzt die Klammer-Kategorien in den Markennamen.
  **⚠ `NULL` heißt „die Vorlage sagt es nicht", nie ein geratener Typ** — deshalb
  nullbar ohne Default. Ein Typ ohne Katalog-Eintrag ist kein Versäumnis: eine
  OCPP-Ladesäule verbindet sich SELBST (`internal/csms`), für einen reinen
  Zähler bringt die Box kein Decode-Profil mit, und der Selbstbau definiert seine
  Kanäle selbst (`site_component_template`).
- **Offizielle Schreibweisen, Technik raus aus den MARKENnamen** (Captain 4):
  Deye · Fronius · KOSTAL · go-e · Shelly · „Anderes Modell". Der frühere
  Duplikat-Befund ist behoben — Modell und Familie des generischen Eintrags
  hießen beide „SunSpec (Standard)".
- **Zwei Zwillinge, die zusammen wandern:** die Transport-/Feld-Auflösung liegt
  kanonisch in `inverter.go` (`TransportsFor`/`FieldsFor`/`resolveTransport`) und
  als Anzeige-Hälfte in `edge-app/core/internal/web/static/inverter.js` UND
  `sources.js`. `sources.js brandsForRole` filtert seither am GERÄTETYP, nicht an
  der Anbindung (an der Marke gemessen fiele ein Fronius Eco heraus).
- **Beweise:** Go `internal/inverter/catalog_struct_test.go` (Typ-Dimension,
  EIN Fronius, Ausweg wirkt und wird sonst abgelehnt, kein Auswahlfeld ohne
  Wahl, Duplikat-Fix, **Update-Kontinuität über 11 Bestands-Vektoren**,
  Alias-Ebene, jeder Alias hat einen Nachfolger) · `templates_test.go`
  (Byte-Drift-Wächter) · api `BuiltinComponentTemplatesTest` (+3) +
  `ComponentTemplateApiTest.thesupersededFroniusTemplateIsNoLongerOfferedButStaysResolvable`
  (echte DB: nicht angeboten, aber über Schlüssel UND Marke+Modell auflösbar) ·
  `web/jstest/ui.test.js` (die versteckte Marke taucht in der Suche nie auf).
- **Edge-Anteil reist mit dem nächsten Edge-Release** (eine laufende Box behält
  ihr Image); der Cloud-Katalog gilt sofort.
- **Stufe 2 KONSUMIERT die Typ-Dimension: der neue Anlege-Fluss im Portal**
  (`frontend/portal/src/anlegenFlow.ts` + `components/AnlegenDialog.tsx` +
  `components/AnlegenFlow.tsx`, Details in `frontend/portal/AGENTS.md`). Fünf
  Schritte im zentrierten Dialog bzw. als Vollbild-Schrittfolge am Telefon; der
  frühere Seiten-Drawer ist ERSATZLOS entfallen. **Die Anlege-Semantik ist
  unverändert** - dieselben Routen mit denselben Rümpfen, dieselbe
  Verbindungstest-Pflicht, dieselbe Übernahme-Entscheidung auf dem SERVER; nur
  die Reihenfolge der Fragen ändert sich (Gerätetyp statt Vorlagen-Herkunft
  zuerst). **⚠ Der Typ ist dort ein FILTER, kein Zaun:** wo der Katalog nichts
  Eigenes hat (bis heute: `meter`), weitet sich die Liste SICHTBAR auf alle
  Vorlagen - der alte Weg „irgendeine Vorlage + Rolle Netz-Zähler" bleibt damit
  offen, was diese Stufe ausdrücklich nicht brechen darf.

