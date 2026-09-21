-- =============================================================================
-- UEMS AP-15 IP-22 — der ANTEILS-VERLUST je Box und Tag (Konzept
-- vp-uems-ap15-verbund Kasten E1 = A, Fall R2, §5.8; entschieden am
-- 21.09.2026; Vertrag docs/contracts/v2/mqtt-plan-result.md „Spiegel im
-- Herzschlag“, Feld anteil_verlust).
--
--   steuerungsverbund_anteil_verlust   je Box und Tag der Anlage, was ihr
--                                      fester Einspeise-Anteil zurückhielt:
--                                      kWh (Untergrenze aus gemessener PV)
--                                      und Sekunden, in denen er band (exakt)
--
-- Die Box zählt (edge-app/core/internal/guards/anteilverlust.go) und meldet den
-- laufenden Tag und den abgeschlossenen Vortag im Herzschlag-Block
-- gemeinsame_steuerung — NUR mit Anteils-Dokument. Der Empfang ist
-- uems/AnteilVerlustAusHerzschlag. Diese Migration legt KEINE Zeile an: eine
-- Box ohne Anteils-Dokument bekommt nie eine (I6, R22).
--
-- Der Zähler eines Tages wächst auf der Box nur; der Empfang schreibt darum
-- das Größere (eine verspätete Nachricht senkt nichts).
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerungsverbund_anteil_verlust (
    tenant_id   UUID        NOT NULL,
    site_id     UUID        NOT NULL,
    device_id   UUID        NOT NULL,
    -- Der Tag der Anlage (Europe/Berlin), wie ihn die Box zählt.
    tag         DATE        NOT NULL,
    verlust_kwh NUMERIC     NOT NULL,
    gebunden_s  INTEGER     NOT NULL,
    gemeldet_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT steuerungsverbund_anteil_verlust_pk PRIMARY KEY (device_id, tag),
    CONSTRAINT steuerungsverbund_anteil_verlust_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Die Zahl gehört der Box: geht die Box, gehen ihre Tage mit.
    CONSTRAINT steuerungsverbund_anteil_verlust_device_fk FOREIGN KEY (device_id)
        REFERENCES device (id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_anteil_verlust_werte_chk
        CHECK (verlust_kwh >= 0 AND gebunden_s >= 0 AND gebunden_s <= 90000)
);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_anteil_verlust_site
    ON steuerungsverbund_anteil_verlust (site_id, tag DESC);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE steuerungsverbund_anteil_verlust ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_anteil_verlust FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_anteil_verlust_tenant_isolation ON steuerungsverbund_anteil_verlust;
CREATE POLICY steuerungsverbund_anteil_verlust_tenant_isolation ON steuerungsverbund_anteil_verlust
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: lesen, anlegen und fortschreiben (der Tag wächst), nie löschen; das
-- Offboarding (TenantRepository.offboard) räumt über die Admin-Rolle ab.
REVOKE ALL ON steuerungsverbund_anteil_verlust FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON steuerungsverbund_anteil_verlust TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_anteil_verlust TO ${adminDbUser};
