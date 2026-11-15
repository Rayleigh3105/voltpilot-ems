-- =============================================================================
-- V20261115150000 - Index für die Lastspitze je Anlage (vp-perf3-server H5).
-- -----------------------------------------------------------------------------
-- PortfolioKpiRepository.importSpitzen sucht je Anlage die höchste
-- Viertelstunde Netzbezug im Jahres- und im Monatsfenster. Ohne diesen Index
-- liest sie alle Viertelstunden des Fensters aller Anlagen und sortiert sie
-- (DISTINCT ON) - der größte Einzelposten von /portfolio/kpis. Mit ihm ist es
-- je Anlage und Chunk ein Griff an den Anfang des Index (ORDER BY
-- grid_import_kwh DESC, bucket LIMIT 1).
--
-- Teilindex auf grid_import_kwh > 0: genau die Bedingung der Abfrage (nur
-- echter Netzbezug zählt), Einspeise- und NULL-Viertelstunden stehen nicht
-- darin. Kein Rollup-Ersatz: telemetry_rollup_1d trägt nur die Tagessumme,
-- nicht die höchste Viertelstunde des Tages.
--
-- Wie V20261112151000: auf der Hypertable baut CREATE INDEX je Chunk; mit
-- timescaledb.transaction_per_chunk committet jeder Chunk einzeln, die Sperre
-- wandert Chunk für Chunk (ein Chunk = 30 Tage), der Rollup-Lauf wartet
-- höchstens einen Chunk lang. Darum ohne Flyway-Transaktion (….sql.conf) und
-- mit IF NOT EXISTS: bricht der Lauf ab, macht der nächste weiter.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_telemetry_rollup_15m_netzbezug_spitze
    ON telemetry_rollup_15m (site_id, grid_import_kwh DESC, bucket)
    WITH (timescaledb.transaction_per_chunk)
    WHERE grid_import_kwh > 0;
