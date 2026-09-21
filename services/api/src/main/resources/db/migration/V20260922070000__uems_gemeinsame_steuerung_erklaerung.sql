-- =============================================================================
-- UEMS AP-15 Folge vor IP-23 — die ERKLÄRUNG der Gemeinsamen Steuerung über die
-- Kundenroute (Konzept vp-uems-ap15-verbund §5.2 Frage 4, B3/B4, G3, I1;
-- Vertrag docs/contracts/v2/steuerungsverbund.md §6a).
--
--   steuerungsverbund_erzeuger   die Erzeuger hinter dem Netzanschluss, die KEINE
--       Box steuert (Frage 4), je Zeile Bezeichnung und Nennleistung > 0. Ihre
--       Summe ist der Vorbehalt der Einspeiseseite
--       (steuerungsverbund.vorbehalt_einspeisung_kw, IP-7). „keine“ = der
--       Vorbehalt der Einspeiseseite ist 0 und es gibt keine wirksame Zeile;
--       nicht erklärt = der Vorbehalt ist leer (unbekannt ist keine Null).
--       Aufheben statt ändern (wer/wann bleibt lesbar).
--   steuerungsverbund_aenderung  art + 'geraete' (die Geräte einer Box, alt/neu
--       = {box_id, geraete}) + 'erzeuger' (alt/neu = die Liste oder "keine").
--
-- Die Geräte je Box (steuerungsverbund_geraet, IP-7) und der Vorbehalt am Verbund
-- (IP-7/IP-13) haben ihre Tabellen schon; neu ist nur, dass eine Route sie füllt.
--
-- ⚠ Der art-CHECK des Protokolls ist die VEREINIGUNG aller Wörter, die bis
-- hierher gebaut sind (IP-4 V20260921140000, IP-13 V20260921230000 'vorbehalt',
-- G6 V20260922030000 'vorgabe_signal') plus 'geraete' und 'erzeuger'. Wer ihn
-- später erweitert, schreibt wieder die Vereinigung — nie nur seinen Stand.
--
-- ⚠ REIN ADDITIV: eine neue, leere Tabelle; es wird KEINE Zeile angelegt oder
-- geändert. Eine Anlage ohne Gemeinsame Steuerung merkt nichts (I6). Idempotent
-- (IF NOT EXISTS), damit die Reihenfolge der Ankunft keine Rolle spielt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerungsverbund_erzeuger (
    id                   UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID           NOT NULL,
    steuerungsverbund_id UUID           NOT NULL,
    site_id              UUID           NOT NULL,
    bezeichnung          TEXT           NOT NULL,
    nenn_kw              NUMERIC(12, 3) NOT NULL,
    aufgehoben_am        TIMESTAMPTZ,
    created_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
    created_by           TEXT           NOT NULL,
    CONSTRAINT steuerungsverbund_erzeuger_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_erzeuger_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_erzeuger_nenn_chk CHECK (nenn_kw > 0),
    CONSTRAINT steuerungsverbund_erzeuger_bezeichnung_chk CHECK (btrim(bezeichnung) <> ''),
    CONSTRAINT steuerungsverbund_erzeuger_wer_chk CHECK (btrim(created_by) <> '')
);

CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_erzeuger_verbund
    ON steuerungsverbund_erzeuger (steuerungsverbund_id) WHERE aufgehoben_am IS NULL;

ALTER TABLE steuerungsverbund_erzeuger ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_erzeuger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_erzeuger_tenant_isolation ON steuerungsverbund_erzeuger;
CREATE POLICY steuerungsverbund_erzeuger_tenant_isolation ON steuerungsverbund_erzeuger
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: ALTER DEFAULT PRIVILEGES gibt alles — hier wird alles genommen und eng neu gegeben. Erzeuger werden
-- aufgehoben statt geändert. Das Offboarding (TenantRepository.offboard) räumt sie vor dem Verbund ab.
REVOKE ALL ON steuerungsverbund_erzeuger FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_erzeuger TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON steuerungsverbund_erzeuger TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_erzeuger TO ${adminDbUser};

ALTER TABLE steuerungsverbund_aenderung DROP CONSTRAINT IF EXISTS steuerungsverbund_aenderung_art_chk;
ALTER TABLE steuerungsverbund_aenderung ADD CONSTRAINT steuerungsverbund_aenderung_art_chk
    CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt', 'vorbehalt', 'vorgabe_signal',
                   'geraete', 'erzeuger'));

COMMENT ON TABLE steuerungsverbund_erzeuger IS
    'UEMS AP-15 Frage 4: Erzeuger hinter dem Netzanschluss, die keine Box steuert (Nennleistung > 0); Summe = Vorbehalt der Einspeiseseite. keine = Vorbehalt 0 ohne Zeile; aufheben statt aendern.';
