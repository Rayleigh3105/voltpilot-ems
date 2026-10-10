-- UEMS AP-15 IP-10 (P3, Y3): je Box und Plan „veröffentlicht“ und „angenommen“.
-- Vertrag: docs/contracts/v2/mqtt-plan-result.md. Zwei Schreiber, beide per
-- Upsert auf (device_id, plan_id): der Optimierer nach dem Veröffentlichen auf
-- …/v2/plan (vertrauenswürdige Backend-Rolle wie site_plan_run), die api beim
-- Empfang von …/v2/plan-result. Wer zuerst kommt, legt die Zeile an; eine alte
-- Box ohne Quittung behält urteil = NULL („angenommen“ bleibt leer).
-- Die Migration legt keine Zeile an.

CREATE TABLE plan_zustellung (
    device_id           UUID        NOT NULL,
    plan_id             UUID        NOT NULL,
    tenant_id           UUID        NOT NULL,
    site_id             UUID        NOT NULL,
    generated_at        TIMESTAMPTZ,
    veroeffentlicht_um  TIMESTAMPTZ,
    urteil              TEXT,
    grund               TEXT,
    quittiert_um        TIMESTAMPTZ,
    empfangen_um        TIMESTAMPTZ,
    PRIMARY KEY (device_id, plan_id),
    -- Abmelden und Mandanten-Abbau löschen die Box; ihre Zustellungen gehen mit.
    CONSTRAINT plan_zustellung_device_fk
        FOREIGN KEY (device_id, tenant_id)
        REFERENCES device (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT plan_zustellung_urteil_chk
        CHECK (urteil IS NULL OR urteil IN ('angenommen', 'abgelehnt')),
    CONSTRAINT plan_zustellung_grund_chk
        CHECK (grund IS NULL OR grund IN (
            'unlesbar', 'schema_version_unbekannt', 'slot_minutes_ungueltig',
            'keine_entitaeten', 'fremde_box')),
    CONSTRAINT plan_zustellung_form_chk CHECK (
        (urteil IS NULL AND grund IS NULL AND quittiert_um IS NULL AND empfangen_um IS NULL)
        OR (urteil = 'angenommen' AND grund IS NULL
            AND quittiert_um IS NOT NULL AND empfangen_um IS NOT NULL)
        OR (urteil = 'abgelehnt' AND grund IS NOT NULL
            AND quittiert_um IS NOT NULL AND empfangen_um IS NOT NULL))
);

CREATE INDEX plan_zustellung_device_generated
    ON plan_zustellung (device_id, generated_at DESC);

ALTER TABLE plan_zustellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_zustellung FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_zustellung_isolation ON plan_zustellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Die api schreibt nur die Quittung (Upsert); gelöscht wird ausschließlich über die Box.
GRANT SELECT, INSERT, UPDATE ON plan_zustellung TO ${appDbUser};
