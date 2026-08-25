-- =============================================================================
-- V20260840000000 - Auswahlfundament fuer zusaetzliche Geraete-Messwerte.
-- -----------------------------------------------------------------------------
-- Slice 5 des Geraete-Erlebnisses: die Cloud speichert den GEWUENSCHTEN
-- Pollplan, aber behauptet ohne Edge-Quittung niemals, er sei angewendet.
-- Samples/MQTT/Edge-Ack folgen in eigenen Slices. Aktivieren stempelt deshalb
-- serverseitig enabled_at=now() (kein Backfill); Abwaehlen setzt einen
-- Grabstein-Zeitpunkt und loescht weder Auswahlzeile noch Ereignisse.
--
-- Beide Tabellen sind Kundendaten: derselbe RLS-Zaun mit FORCE/default-deny wie
-- device/site. Die aktuelle Auswahl ist aktualisierbar, die Papier-Spur bekommt
-- fuer die App-Rolle ausschliesslich SELECT+INSERT und ist damit append-only.
-- =============================================================================

-- Der zusammengesetzte FK unten bindet tenant/site an GENAU das Device. Ein
-- direkter App-DB-Client kann so trotz eines selbst gewaehlt eigenen tenant_id
-- niemals eine Auswahl an die UUID eines fremden Geraets haengen.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tenant_site_identity
    ON device (id, tenant_id, site_id);

