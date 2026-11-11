-- =============================================================================
-- Plattform-Admin: Box ausbauen, direkt statt über den Mandantensprung
-- (vp-admin-box-ausbauen, Captain-Auftrag 11.11.2026).
--
-- Bisher konnte eine Box MIT Daten nur der Kunde selbst entfernen
-- (DELETE /api/v1/devices/{id}, UEMS AP-07 E8) - der Plattform-Admin kam an
-- diesen Fall nur über den Umweg "Wie der Kunde es sieht" (Mandantensprung).
-- Dieser Weg ruft DIESELBE Ausbau-Logik (DeviceRepository#ausbauen,
-- BoxAusbauenService) über eine zweite Route; nichts an "Gerät entfernen"
-- ändert sich. Die Box bleibt AUSGEBAUT (device.ausgebaut_am), kein
-- Datenbestand geht verloren (Captain 13.09.2026).
--
-- box_ausbauen_protokoll: wer wann welche Box welches Kunden/welcher Anlage
-- (zum Zeitpunkt) ausgebaut hat, mit Anlass - derselbe geschlossene Anlass-
-- Vokabular wie "Vom Kunden lösen" (V20261110090000, der Picker ist derselbe).
-- Append-only wie box_loesen_protokoll; genau EIN Eintrag je Geräte-ID (eine
-- einmal ausgebaute Box - der Trigger device_ausgebaut_endgueltig verweigert
-- das Zurücknehmen - kann von diesem Weg nie zweimal protokolliert werden;
-- die Wiederholung antwortet idempotent aus diesem Eintrag).
-- =============================================================================

CREATE TABLE IF NOT EXISTS box_ausbauen_protokoll (
    id                  BIGSERIAL   PRIMARY KEY,
    tenant_id           UUID        NOT NULL,
    tenant_name         TEXT        NOT NULL,
    site_id             UUID,
    site_name           TEXT        NOT NULL,
    device_id           UUID        NOT NULL,
    external_ref        TEXT        NOT NULL,
    verbunden_am        TIMESTAMPTZ NOT NULL,
    ausgebaut_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ausgebaut_von_sub   TEXT,
    ausgebaut_von_name  TEXT        NOT NULL,
    anlass              TEXT        NOT NULL,
    anlass_text         TEXT,
    CONSTRAINT box_ausbauen_protokoll_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT box_ausbauen_protokoll_site_fk FOREIGN KEY (site_id)
        REFERENCES site (id) ON DELETE SET NULL,
    CONSTRAINT box_ausbauen_protokoll_anlass_chk
        CHECK (anlass IN ('falsche_kennung', 'fremder_kunde', 'doppelt_verbunden', 'anderer_anlass')),
    CONSTRAINT box_ausbauen_protokoll_anlass_text_chk
        CHECK ((anlass = 'anderer_anlass') = (anlass_text IS NOT NULL AND btrim(anlass_text) <> '')),
    CONSTRAINT box_ausbauen_protokoll_von_chk CHECK (btrim(ausgebaut_von_name) <> ''),
    CONSTRAINT box_ausbauen_protokoll_namen_chk
        CHECK (btrim(tenant_name) <> '' AND btrim(site_name) <> '')
);

-- Idempotenz: dieselbe Geräte-ID wird nie zweimal protokolliert - der zweite Aufruf (Doppelklick,
-- Wiederholung nach Netzfehler) antwortet aus dem vorhandenen Eintrag.
CREATE UNIQUE INDEX IF NOT EXISTS uq_box_ausbauen_protokoll_device
    ON box_ausbauen_protokoll (device_id);
-- Die Geräteakte (Admin, BYPASSRLS) nach Referenz.
CREATE INDEX IF NOT EXISTS idx_box_ausbauen_protokoll_ref
    ON box_ausbauen_protokoll (external_ref, ausgebaut_am DESC);
CREATE INDEX IF NOT EXISTS idx_box_ausbauen_protokoll_tenant
    ON box_ausbauen_protokoll (tenant_id, ausgebaut_am DESC);

ALTER TABLE box_ausbauen_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_ausbauen_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS box_ausbauen_protokoll_tenant_isolation ON box_ausbauen_protokoll;
CREATE POLICY box_ausbauen_protokoll_tenant_isolation ON box_ausbauen_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON box_ausbauen_protokoll FROM ${appDbUser}, ${adminDbUser};
-- Der Admin-Weg schreibt mit gesetztem Mandanten-Kontext über DIESE Rolle (Mandantentrennung,
-- Muster BenutzerService.erster) - nie über die BYPASSRLS-Rolle.
GRANT SELECT, INSERT ON box_ausbauen_protokoll TO ${appDbUser};
-- Die Geräteakte liest über jeden Mandanten hinweg (BYPASSRLS); das Offboarding räumt ab.
GRANT SELECT, DELETE ON box_ausbauen_protokoll TO ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE box_ausbauen_protokoll_id_seq TO ${appDbUser};

COMMENT ON TABLE box_ausbauen_protokoll IS
    'Vom Plattform-Admin ausgebaut (vp-admin-box-ausbauen): append-only, wie box_loesen_protokoll. '
    'Genau ein Eintrag je Geraete-ID - eine ausgebaute Box wird nie zweimal protokolliert.';
