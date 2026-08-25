-- =============================================================================
-- Slice 10: vollständiges OCPP-1.6-Datenfundament (noch ohne Command Gateway).
--
-- Der Edge bleibt das lokale CSMS. Diese Tabellen nehmen ausschließlich seine
-- protokollierten Station->CSMS-Ereignisse und die Antworten der bereits
-- vorhandenen Commissioning-Lesevorgänge auf. Keine Tabelle ist ein Sollwert
-- und keine Migration erzeugt einen Befehlspfad zu einer Station.
--
-- Datenschutz ist Teil des Schemas: idTag/parentIdTag werden bereits am Edge
-- mit einem gerätespezifischen HMAC pseudonymisiert. AuthorizationKey kann in
-- der Konfiguration nur als NULL + secret/redacted vorkommen. Die Rohereignisse,
-- Autorisierungsbelege, Diagnose-/Firmwarestatus und hochaufgelösten Messwerte
-- laufen nach 90 Tagen aus; der nicht-personenbezogene Transaktionskopf bleibt
-- als Betriebsnachweis erhalten, transaction_data UND tagref_* werden dann
-- entfernt.
-- =============================================================================

CREATE TABLE ocpp_station (
    device_id                   UUID        NOT NULL,
    charge_point_id             TEXT        NOT NULL,
    tenant_id                   UUID        NOT NULL,
    site_id                     UUID        NOT NULL,
    connected                   BOOLEAN     NOT NULL DEFAULT FALSE,
    connected_at                TIMESTAMPTZ,
    disconnected_at             TIMESTAMPTZ,
    last_seen                   TIMESTAMPTZ,
    booted_at                   TIMESTAMPTZ,
    charge_box_serial_number    TEXT,
    charge_point_model          TEXT,
    charge_point_serial_number  TEXT,
    charge_point_vendor         TEXT,
    firmware_version            TEXT,
    iccid                       TEXT,
    imsi                        TEXT,
    meter_serial_number         TEXT,
    meter_type                  TEXT,
    diagnostics_status          TEXT,
    diagnostics_status_at       TIMESTAMPTZ,
    firmware_status             TEXT,
    firmware_status_at          TIMESTAMPTZ,
    updated_at                  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, charge_point_id)
);

CREATE INDEX idx_ocpp_station_site ON ocpp_station (site_id, charge_point_id);
CREATE INDEX idx_ocpp_station_connection ON ocpp_station (site_id, connected, last_seen DESC);

CREATE TABLE ocpp_connector_state (
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    connector_id        INTEGER     NOT NULL CHECK (connector_id >= 0),
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    status              TEXT        NOT NULL,
    error_code          TEXT        NOT NULL,
    info                TEXT,
    vendor_id           TEXT,
    vendor_error_code   TEXT,
    station_timestamp   TIMESTAMPTZ,
    reported_at         TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, charge_point_id, connector_id)
);

CREATE INDEX idx_ocpp_connector_state_site ON ocpp_connector_state (site_id, charge_point_id, connector_id);

-- Das vollständige, aber bereits redigierte OCPP-Journal. message_type ist
-- Call/CallResult/CallError sowie Event für Connect/Disconnect.
CREATE TABLE ocpp_protocol_event (
    occurred_at         TIMESTAMPTZ NOT NULL,
    event_id            UUID        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    direction           TEXT        NOT NULL CHECK (direction IN ('station_to_csms', 'csms_to_station', 'internal')),
    message_type        TEXT        NOT NULL CHECK (message_type IN ('Call', 'CallResult', 'CallError', 'Event')),
    correlation_id      TEXT,
    action              TEXT        NOT NULL,
    error_code          TEXT,
    error_description   TEXT,
    error_details       JSONB,
    payload             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurred_at)
);

SELECT create_hypertable('ocpp_protocol_event', 'occurred_at',
                         chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX idx_ocpp_protocol_site_time ON ocpp_protocol_event (site_id, occurred_at DESC);
CREATE INDEX idx_ocpp_protocol_station_time ON ocpp_protocol_event (device_id, charge_point_id, occurred_at DESC);
CREATE INDEX idx_ocpp_protocol_action_time ON ocpp_protocol_event (site_id, action, occurred_at DESC);
CREATE INDEX idx_ocpp_protocol_correlation ON ocpp_protocol_event (device_id, charge_point_id, correlation_id, occurred_at DESC)
    WHERE correlation_id IS NOT NULL;

CREATE TABLE ocpp_connector_status_event (
    occurred_at         TIMESTAMPTZ NOT NULL,
    event_id            UUID        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    connector_id        INTEGER     NOT NULL CHECK (connector_id >= 0),
    status              TEXT        NOT NULL,
    error_code          TEXT        NOT NULL,
    info                TEXT,
    vendor_id           TEXT,
    vendor_error_code   TEXT,
    station_timestamp   TIMESTAMPTZ,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurred_at)
);

