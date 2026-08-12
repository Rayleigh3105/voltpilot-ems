-- =============================================================================
-- V20260819000000 - die VERBINDUNGSFELDER des gemeldeten Ist + der Beleg der
-- Bestands-Übernahme (Einheitsmodell Stufe 2, Konzept vp-komponenten-einheit-h2
-- §4.2). ADDITIV: ohne diese Spalten verhält sich alles zeichengleich wie vorher.
-- -----------------------------------------------------------------------------
-- Der `local_setup`-Block des Herzschlags nannte bis hierher, WAS ein Gerät ist
-- (Rolle/Marke/Modell/Name), aber nie, WIE es erreicht wird. Damit konnte das
-- Portal den Einrichtungs-Stand der Box ZEIGEN, ihn aber nicht als eigenes Soll
-- ÜBERNEHMEN - eine Übernahme aus einem unvollständigen Ist müsste die Adresse
-- des Lesepfads einer LAUFENDEN Anlage raten.
--
-- Die fünf Spalten sind genau die Felder, die `sources.Source` /
-- `inverter.Selection` auf der Box speichern:
--
--   * edge_communication - der Transport (Teil der Quellen-Identität)
--   * edge_family        - die Register-Karte, mit der die Box wirklich liest
--   * edge_connection    - die Transportfelder VERBATIM (jsonb)
--   * edge_interval_s    - die Lese-Kadenz
--   * edge_capacity_kwp  - die Nennleistung (weitet die Plausibilitäts-Hülle)
--   * edge_registry_unit_id - die MaStR-Referenz des Betreibers
--
-- KEIN Backfill: `entity_observed_state` wird je Herzschlag vollständig ersetzt
-- (replaceForDevice), jede Zeile heilt sich also mit dem nächsten Bericht des
-- Geräts selbst - dieselbe Begründung wie bei V20260729020000.
--
-- ⚠ `edge_connection` ist JSONB und das ist hier UNPROBLEMATISCH (anders als bei
-- `edge_release.manifest`): über diese Bytes läuft keine Signatur. Verglichen
-- wird semantisch (Feld für Feld nach dem Parsen), nie byteweise, und die Box
-- normalisiert die Felder ohnehin durch ihren eigenen Katalog.
-- =============================================================================

ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_communication   TEXT;
ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_family          TEXT;
ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_connection      JSONB;
ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_interval_s      INTEGER;
ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_capacity_kwp    NUMERIC(10,3);
ALTER TABLE entity_observed_state ADD COLUMN IF NOT EXISTS edge_registry_unit_id TEXT;

-- -----------------------------------------------------------------------------
-- Der BELEG der Übernahme: wann eine Anlage von box- auf portal-verwaltet
-- gedreht wurde, und wer das veranlasst hat.
--
-- WARUM eine Spalte an der Anlage und keine Historie: die Frage ist „ist diese
-- Anlage übernommen, und seit wann" - der VERLAUF einer Komponente liegt schon
-- vollständig in `component_definition` (jede Fassung mit `created_by`/`note`,
-- die Übernahme schreibt dort Fassungen mit dem Vermerk „Vom Gerät übernommen").
-- Eine zweite Historie hätte keinen Leser.
--
-- NULL heißt „nie automatisch übernommen". Das ist ausdrücklich NICHT dasselbe
-- wie box-verwaltet: eine seit Stufe 1 NEU angelegte Anlage ist portal-verwaltet,
-- ohne je übernommen worden zu sein. Die Autorität steht weiterhin allein in
-- `site.component_authority`; diese Spalte ist der Beleg, nicht der Zustand.
--
-- Der RÜCKWEG (Admin dreht auf box zurück) LÖSCHT den Stempel wieder, damit der
-- getaktete Abgleich die Anlage erneut betrachten kann - sonst wäre ein einmal
-- zurückgenommener Fehlschlag für immer aus dem Blick.
-- -----------------------------------------------------------------------------

ALTER TABLE site ADD COLUMN IF NOT EXISTS components_adopted_at TIMESTAMPTZ;
ALTER TABLE site ADD COLUMN IF NOT EXISTS components_adopted_by TEXT;
