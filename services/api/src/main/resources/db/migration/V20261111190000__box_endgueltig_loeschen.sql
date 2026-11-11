-- =============================================================================
-- Plattform-Admin: eine AUSGEBAUTE Box endgültig löschen (vp-box-endgueltig-
-- loeschen; Captain 11.11.2026: endgültig löschbar, wenn die Box nie Daten
-- geliefert hat - kein Herzschlag, keine Messwerte, keine Belege).
--
-- Der vierte Löschweg neben Abmelden, Purge und Anlage entfernen
-- (docs/agents/root/uems-loeschwege.md). Was „keine Daten" heißt, steht EINMAL
-- in der Anwendung (BoxDatenBestand, je Datenart geprüft von
-- BoxEndgueltigLoeschenMigrationTest); die Sicherheit hängt wie beim „Vom
-- Kunden lösen" (V20261110090000) nicht an dieser Aufzählung allein: jede
-- Messwert-Tabelle verweist mit ON DELETE RESTRICT auf device (V20260913150000),
-- fände sich doch eine Zeile, lehnt die Datenbank das DELETE selbst ab und der
-- Dienst übersetzt das in denselben 409. Werkstatt, Fernwartung und die
-- Zertifikats-Historie (device_enrollment) tragen keinen Fremdschlüssel auf
-- device und bleiben dadurch von selbst erhalten; die Kennung bleibt wieder
-- anmeldbar wie heute nach dem Ausbau (uq_device_external_ref ist partiell).
--
-- box_endgueltig_geloescht_protokoll: wer wann welche ausgebaute Box welches
-- Kunden endgültig gelöscht hat, mit dem geprüften Befund zum Zeitpunkt.
-- Append-only wie box_loesen_protokoll; tenant_name/site_name sind Abschriften
-- („Kunde/Anlage zum Zeitpunkt"), site_id verliert sich beim Löschen der
-- Anlage (SET NULL). Genau EIN Eintrag je Geräte-ID: die Wiederholung desselben
-- Löschens antwortet aus diesem Eintrag (Idempotenz), nie mit einem zweiten.
-- =============================================================================

CREATE TABLE IF NOT EXISTS box_endgueltig_geloescht_protokoll (
    id                  BIGSERIAL   PRIMARY KEY,
    tenant_id           UUID        NOT NULL,
    tenant_name         TEXT        NOT NULL,
    site_id             UUID,
    site_name           TEXT        NOT NULL,
    device_id           UUID        NOT NULL,
    external_ref        TEXT        NOT NULL,
    verbunden_am        TIMESTAMPTZ NOT NULL,
    ausgebaut_am        TIMESTAMPTZ NOT NULL,
    geloescht_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    geloescht_von_sub   TEXT,
    geloescht_von_name  TEXT        NOT NULL,
    befund              JSONB       NOT NULL,
    CONSTRAINT box_endgueltig_protokoll_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT box_endgueltig_protokoll_site_fk FOREIGN KEY (site_id)
        REFERENCES site (id) ON DELETE SET NULL,
    CONSTRAINT box_endgueltig_protokoll_von_chk CHECK (btrim(geloescht_von_name) <> ''),
    CONSTRAINT box_endgueltig_protokoll_namen_chk
        CHECK (btrim(tenant_name) <> '' AND btrim(site_name) <> '')
);

-- Idempotenz: dieselbe Geräte-ID wird nie zweimal gelöscht - der zweite Aufruf
-- antwortet aus dem vorhandenen Eintrag.
CREATE UNIQUE INDEX IF NOT EXISTS uq_box_endgueltig_protokoll_device
    ON box_endgueltig_geloescht_protokoll (device_id);
-- Die Geräteakte (Admin, BYPASSRLS) nach Referenz.
CREATE INDEX IF NOT EXISTS idx_box_endgueltig_protokoll_ref
    ON box_endgueltig_geloescht_protokoll (external_ref, geloescht_am DESC);
CREATE INDEX IF NOT EXISTS idx_box_endgueltig_protokoll_tenant
    ON box_endgueltig_geloescht_protokoll (tenant_id, geloescht_am DESC);

ALTER TABLE box_endgueltig_geloescht_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_endgueltig_geloescht_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS box_endgueltig_protokoll_tenant_isolation ON box_endgueltig_geloescht_protokoll;
CREATE POLICY box_endgueltig_protokoll_tenant_isolation ON box_endgueltig_geloescht_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON box_endgueltig_geloescht_protokoll FROM ${appDbUser}, ${adminDbUser};
-- Geschrieben wird mit gesetztem Mandanten-Kontext über DIESE Rolle (Mandantentrennung,
-- Muster BenutzerService.erster) - nie über die BYPASSRLS-Rolle.
GRANT SELECT, INSERT ON box_endgueltig_geloescht_protokoll TO ${appDbUser};
-- Die Geräteakte liest über jeden Mandanten hinweg (BYPASSRLS); das Offboarding räumt ab
-- (TenantRepository.offboard).
GRANT SELECT, DELETE ON box_endgueltig_geloescht_protokoll TO ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE box_endgueltig_geloescht_protokoll_id_seq TO ${appDbUser};

COMMENT ON TABLE box_endgueltig_geloescht_protokoll IS
    'Endgueltig geloescht (vierter Loeschweg, vp-box-endgueltig-loeschen): append-only. '
    'BoxDatenBestand nennt die Regel, nach der geloescht_am entstehen darf; genau ein Eintrag je Box.';
