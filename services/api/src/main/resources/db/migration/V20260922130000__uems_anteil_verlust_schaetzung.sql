-- =============================================================================
-- UEMS AP-15 Folgepaket zu IP-22 — die SCHÄTZUNG des Anteils-Verlusts in der
-- Cloud, GETRENNT von der Untergrenze der Box (Konzept vp-uems-ap15-verbund
-- Kasten E1 = A, Fall R2; entschieden am 21.09.2026).
--
-- verlust_kwh (IP-22) bleibt, was die Box meldet: eine UNTERGRENZE — die Box
-- kennt die verfügbare Erzeugung einer abgeregelten PV nur aus gemessenen
-- Werten und meldet im Referenzfall R2 ≈ 0 kWh bei 9 h gebundener Zeit.
-- schaetzung_kwh rechnet uems/AnteilVerlustSchaetzung im Takt der Verbund-
-- Bilanz aus der PV-Prognose der Anlage × kWp-Teil der Box (dieselbe Teilung
-- wie der Planlauf, IP-14) minus der gemessenen PV der Box in der gebundenen
-- Zeit; schaetzung_grundlage nennt, woraus:
--
--   prognose   die jüngste VOR dem Zeitpunkt ausgegebene PV-Prognose des
--              aktiven Modells je Viertelstunde
--   nowcast    (vorbehalten — heute nicht erzeugt, siehe Dienst)
--   keine      für den Tag lag nichts vor — dann KEIN Wert (unbekannt ≠ 0)
--
-- Beide Spalten sind leer, bis der Takt den Tag gerechnet hat. Additiv: keine
-- Bestandszeile wird geändert, die App-Rolle hat UPDATE auf der Tabelle schon.
-- =============================================================================

ALTER TABLE steuerungsverbund_anteil_verlust ADD COLUMN IF NOT EXISTS schaetzung_kwh NUMERIC;
ALTER TABLE steuerungsverbund_anteil_verlust ADD COLUMN IF NOT EXISTS schaetzung_grundlage TEXT;

ALTER TABLE steuerungsverbund_anteil_verlust
    DROP CONSTRAINT IF EXISTS steuerungsverbund_anteil_verlust_schaetzung_chk;
ALTER TABLE steuerungsverbund_anteil_verlust
    ADD CONSTRAINT steuerungsverbund_anteil_verlust_schaetzung_chk CHECK (
        (schaetzung_grundlage IS NULL AND schaetzung_kwh IS NULL)
        OR (schaetzung_grundlage = 'keine' AND schaetzung_kwh IS NULL)
        OR (schaetzung_grundlage IN ('prognose', 'nowcast') AND schaetzung_kwh IS NOT NULL AND schaetzung_kwh >= 0)
    );