CREATE TABLE IF NOT EXISTS device_measurement_selection (
    tenant_id             UUID        NOT NULL,
    site_id               UUID        NOT NULL,
    device_id             UUID        NOT NULL,
    point_key             TEXT        NOT NULL CHECK (length(point_key) BETWEEN 1 AND 240),
    enabled               BOOLEAN     NOT NULL,
    cadence_s             INTEGER     CHECK (cadence_s IS NULL OR cadence_s BETWEEN 1 AND 86400),
    desired_revision      BIGINT      NOT NULL CHECK (desired_revision > 0),
    enabled_at            TIMESTAMPTZ,
    disabled_at           TIMESTAMPTZ,
    catalog_version       TEXT        NOT NULL,
    changed_by            TEXT        NOT NULL,
    changed_by_name       TEXT,
    changed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    apply_status          TEXT        NOT NULL CHECK (apply_status IN
                              ('pending_edge', 'applied', 'rejected', 'first_sample')),
    apply_reason          TEXT,
    applied_at            TIMESTAMPTZ,
    -- NULL fuer Katalogpunkte; ein freies Register reist als vollstaendige,
    -- read-only Definition. Die Ereignistabelle haelt denselben Snapshot.
    custom_definition     JSONB,
    retention_class       TEXT        NOT NULL CHECK (retention_class IN
                              ('live_power', 'phase_mppt_string', 'thermal_bms',
                               'energy_counter', 'state_event',
                               'identity_configuration', 'unclassified')),
    raw_retention_days    INTEGER     NOT NULL DEFAULT 90 CHECK (raw_retention_days = 90),
    long_term_cadence_s   INTEGER     CHECK (long_term_cadence_s IN (300, 900)),
    long_term_strategy    TEXT        NOT NULL CHECK (long_term_strategy IN
                              ('five_minute', 'fifteen_minute', 'event_history',
                               'change_history', 'none')),
    PRIMARY KEY (device_id, point_key),
    CONSTRAINT device_measurement_selection_device_fk
        FOREIGN KEY (device_id, tenant_id, site_id)
        REFERENCES device (id, tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT device_measurement_selection_times_ck CHECK (
        (enabled AND enabled_at IS NOT NULL AND disabled_at IS NULL)
        OR (NOT enabled AND disabled_at IS NOT NULL)),
    CONSTRAINT device_measurement_selection_apply_ck CHECK (
        (apply_status IN ('pending_edge', 'rejected') AND applied_at IS NULL)
        OR (apply_status IN ('applied', 'first_sample') AND applied_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_device_measurement_selection_site
    ON device_measurement_selection (site_id, device_id, enabled);

CREATE TABLE IF NOT EXISTS device_measurement_selection_event (
    id                    BIGSERIAL   PRIMARY KEY,
    tenant_id             UUID        NOT NULL,
    site_id               UUID        NOT NULL,
    device_id             UUID        NOT NULL,
    point_key             TEXT        NOT NULL CHECK (length(point_key) BETWEEN 1 AND 240),
    desired_revision      BIGINT      NOT NULL CHECK (desired_revision > 0),
    -- Immutable status transitions are appended, never patched: the later
    -- Edge-Ack/sample slices add edge_ack/first_sample rows for the SAME
    -- desired_revision. Only the originating request owns an idempotency key.
    event_kind            TEXT        NOT NULL DEFAULT 'selection_requested' CHECK (event_kind IN
                              ('selection_requested', 'edge_ack', 'first_sample')),
    idempotency_key       UUID,
    requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    requested_enabled     BOOLEAN     NOT NULL,
    requested_cadence_s   INTEGER     CHECK (requested_cadence_s IS NULL
                                               OR requested_cadence_s BETWEEN 1 AND 86400),
    -- Snapshot der serverseitigen No-Backfill-/Abwahl-Grenzen dieser Revision.
    enabled_at            TIMESTAMPTZ,
    disabled_at           TIMESTAMPTZ,
    catalog_version       TEXT        NOT NULL,
    actor                 TEXT        NOT NULL,
    actor_name            TEXT,
    apply_status          TEXT        NOT NULL CHECK (apply_status IN
                              ('pending_edge', 'applied', 'rejected', 'first_sample')),
    apply_reason          TEXT,
    applied_at            TIMESTAMPTZ,
    custom_definition     JSONB,
    retention_class       TEXT        NOT NULL CHECK (retention_class IN
                              ('live_power', 'phase_mppt_string', 'thermal_bms',
                               'energy_counter', 'state_event',
                               'identity_configuration', 'unclassified')),
    raw_retention_days    INTEGER     NOT NULL DEFAULT 90 CHECK (raw_retention_days = 90),
    long_term_cadence_s   INTEGER     CHECK (long_term_cadence_s IN (300, 900)),
    long_term_strategy    TEXT        NOT NULL CHECK (long_term_strategy IN
                              ('five_minute', 'fifteen_minute', 'event_history',
                               'change_history', 'none')),
    CONSTRAINT device_measurement_selection_event_device_fk
        FOREIGN KEY (device_id, tenant_id, site_id)
        REFERENCES device (id, tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT device_measurement_selection_event_apply_ck CHECK (
        (apply_status IN ('pending_edge', 'rejected') AND applied_at IS NULL)
        OR (apply_status IN ('applied', 'first_sample') AND applied_at IS NOT NULL)),
    CONSTRAINT device_measurement_selection_event_kind_ck CHECK (
        (event_kind = 'selection_requested' AND idempotency_key IS NOT NULL)
        OR (event_kind <> 'selection_requested' AND idempotency_key IS NULL)),
    CONSTRAINT device_measurement_selection_event_times_ck CHECK (
        (requested_enabled AND enabled_at IS NOT NULL AND disabled_at IS NULL)
        OR (NOT requested_enabled AND disabled_at IS NOT NULL)),
    CONSTRAINT uq_device_measurement_selection_event_transition
        UNIQUE (device_id, desired_revision, event_kind)
);

CREATE INDEX IF NOT EXISTS idx_device_measurement_selection_event_device_time
    ON device_measurement_selection_event (device_id, requested_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_measurement_selection_event_request
    ON device_measurement_selection_event (device_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- V2's ALTER DEFAULT PRIVILEGES grants ALL on new tables. Narrow it back down:
-- no app DELETE on desired state (deselect is an UPDATE), and no mutation at
-- all on the paper trail. A GRANT alone would not revoke those inherited rights.
REVOKE ALL ON device_measurement_selection FROM ${appDbUser};
REVOKE ALL ON device_measurement_selection_event FROM ${appDbUser};
GRANT SELECT, INSERT, UPDATE ON device_measurement_selection TO ${appDbUser};
GRANT SELECT, INSERT ON device_measurement_selection_event TO ${appDbUser};
REVOKE ALL ON SEQUENCE device_measurement_selection_event_id_seq FROM ${appDbUser};
GRANT USAGE ON SEQUENCE device_measurement_selection_event_id_seq TO ${appDbUser};
-- The cross-tenant admin datasource also inherits ALL from V4. It has no
-- mutation route for this customer paper trail; narrow it to append/read too.
REVOKE ALL ON device_measurement_selection_event FROM ${adminDbUser};
GRANT SELECT, INSERT ON device_measurement_selection_event TO ${adminDbUser};
REVOKE ALL ON SEQUENCE device_measurement_selection_event_id_seq FROM ${adminDbUser};
GRANT USAGE ON SEQUENCE device_measurement_selection_event_id_seq TO ${adminDbUser};

ALTER TABLE device_measurement_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_selection FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_measurement_selection_isolation
    ON device_measurement_selection;
CREATE POLICY device_measurement_selection_isolation ON device_measurement_selection
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_measurement_selection_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_measurement_selection_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_measurement_selection_event_isolation
    ON device_measurement_selection_event;
CREATE POLICY device_measurement_selection_event_isolation
    ON device_measurement_selection_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE device_measurement_selection IS
    'Gewuenschter revisionierter Pollplan je Geraet/Messpunkt; enabled_at ist '
    'serverseitige No-Backfill-Grenze, pending_edge ist keine Apply-Zusage.';
COMMENT ON TABLE device_measurement_selection_event IS
    'Append-only Papier-Spur jeder Auswahl-Aenderung samt Akteur, Katalog, '
    'Kadenz und ehrlichem Apply-Ausgang.';
