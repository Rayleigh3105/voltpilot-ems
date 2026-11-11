-- =============================================================================
-- Plattform-Admin: Box vom Kunden lösen (Konzept vp-plattform-admin-box-
-- benutzer-konzept, Teil 1, Abschnitt 3.3; Captain-Entscheide B1=A, B2=A,
-- B3=A, B4=A vom 10.11.2026).
--
-- Anders als „Gerät entfernen" (Kunde, UEMS AP-07 E8: die Box wird AUSGEBAUT,
-- die Zeile bleibt für immer) löscht „Vom Kunden lösen" die Verknüpfung, ALS
-- WÄRE SIE NIE GEWESEN — nur erlaubt, solange die Box sich nie gemeldet hat
-- (BoxLoesenRegel, docs/contracts/box-loesen-vectors.json). Die Sicherheit
-- dieser Löschung hängt NICHT an einer vollständigen Aufzählung jeder
-- Box-Daten-Tabelle in der Anwendung: die Messwert-Tabellen verweisen schon
-- heute mit ON DELETE RESTRICT auf device (V20260913150000) — fände sich
-- doch eine Zeile, lehnt die Datenbank das Löschen selbst ab, und der Dienst
-- übersetzt den Fremdschlüssel-Fehler in denselben 409. Die Vollständigkeit
-- dieser Rückversicherung prüft BoxLoesenTabellenInventarTest gegen das
-- tatsächliche Schema (jede Tabelle mit einer Spalte device_id).
--
-- box_loesen_protokoll: wer wann welche Box von welchem Kunden gelöst hat,
-- mit Anlass und dem Befund zum Zeitpunkt (Abschnitt 3.3 Punkt 6). Append-
-- only wie zugriff_protokoll; site_id verliert sich beim Löschen der Anlage
-- (SET NULL, der Eintrag bleibt als Verlauf — site_name ist die Abschrift).
--
-- Gleich mit L5 (device.verbunden_von_sub/-name): heute nennt das Verbinden
-- keinen Urheber, nur device.created_at (Nebenbefund N7). Additiv, NULL für
-- jede heutige Box.
-- =============================================================================

ALTER TABLE device ADD COLUMN IF NOT EXISTS verbunden_von_sub TEXT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS verbunden_von_name TEXT;
GRANT SELECT (verbunden_von_sub, verbunden_von_name), UPDATE (verbunden_von_sub, verbunden_von_name)
    ON device TO ${appDbUser};
COMMENT ON COLUMN device.verbunden_von_name IS
    'Der Urheber des Verbindens (ProtokollAkteur), additiv - NULL fuer jede Box vor dieser Migration (N7).';

CREATE TABLE IF NOT EXISTS box_loesen_protokoll (
    id                  BIGSERIAL   PRIMARY KEY,
    tenant_id           UUID        NOT NULL,
    site_id             UUID,
    site_name           TEXT        NOT NULL,
    device_id           UUID        NOT NULL,
    external_ref        TEXT        NOT NULL,
    verbunden_am        TIMESTAMPTZ NOT NULL,
    geloest_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    geloest_von_sub     TEXT,
    geloest_von_name    TEXT        NOT NULL,
    geloest_art         TEXT        NOT NULL,
    anlass              TEXT        NOT NULL,
    anlass_text         TEXT,
    befund              JSONB       NOT NULL,
    CONSTRAINT box_loesen_protokoll_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT box_loesen_protokoll_site_fk FOREIGN KEY (site_id)
        REFERENCES site (id) ON DELETE SET NULL,
    CONSTRAINT box_loesen_protokoll_art_chk CHECK (geloest_art IN ('plattform', 'kunde')),
    CONSTRAINT box_loesen_protokoll_anlass_chk
        CHECK (anlass IN ('falsche_kennung', 'fremder_kunde', 'doppelt_verbunden', 'anderer_anlass')),
    CONSTRAINT box_loesen_protokoll_anlass_text_chk
        CHECK ((anlass = 'anderer_anlass') = (anlass_text IS NOT NULL AND btrim(anlass_text) <> '')),
    CONSTRAINT box_loesen_protokoll_von_chk
        CHECK (btrim(geloest_von_name) <> '' AND (geloest_von_sub IS NOT NULL OR geloest_art = 'plattform'))
);

-- Die Kundenakte je Box (L2) und der Hinweis beim Kunden (L3, höchstens 14 Tage).
CREATE INDEX IF NOT EXISTS idx_box_loesen_protokoll_site
    ON box_loesen_protokoll (site_id, geloest_am DESC) WHERE site_id IS NOT NULL;
-- Die Geräteakte (Admin, BYPASSRLS) nach Referenz.
CREATE INDEX IF NOT EXISTS idx_box_loesen_protokoll_ref
    ON box_loesen_protokoll (external_ref, geloest_am DESC);
CREATE INDEX IF NOT EXISTS idx_box_loesen_protokoll_tenant
    ON box_loesen_protokoll (tenant_id, geloest_am DESC);

ALTER TABLE box_loesen_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_loesen_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS box_loesen_protokoll_tenant_isolation ON box_loesen_protokoll;
CREATE POLICY box_loesen_protokoll_tenant_isolation ON box_loesen_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON box_loesen_protokoll FROM ${appDbUser}, ${adminDbUser};
-- Der Admin-Weg schreibt mit gesetztem Mandanten-Kontext über DIESE Rolle (Mandantentrennung,
-- Muster BenutzerService.erster) - nie über die BYPASSRLS-Rolle.
GRANT SELECT, INSERT ON box_loesen_protokoll TO ${appDbUser};
-- Die Geräteakte liest über jeden Mandanten hinweg (BYPASSRLS); das Offboarding räumt ab.
GRANT SELECT, DELETE ON box_loesen_protokoll TO ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE box_loesen_protokoll_id_seq TO ${appDbUser};

COMMENT ON TABLE box_loesen_protokoll IS
    'Vom Kunden gelöst (L1, B1=A): append-only, wie zugriff_protokoll. '
    'docs/contracts/box-loesen-vectors.json nennt die Regel, nach der geloest_am entstehen darf.';