SELECT create_hypertable('ocpp_connector_status_event', 'occurred_at',
                         chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX idx_ocpp_connector_event_site_time ON ocpp_connector_status_event (site_id, occurred_at DESC);
CREATE INDEX idx_ocpp_connector_event_station ON ocpp_connector_status_event
    (device_id, charge_point_id, connector_id, occurred_at DESC);

CREATE TABLE ocpp_authorization_event (
    occurred_at         TIMESTAMPTZ NOT NULL,
    event_id            UUID        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    correlation_id      TEXT        NOT NULL,
    id_tag_ref          TEXT        NOT NULL,
    status              TEXT,
    expiry_date         TIMESTAMPTZ,
    parent_id_tag_ref   TEXT,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurred_at)
);

SELECT create_hypertable('ocpp_authorization_event', 'occurred_at',
                         chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX idx_ocpp_authorize_site_time ON ocpp_authorization_event (site_id, occurred_at DESC);
CREATE INDEX idx_ocpp_authorize_ref_time ON ocpp_authorization_event (tenant_id, id_tag_ref, occurred_at DESC);

CREATE TABLE ocpp_transaction (
    device_id               UUID        NOT NULL,
    charge_point_id         TEXT        NOT NULL,
    transaction_id          INTEGER     NOT NULL,
    tenant_id               UUID        NOT NULL,
    site_id                 UUID        NOT NULL,
    -- 0 is the honest "unknown" for an orphan StopTransaction received after
    -- an edge reinstall; the stop is retained instead of guessed onto a plug.
    connector_id            INTEGER     NOT NULL CHECK (connector_id >= 0),
    started_at              TIMESTAMPTZ NOT NULL,
    stopped_at              TIMESTAMPTZ,
    meter_start             BIGINT      NOT NULL,
    meter_stop              BIGINT,
    stop_reason             TEXT,
    start_id_tag_ref        TEXT,
    stop_id_tag_ref         TEXT,
    reservation_id          INTEGER,
    charging_profile_id     INTEGER,
    charging_profile_purpose TEXT,
    start_auth_status       TEXT,
    stop_auth_status        TEXT,
    parent_id_tag_ref       TEXT,
    transaction_data        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    transaction_data_purged_at TIMESTAMPTZ,
    start_event_id          UUID,
    stop_event_id           UUID,
    updated_at              TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, charge_point_id, transaction_id)
);

CREATE INDEX idx_ocpp_transaction_site_start ON ocpp_transaction (site_id, started_at DESC);
CREATE INDEX idx_ocpp_transaction_active ON ocpp_transaction (site_id, charge_point_id, connector_id)
    WHERE stopped_at IS NULL;
CREATE INDEX idx_ocpp_transaction_reservation ON ocpp_transaction (site_id, reservation_id)
    WHERE reservation_id IS NOT NULL;
CREATE INDEX idx_ocpp_transaction_profile ON ocpp_transaction (site_id, charging_profile_id)
    WHERE charging_profile_id IS NOT NULL;

-- Eine Zeile ist exakt EIN SampledValue. Der Point-Key enthält JEDE OCPP-
-- Dimension; seine Eindeutigkeit verhindert das Zusammenführen verschiedener
-- Phasen/Orte/Kontexte/Formate/Einheiten bereits im Datenmodell.
CREATE TABLE ocpp_meter_sample (
    sampled_at           TIMESTAMPTZ NOT NULL,
    event_id             UUID        NOT NULL,
    meter_value_index    INTEGER     NOT NULL,
    sampled_value_index  INTEGER     NOT NULL,
    tenant_id            UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    device_id            UUID        NOT NULL,
    charge_point_id      TEXT        NOT NULL,
    connector_id         INTEGER     NOT NULL CHECK (connector_id >= 0),
    transaction_id       INTEGER,
    source               TEXT        NOT NULL CHECK (source IN ('MeterValues', 'TransactionData')),
    point_key            TEXT        NOT NULL,
    measurand            TEXT        NOT NULL,
    context              TEXT        NOT NULL,
    value_format         TEXT        NOT NULL,
    phase                TEXT        NOT NULL,
    location             TEXT        NOT NULL,
    unit                  TEXT        NOT NULL,
    value_text           TEXT        NOT NULL,
    value_numeric        DOUBLE PRECISION,
    received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, meter_value_index, sampled_value_index, sampled_at)
);

SELECT create_hypertable('ocpp_meter_sample', 'sampled_at',
                         chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX idx_ocpp_meter_site_point_time ON ocpp_meter_sample (site_id, point_key, sampled_at DESC);
CREATE INDEX idx_ocpp_meter_station_time ON ocpp_meter_sample (device_id, charge_point_id, connector_id, sampled_at DESC);
CREATE INDEX idx_ocpp_meter_transaction ON ocpp_meter_sample (device_id, charge_point_id, transaction_id, sampled_at)
    WHERE transaction_id IS NOT NULL;

CREATE TABLE ocpp_station_status_event (
    occurred_at         TIMESTAMPTZ NOT NULL,
    event_id            UUID        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    status_kind         TEXT        NOT NULL CHECK (status_kind IN ('diagnostics', 'firmware')),
    status              TEXT        NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurred_at)
);

