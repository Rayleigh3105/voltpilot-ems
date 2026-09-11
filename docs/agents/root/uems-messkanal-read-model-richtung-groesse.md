# UEMS-Messkanal-Read-Model und Größe/Richtung je Messpunkt (Katalog 2026.09.11.1)

Neu am 11.09.2026 (AP-04 IP-9). Zwei Teile, ein Zweck: jeder Messkanal trägt die Fakten, die
`MessstelleRegeln.passung` (Regel 7) für eine spätere Quellenbindung (IP-13) braucht.

- **Katalog:** jeder Punkt trägt `quantity` + `direction` (geschlossen oder `null`), vergeben in
  `catalog/measurement-points/tools/semantics.py` (Regel mit Beleg, sonst die belegte Einheit).
  Regeln, Vokabular und die Abbildungstabelle Katalog ↔ Vertrag stehen im Katalog-README
  („Größe und Richtung“). Beweis: `tests/test_semantics.py`, `validate.py`.
- **Read-Model:** `GET /api/v1/sites/{siteId}/komponenten/{entityId}/messkanaele` —
  `web/KomponenteMesskanalController`, Arbeit in `measurement/MesskanalService`, Abbildung in
  `measurement/MesskanalAbbildung`, Form `web/dto/MesskanalDto`, OpenAPI-Tag `messstellen`.
  Beweis: `measurement/MesskanalApiTest` (Testcontainers, K-3 der Referenz = drei Kanäle mit
  Richtung, 404-Zaun) und `measurement/MesskanalAbbildungTest` (rein: README-Tabelle, Passung
  K-3 → MS-01/MS-02, DTO ⟷ OpenAPI).

## ⚠ Die Fallen

- **Zwei Katalog-Stände.** `VERSION` (Inhaltsstand, 2026.09.11.1) ≠ `RUNTIME_VERSION`
  (Laufzeitstand der Box, 2026.08.26.3). Die Palette lehnt jede Mess-Konfiguration mit fremder
  `catalog_version` ab (`measurement-planner.js`, `unsupported_catalog`), deshalb liefert
  `MeasurementCatalog.version()` den LAUFZEITSTAND (Konfiguration, Selektion, Historie
  unverändert) und `inhaltsstand()` den Stand des paketierten Artefakts. Die Regel, wann
  welcher steigt: Katalog-README „Inhaltsstand und Laufzeitstand“.
- **Die Richtungspflicht hat benannte Ausnahmen, keine Muster.** Jede Energie-Größe trägt eine
  Richtung außer den Punkten in `ENERGY_WITHOUT_DIRECTION` (heute sechs, gezählt in
  `expected_inventory.json`). Wer eine Richtung „ergänzt“, braucht einen Beleg, nie eine
  Vermutung.
- **Ein Vorzeichen-Wert hat keine EINE Vertrags-Richtung.** `import_export` (Netzpunkt,
  Zweirichtungszähler) bildet auf `null` ab; `charge_discharge` auf „Laden / Entladen“. Folge
  für IP-13: die Nebengröße „Wirkleistung · Bezug“ von MS-01 lässt sich aus der Wirkleistung
  eines Zweirichtungszählers erst mit einer Vorzeichen-Aufteilung binden
  (`MesskanalAbbildungTest.dieVorzeichenLeistungDesZaehlersSpeistKeineBezugsleistungOhneAufteilung`).
- **Kanäle = Zeilen der Mess-Selektion** (aktiv und abgewählt), gelesen nur über `entity_id`.
  Die Standard-Kanäle der v2-Entität (`telemetry_v2.channel`, z. B. `power_kw`) stehen noch
  nicht darin; Selbstbau hat Name und Einheit, aber keine Wertart/Größe/Richtung.
  `geraet` ist seit der IP-10-Nacharbeit das Gerät der Speisung, deren halboffener Zeitraum
  JETZT enthält (`GeraetRepository.laufenderDerKomponente`), in der Form von `geraet_einbau` des
  Herkunftsvertrags plus `id` (`MesskanalDto.GeraetEinbau`, OpenAPI `MesskanalGeraet`); ohne
  laufende Speisung `null`. `speist` bleibt bis IP-13 leer.
