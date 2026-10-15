-- =============================================================================
-- V20261016120000 - Alerting Scheibe 3: Tages-Zusammenfassung (Dedup-Zeile)
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4 Nr. 6, §7 Scheibe 3): eine E-Mail je
-- Person und Tag, nur wenn es etwas gibt, nie leer, Vorgabezeit 07:00 Ortszeit.
--
-- `benachrichtigung`s eindeutiger Schluessel (V20261015120000) braucht eine
-- `quelle_id` (UUID, NOT NULL) je Zustellung - fuer die Tages-Zusammenfassung
-- gibt es keine einzelne Meldung, die diese Rolle spielen koennte (sie fasst
-- VIELE zusammen). Diese Zeile uebernimmt die Rolle: eine PRO Person und Tag
-- (UNIQUE), ihre `id` wird als `quelle_id` eingereiht - derselbe Kniff wie
-- `zustellweg_bestaetigung`, deren Zeilen-ID schon heute als `quelle_id`
-- dient (ZustellwegService.anfordern). Verhindert zugleich eine zweite
-- Zusammenfassung am selben Tag, falls der Läufer zweimal hintereinander
-- tickt, bevor der erste Versand verbucht ist.
-- =============================================================================

CREATE TABLE IF NOT EXISTS taeglicher_rueckblick (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    benutzer_sub    TEXT        NOT NULL,
    tag             DATE        NOT NULL,
    erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT taeglicher_rueckblick_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT uq_taeglicher_rueckblick UNIQUE (tenant_id, benutzer_sub, tag),
    CONSTRAINT taeglicher_rueckblick_benutzer_chk CHECK (benutzer_sub <> '')
);

ALTER TABLE taeglicher_rueckblick ENABLE ROW LEVEL SECURITY;
ALTER TABLE taeglicher_rueckblick FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS taeglicher_rueckblick_tenant_isolation ON taeglicher_rueckblick;
CREATE POLICY taeglicher_rueckblick_tenant_isolation ON taeglicher_rueckblick
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON taeglicher_rueckblick FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON taeglicher_rueckblick TO ${appDbUser};
GRANT SELECT, DELETE ON taeglicher_rueckblick TO ${adminDbUser};

COMMENT ON TABLE taeglicher_rueckblick IS
    'Alerting Scheibe 3 (§6.4 Nr. 6): Dedup-Zeile "diese Person hat ihre Tages-Zusammenfassung fuer diesen Tag schon bekommen"; die Zeilen-ID dient als quelle_id in benachrichtigung.';