SELECT create_hypertable('ocpp_station_status_event', 'occurred_at',
                         chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
CREATE INDEX idx_ocpp_station_status_site_time ON ocpp_station_status_event (site_id, occurred_at DESC);
CREATE INDEX idx_ocpp_station_status_station ON ocpp_station_status_event
    (device_id, charge_point_id, status_kind, occurred_at DESC);

CREATE TABLE ocpp_configuration_key (
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    configuration_key   TEXT        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    value               TEXT,
    readonly            BOOLEAN     NOT NULL,
    secret              BOOLEAN     NOT NULL DEFAULT FALSE,
    redacted            BOOLEAN     NOT NULL DEFAULT FALSE,
    standard_key        BOOLEAN     NOT NULL DEFAULT FALSE,
    meaning_known       BOOLEAN     NOT NULL DEFAULT FALSE,
    reported_at         TIMESTAMPTZ NOT NULL,
    source_event_id     UUID,
    PRIMARY KEY (device_id, charge_point_id, configuration_key),
    CHECK (configuration_key <> 'AuthorizationKey' OR (value IS NULL AND secret AND redacted))
);

CREATE INDEX idx_ocpp_configuration_site ON ocpp_configuration_key (site_id, charge_point_id, configuration_key);

CREATE TABLE ocpp_configuration_unknown_key (
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    configuration_key   TEXT        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    reported_at         TIMESTAMPTZ NOT NULL,
    source_event_id     UUID,
    PRIMARY KEY (device_id, charge_point_id, configuration_key)
);

CREATE INDEX idx_ocpp_unknown_configuration_site ON ocpp_configuration_unknown_key
    (site_id, charge_point_id, configuration_key);

CREATE TABLE ocpp_station_capability (
    device_id           UUID        NOT NULL,
    charge_point_id     TEXT        NOT NULL,
    feature_profile     TEXT        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    supported           BOOLEAN     NOT NULL DEFAULT TRUE,
    reported_at         TIMESTAMPTZ NOT NULL,
    source_event_id     UUID,
    PRIMARY KEY (device_id, charge_point_id, feature_profile)
);

CREATE INDEX idx_ocpp_capability_site ON ocpp_station_capability (site_id, charge_point_id, feature_profile);

-- App-Rolle: Listener schreibt, tenant-scoped API liest. Das spätere Command
-- Gateway erhält daraus KEIN Schreibrecht auf eine Station; MQTT downlinks
-- existieren in dieser Scheibe nicht.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    ocpp_station, ocpp_connector_state, ocpp_protocol_event,
    ocpp_connector_status_event, ocpp_authorization_event, ocpp_transaction,
    ocpp_meter_sample, ocpp_station_status_event, ocpp_configuration_key,
    ocpp_configuration_unknown_key, ocpp_station_capability
TO ${appDbUser};

-- RLS + FORCE auf JEDEM mandantengebundenen Gegenstand. Kein Context = keine
-- Zeile; ein gefälschter tenant_id scheitert am WITH CHECK.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ocpp_station', 'ocpp_connector_state', 'ocpp_protocol_event',
    'ocpp_connector_status_event', 'ocpp_authorization_event', 'ocpp_transaction',
    'ocpp_meter_sample', 'ocpp_station_status_event', 'ocpp_configuration_key',
    'ocpp_configuration_unknown_key', 'ocpp_station_capability'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_isolation', t);
  END LOOP;
END $$;

-- Timescale-Retention ist idempotent und funktioniert auch auf FORCE-RLS-
-- Hypertables (keine Kompression: die ist mit RLS bewusst nicht kombiniert).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ocpp_protocol_event', 'ocpp_connector_status_event',
    'ocpp_authorization_event', 'ocpp_meter_sample', 'ocpp_station_status_event'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM timescaledb_information.jobs
       WHERE proc_name = 'policy_retention' AND hypertable_name = t
    ) THEN
      PERFORM add_retention_policy(t, INTERVAL '90 days');
    END IF;
  END LOOP;
END $$;

-- Der maskierte Transaktionskopf bleibt; hochaufgelöste transactionData wird
-- ebenso nach 90 Tagen entfernt. Das Verfahren wird als Timescale-Job täglich
-- ausgeführt und enthält bewusst keine URL-/Token-/idTag-Rohwerte.
CREATE OR REPLACE PROCEDURE ocpp_sensitive_retention(job_id INTEGER, config JSONB)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE ocpp_transaction
     SET transaction_data = '[]'::jsonb,
         start_id_tag_ref = NULL,
         stop_id_tag_ref = NULL,
         parent_id_tag_ref = NULL,
         transaction_data_purged_at = now()
   WHERE stopped_at < now() - INTERVAL '90 days'
     AND (transaction_data <> '[]'::jsonb OR start_id_tag_ref IS NOT NULL
          OR stop_id_tag_ref IS NOT NULL OR parent_id_tag_ref IS NOT NULL);
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.jobs
     WHERE proc_schema = 'public' AND proc_name = 'ocpp_sensitive_retention'
  ) THEN
    PERFORM add_job('ocpp_sensitive_retention', INTERVAL '1 day');
  END IF;
END $$;
