-- =============================================================================
-- V20261112151000 - Löschzug-Indexdeckung II: die Hypertables (Befund
--                   vp-kunde-loeschen-504; Begründung in V20261112150000).
-- -----------------------------------------------------------------------------
-- Auf einer Hypertable baut CREATE INDEX den Index je Chunk. Transaktional
-- hielte EINE Transaktion die Sperre auf allen Chunks, bis der letzte fertig
-- ist - auf Produktions-Hypertables (telemetry_v2, device_measurement_sample:
-- die größten Tabellen der Datenbank) stünde der Ingest so lange still. Mit
-- timescaledb.transaction_per_chunk committet jeder Chunk einzeln: die Sperre
-- wandert Chunk für Chunk, Schreiber warten höchstens einen Chunk lang.
-- Deshalb läuft diese Migration ohne Flyway-Transaktion
-- (…_hypertables.sql.conf: executeInTransaction=false) und jedes Statement
-- trägt IF NOT EXISTS - bricht die Migration mitten im Lauf ab, macht der
-- nächste Lauf beim fehlenden Index weiter (fertige bleiben stehen).
--
-- KEIN nackter (tenant_id)-Index auf einer Hypertable: unter FORCE RLS trägt
-- jede App-Abfrage die Mandanten-Bedingung, und ein billiger tenant-Bitmap
-- verführte den Planer zum BitmapAnd GEGEN die handgebauten Rückwärts-Proben
-- der Portal-Performance-Welle (gemessen am Rig an TopologyRepository
-- LATEST_VALUES: 0,95 ms -> 124 ms). Darum führt jeder Index hier mit
-- tenant_id (das deckt Zählung, EXISTS und DELETE des Löschzugs und die
-- RI-Prüfung der (…,tenant_id)-Fremdschlüssel) und trägt dahinter die Spalten
-- der heißen Probe der Tabelle samt Zeitspalte: die Probe wird so zum direkten
-- Index-Zugriff MIT der RLS-Bedingung (gemessen: 0,32 ms).
-- =============================================================================

-- Topologie/Cockpit-Probe (TopologyRepository): entity_id, channel, time DESC.
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_tenant ON telemetry_v2 (tenant_id, entity_id, channel, time DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_rollup_15m_tenant ON telemetry_v2_rollup_15m (tenant_id, entity_id, channel, bucket DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_rollup_1h_tenant ON telemetry_v2_rollup_1h (tenant_id, entity_id, channel, bucket DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_telemetry_v2_rollup_1d_tenant ON telemetry_v2_rollup_1d (tenant_id, entity_id, channel, bucket DESC)
    WITH (timescaledb.transaction_per_chunk);
-- Messwert-Leseweg (device_id, point_key, time DESC) hinter dem Mandanten.
CREATE INDEX IF NOT EXISTS idx_device_measurement_sample_tenant ON device_measurement_sample (tenant_id, device_id, point_key, time DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_device_measurement_event_tenant ON device_measurement_event (tenant_id, device_id, occurred_at DESC)
    WITH (timescaledb.transaction_per_chunk);
-- OCPP-Leseweg je Anlage hinter dem Mandanten.
CREATE INDEX IF NOT EXISTS idx_ocpp_meter_sample_tenant ON ocpp_meter_sample (tenant_id, site_id, sampled_at DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_ocpp_protocol_event_tenant ON ocpp_protocol_event (tenant_id, site_id, occurred_at DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_ocpp_connector_status_event_tenant ON ocpp_connector_status_event (tenant_id, site_id, occurred_at DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_ocpp_station_status_event_tenant ON ocpp_station_status_event (tenant_id, site_id, occurred_at DESC)
    WITH (timescaledb.transaction_per_chunk);
-- Planungs-Lesewege je Anlage hinter dem Mandanten.
CREATE INDEX IF NOT EXISTS idx_entity_plan_slot_tenant ON entity_plan_slot (tenant_id, site_id, time DESC)
    WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_site_plan_run_tenant ON site_plan_run (tenant_id, site_id, generated_at DESC)
    WITH (timescaledb.transaction_per_chunk);
