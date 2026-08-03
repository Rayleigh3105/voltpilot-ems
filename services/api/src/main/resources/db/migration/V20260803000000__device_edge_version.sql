-- =============================================================================
-- V20260803000000 - Der Edge-Stand je Gerät (Admin-Umbau Stufe 1, Baustein B1).
-- -----------------------------------------------------------------------------
-- Die Edge sendet ihre Versionen SEIT DEM BAU mit: `core_version` und
-- `palette_version` stehen im `flows`-Block des Status-Herzschlags
-- (edge-app/core/internal/cloud/cloud.go `FlowsSummary`). Gelesen hat sie
-- niemand - „welche Edges sind veraltet?" war cloud-seitig unbeantwortbar.
-- Diese Tabelle ist der fehlende Speicher; die EDGE bleibt unverändert.
--
-- EINE Zeile je Gerät, bei jedem Herzschlag ERSETZT (der Block trägt den
-- vollständigen Ist-Zustand). Anzeige-only: nichts hiervon speist Telemetrie,
-- Rollups, Erlöse oder den Optimierer.
--
-- Mandanten-gefenced + RLS exakt wie device_control_status /
-- device_source_status / flow_device_ack.
--
-- BEWUSSTE GRENZE, die jeder Leser kennen muss: der `flows`-Block entsteht auf
-- der Edge erst, wenn sie je einen Flow-Deployment-Satz gesehen hat
-- (`Deployer.Summary()` liefert nil davor). Ein Gerät ohne ausgerollte
-- Automation meldet also GAR KEINE Version - dafür gibt es hier keine Zeile,
-- und die Oberfläche sagt „unbekannt", nie eine erfundene Version.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_edge_version (
    device_id       UUID        PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    site_id         UUID        NOT NULL,
    core_version    TEXT,
    palette_version TEXT,
    reported_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_edge_version_site ON device_edge_version (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_edge_version TO ${appDbUser};

ALTER TABLE device_edge_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_edge_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_edge_version_isolation ON device_edge_version;
CREATE POLICY device_edge_version_isolation ON device_edge_version
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
