-- =============================================================================
-- UEMS AP-15 IP-21 — das PROTOKOLL der Sprungprobe je steuernder Box (Konzept
-- vp-uems-ap15-verbund Kasten E3 = A, Regeln T5/I3/I4, Fälle R1/R19, Befund
-- A17; entschieden am 21.09.2026; Vertrag docs/contracts/v2/mqtt-sprungprobe.md).
--
--   steuerungsverbund_sprungprobe   je Auslösen eine Zeile: wer/wann, was die
--                                   Box verstellen soll, ihr Bericht, die
--                                   Messwerte am Netzpunkt der führenden Box,
--                                   das Urteil — und ob eine spätere
--                                   Strukturänderung sie entwertet hat (I3)
--
-- Auslösen darf nur die Plattform-Rolle (POST /api/v1/admin/sites/{id}/
-- gemeinsame-steuerung/sprungprobe). Diese Migration legt KEINE Zeile an: eine
-- Anlage ohne Gemeinsame Steuerung bekommt nie eine (I6, R22). Die Zeile wird
-- nie gelöscht, nur ausgewertet oder entwertet — das Protokoll bleibt (E3).
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerungsverbund_sprungprobe (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    steuerungsverbund_id UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    -- Die geprüfte Box und die Box, deren Netzpunkt beim Auslösen ausgewertet wird.
    device_id            UUID        NOT NULL,
    fuehrende_box_id     UUID        NOT NULL,
    art                  TEXT        NOT NULL,
    sprung_kw            NUMERIC     NOT NULL,
    dauer_s              INTEGER     NOT NULL,
    wiederholungen       INTEGER     NOT NULL,
    ausgeloest_am        TIMESTAMPTZ NOT NULL,
    -- Nach diesem Zeitpunkt beginnt die Box die Probe nicht mehr (verspätete Zustellung).
    gueltig_bis          TIMESTAMPTZ NOT NULL,
    actor_sub            TEXT,
    actor_name           TEXT        NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT        NOT NULL,
    urteil               TEXT        NOT NULL DEFAULT 'ausgeloest',
    grund                TEXT,
    -- Der Bericht der Box, wie er ankam, und die Messwerte je Sprung (erwartet,
    -- gesehen, Toleranz, Netzpunkt vorher/während) — die Belege des Urteils.
    bericht              JSONB,
    messwerte            JSONB,
    ausgewertet_am       TIMESTAMPTZ,
    entwertet_am         TIMESTAMPTZ,
    entwertet_grund      TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT steuerungsverbund_sprungprobe_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_sprungprobe_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_sprungprobe_device_fk FOREIGN KEY (device_id)
        REFERENCES device (id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_sprungprobe_art_chk
        CHECK (art IN ('erzeugung_senken', 'verbrauch_senken')),
    CONSTRAINT steuerungsverbund_sprungprobe_groesse_chk
        CHECK (sprung_kw > 0 AND sprung_kw <= 50 AND dauer_s > 0 AND dauer_s <= 60
               AND wiederholungen >= 2 AND wiederholungen <= 3),
    CONSTRAINT steuerungsverbund_sprungprobe_urteil_chk
        CHECK (urteil IN ('ausgeloest', 'bestanden', 'nicht_bestanden', 'abgebrochen', 'nicht_auswertbar')),
    CONSTRAINT steuerungsverbund_sprungprobe_ausgewertet_chk
        CHECK ((urteil = 'ausgeloest') = (ausgewertet_am IS NULL)),
    CONSTRAINT steuerungsverbund_sprungprobe_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall'))
);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_sprungprobe_box
    ON steuerungsverbund_sprungprobe (steuerungsverbund_id, device_id, ausgeloest_am DESC);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE steuerungsverbund_sprungprobe ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_sprungprobe FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_sprungprobe_tenant_isolation ON steuerungsverbund_sprungprobe;
CREATE POLICY steuerungsverbund_sprungprobe_tenant_isolation ON steuerungsverbund_sprungprobe
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: lesen, anlegen und fortschreiben (Urteil, Entwertung), nie löschen;
-- das Offboarding (TenantRepository.offboard) räumt über die Admin-Rolle ab.
REVOKE ALL ON steuerungsverbund_sprungprobe FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON steuerungsverbund_sprungprobe TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_sprungprobe TO ${adminDbUser};
