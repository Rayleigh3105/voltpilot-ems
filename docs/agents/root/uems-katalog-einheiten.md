# UEMS-Katalog-Einheiten: welcher Zähler seine Menge in einer Zahl sagt

Angelegt am 14.09.2026, Befund aus PR 726. Die Cloud nennt eine Zählermenge nur in einer Anzeige-Einheit
des Vertrags [`ergebnis-zustand`](../../contracts/v2/ergebnis-zustand.md) §3. Im Messpunkt-Katalog hatten
**41** Zähler keine Einheit, **25** VAh, **4** „0,1 kWh“ und **1** Wmin — ihr Zuwachs-Satz stand ohne Zahl.

## ⚠ `unit` ist ein Box-Laufzeitfeld

- `unit` steht in `cataloglib.EDGE_FIELDS`: die Palette-`catalog.json` trägt es. Eine geänderte Einheit
  ändert die Box-Sicht, `validate.py` verlangt einen neuen `RUNTIME_VERSION`, und der gehört zu einem
  **Edge-Release** — ohne ihn lehnen Boxen mit älterer Palette jede Messwert-Änderung ab
  (`unsupported_catalog`). Katalog-README „Inhaltsstand und Laufzeitstand“.
- Die Box LIEST `unit` nicht (kein Zugriff in `edge-app/nodered/measurements/*.js` außer der
  OCPP-SampledValue-Einheit, der Go-Core prüft `unit` nur an Selbstbau-Definitionen). Trotzdem: Bytes
  der Laufzeitfelder ändern = Laufzeitstand heben. Das ist eine Captain-Frage (liegt vor, gebündelt mit
  AP-06 IP-13/18), nie Nebenwirkung eines Einheiten-Pakets.
- **Gerechnet wird mit `decoded`.** Die Edge schickt `raw` und `decoded` (= `raw` × `scale`), Historie,
  Rollups und Verdichtung lesen `COALESCE(decoded_numeric, raw_numeric)`. `unit` meint die Einheit des
  DEKODIERTEN Werts — so bei Deye und SunSpec. KACO (`sources/builtin/inverter-runtime.json`) nennt
  dagegen die Register-Einheit: „0,1 kWh“ mit `scale` 0.1 heißt dekodiert kWh. Der Faktor steht also
  schon an der Skalierung; falsch ist nur der Name. Kein Code parst einen Faktor aus einem Einheitentext.

## Was gebaut ist (keine Katalog-Bytes, kein Laufzeitstand)

- **`ergebnis-zustand` 1.8** — VAh/kVAh → **kVAh** (eigene Anzeige-Einheit, Stellen wie kWh, NIE kWh:
  Scheinarbeit ist nicht in Wirkarbeit umrechenbar), Wmin → kWh mit optionalem **`teiler`** 60000
  (1/60000 ist kein endlicher Dezimalfaktor; gerundet wird der EXAKTE Quotient: 2 999 Wmin → „0,0 kWh“).
  Drei Zwillinge gegen dieselbe Datei: Java `ErgebnisZustand` · TS `uemsErgebnis.ts` · Python
  `verbrauch.py` (`_menge`). Platzhalter `menge` erkennt kVAh. „0,1 kWh“ bleibt `einheit_unbekannt`.
- **OCPP-Einheit aus dem Schlüssel** — `MeasurementCatalog.einheit` nennt für `scale` =
  `protocol_value` die Einheit des konkreten Schlüssels (`…unit[wh]` → „Wh“, `OCPP_EINHEITEN` = OCPP-1.6
  `UnitOfMeasure`). ⚠ `unit[none]` bleibt unbekannt — OCPP nimmt dann Wh an, aber eine Station, die kWh
  ohne Einheit schickt, läge um 1 000 daneben. Nur dieser Weg (die UEMS-Verdichtung über
  `ReihenKontext`); Messkanal-Read-Model und Regel 7 lesen weiter `Point.unit()`.
- **Benennung** — `ZAEHLER_OHNE_ANZEIGE_EINHEIT` in `catalog/measurement-points/tools/semantics.py`: 45
  Zähler mit Art und Grund (29 `keine_energie` · 4 `einheit_im_schluessel` · 8 `einheit_nur_im_text`
  go-e · 4 `faktor_im_einheitennamen` KACO). `validate.py` lehnt einen unbenannten Zähler ohne Einheit
  ab; `test_semantics.py` hält jeden Zähler gegen `rundung.anzeige_einheiten` per Pfad.
- **Bestandsabfrage** — `tools/betriebsabfragen/katalog-zaehler-einheiten-nutzung.sql` zählt je Gruppe
  Auswahl, Messwerte (90 Tage) und gespeiste Messstellen; `KatalogEinheitenNutzungAbfrageTest` fährt sie
  gegen die Entwicklungs-DB (Migrationen + `db/dev`: überall 0) und beweist Vorlage UND konkreten
  Schlüssel. In Benutzung ist nur, was ein Kunde AUSGEWÄHLT hat — es gibt keine automatische Auswahl.

## Offen

- **KACO „0,1 kWh“ bleibt ohne Zahl**, bewusst: besser als eine um Faktor 10 falsche. Richtig wird es
  mit `unit` = „kWh“ in `inverter-runtime.json` (wertgleich: `decoded` ist schon kWh) — erst mit dem
  Laufzeitstand. Dann ändern sich auch `MessstelleQuelleApiTest` (erwartet `passt_nicht`/`einheit`) und
  das Beispiel „eine Gesamterzeugung in „0,1 kWh““ in `messstelle.md` §11 und `messstelle-vectors.json`; dieselbe Register-Einheit
  tragen die KACO-Messwerte cHz, „0,1 °C“, „0,1 V“, „0,01 A“.
- **go-e** nennt „measured in Wh“ nur im Text; die Katalog-Regel „keine Einheit aus Prosa“ und der
  Laufzeitstand stehen einem Nachtrag entgegen.
- **Zuwachs über eine Lücke** gibt es für VAh und Wmin trotz Anzeige-Einheit nicht: `data_gap` trägt
  `zuwachs` nur in `EreignisVokabular.EINHEITEN_ZUWACHS` (aus Regel 7: Wh/kWh/MWh, varh/kvarh, m³).
  Wmin dort aufzunehmen heißt Regel 7 (`KANAL_EINHEITEN`, `JE_KWH` ÷ 60000), DB-Funktion, Writer-Zwilling
  und Schemas zusammen; Scheinarbeit hat keine Messstellen-Größe.
