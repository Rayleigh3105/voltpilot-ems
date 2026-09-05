# Der Katalog hat DREI Dimensionen: Geraetetyp · Marke · Modell (und der WEG gehoert dem Modell)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 25).


Katalog-Neustruktur (Konzept `data/vp-anlegen-rework/konzept.md`, Stufe 1;
Captain-Entscheide 22.08.2026). Sie ist eine PRAESENTATIONS-Neuordnung: kein
Bestandsgeraet aendert Verhalten oder Identitaet.

- **⚠ DER VERBINDUNGSWEG IST EINE EIGENSCHAFT DES MODELLS, NIE DES MARKENNAMENS.**
  `Brand.Transports` sind die Wege einer Marke, `Model.Transports` die eines
  Geraets (erster = Vorgabe). Das loeste den zweiten Fronius-Eintrag auf: ein Eco
  27 spricht SunSpec Modbus, ein GEN24 die Solar API, und beide sind ein Fronius.
  **Die Familie folgt dabei dem WEG, wo das Modell keine eigene nennt**
  (Fronius/generisch: ein Decode-Profil je Weg); bei Deye/KOSTAL gehoert die
  Registerkarte dem Produkt, dort traegt `Model.Family` sie weiter. Ein gesetztes
  `Model.Family` auf einem Mehrweg-Modell machte den Ausweg still wirkungslos.
- **Der Experten-Ausweg ist `Connection.Transport`** - ein reines ANFRAGE-Feld:
  `Normalize` loest ihn zu `Selection.Communication` auf und LOESCHT ihn
  (die `Channel`-Regel an derselben Stelle). Er wird nie persistiert, nie
  veroeffentlicht und steht in keinem `BusPayload`; die Oberflaeche leitet ihn
  beim Wiederanzeigen aus `Selection.Communication` ab. Ein Weg, den das MODELL
  nicht nennt, ist eine Ablehnung, nie ein stiller Rueckfall.
- **⚠ ALIAS-EBENE: `Brand.Hidden` + `Brand.SupersededBy`.** Die frueher
  eigenstaendige Marke `fronius_sunspec` ist VERSTECKT und inhaltlich
  EINGEFROREN (`froniusSunspec*()`): sie wird nicht mehr angeboten, aber jede
  Nachfrage - `Normalize`, `Backfill`, `RatedKw`, der Vorlagen-Export und damit
  die cloud-seitige Aufloesung ueber Marke+Modell - beantwortet sie unveraendert.
  Daran haengen die zwei Fronius Eco der Anlage Herzogau. **Hier nichts
  „aufraeumen"**: jede Aenderung dort ist eine Aenderung an einer laufenden
  Kundenanlage. Der Beweis ist `catalog_struct_test.go`
  (`TestEveryLegacySelectionStillResolvesUnchanged` - das Muster aus PR 425).
- **`Brand.DeviceType`** (inverter · wallbox · switch, plus das reservierte
  Vokabular meter/charge_point/custom) ersetzt die Klammer-Kategorien in den
  Markennamen („go-e (Wallbox)"). Die Oberflaeche filtert damit je Rolle
  (`sources.js brandsForRole`), NICHT mehr an der Anbindung - eine Marke daran zu
  erkennen waere ab dem ersten Modell mit zweitem Weg falsch.
- **`resolveCatalog` fuellt die ABGELEITETEN Felder** (`Brand.Communication`/
  `CommLabel`/`Fields` spiegeln den Vorgabe-Transport; `Model.Fields` NUR bei
  mehreren Wegen, sonst blaehte die Kopie je Modell den Baum um ein Vielfaches
  auf). Die `:8484`-Seite hat dafuer die Zwillings-Helfer `transportsOf`/
  `transportOf`/`familyOf`/`fieldsFor` in `inverter.js` UND `sources.js` - **wer
  die Regeln in `inverter.go` aendert, aendert beide mit.**
- **⚠ Ein Wechsel des Verbindungswegs zeichnet das Formular NEU.** Die Felder
  haengen am WEG (Port 80 gegen 502, Unit-Id gegen keine); eine gemeinsame
  Feldmenge haette Vorgaben des falschen Wegs gezeigt. Ebenso ein MODELL-Wechsel.
- Beweise: `catalog_struct_test.go` (Typ-Dimension, EIN Fronius, Ausweg wirkt,
  Ausweg-Ablehnung, kein Auswahlfeld ohne Wahl, Duplikat-Fix, Kontinuitaet,
  Alias-Ebene, jeder Alias hat einen Nachfolger) · `inverter_test.go` ·
  `web/jstest/ui.test.js` (die versteckte Marke taucht in der Suche nie auf).

