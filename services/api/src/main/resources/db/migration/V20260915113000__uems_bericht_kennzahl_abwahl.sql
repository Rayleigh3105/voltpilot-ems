-- =============================================================================
-- UEMS AP-12 IP-6: die Abwahl einer Kennzahl in einem Bericht (Q4, V3 — bericht.md §3/§4)
-- =============================================================================
-- Der Kunde wählt Vorlage, Geltung, Zeitraum und ABGEWÄHLTE Kennzahlen (V3); die
-- Abwahl ist ein Merkmal des Berichts, nicht der Vorlage. Sie liegt dort, wo sie
-- GELESEN wird: die Bildung des Abzugs (BerichtAbzugBildung) lässt eine abgewählte
-- Kennzahl weg.
--
-- Das FEHLEN einer Zeile heißt „gewählt“. Ohne jede Zeile enthält der Abzug alle
-- Kennzahlen seiner Geltung — wer die Tabelle (noch) nicht schreibt, ändert nichts.
--
-- Wieder wählen hebt die Abwahl auf (aufgehoben_am, genau einmal); niemand löscht
-- eine Zeile — nur das Offboarding räumt ab (TenantRepository.offboard).
-- Die Kennzahl steht als Kennung OHNE Fremdschlüssel (wie bericht_quelle.objekt_id):
-- das Löschen einer Kennzahl (uems_kennzahl_loeschen) wird dadurch nicht enger.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bericht_kennzahl_abwahl (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    bericht_id           UUID        NOT NULL,
    kennzahl_id          UUID        NOT NULL,
    abgewaehlt_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    abgewaehlt_von_sub   TEXT,
    abgewaehlt_von_name  TEXT        NOT NULL,
    -- NULL = die Abwahl wirkt; gesetzt = die Kennzahl ist wieder gewählt.
    aufgehoben_am        TIMESTAMPTZ,
    CONSTRAINT bericht_kennzahl_abwahl_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bericht_kennzahl_abwahl_bericht_fk FOREIGN KEY (bericht_id, tenant_id)
        REFERENCES bericht (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bericht_kennzahl_abwahl_von_chk
        CHECK (btrim(abgewaehlt_von_name) <> '' AND (abgewaehlt_von_sub IS NULL OR abgewaehlt_von_sub <> '')),
    CONSTRAINT bericht_kennzahl_abwahl_aufgehoben_chk
        CHECK (aufgehoben_am IS NULL OR aufgehoben_am >= abgewaehlt_am)
);

-- Je Bericht und Kennzahl höchstens EINE wirksame Abwahl; tenant_id vorn, weil der
-- Index vor jeder RLS prüft.
CREATE UNIQUE INDEX IF NOT EXISTS bericht_kennzahl_abwahl_wirksam_uq
    ON bericht_kennzahl_abwahl (tenant_id, bericht_id, kennzahl_id) WHERE aufgehoben_am IS NULL;

-- Eine aufgehobene Abwahl bleibt, wie sie ist: wer wieder abwählt, legt eine neue Zeile an.
CREATE OR REPLACE FUNCTION bericht_kennzahl_abwahl_einmal_aufheben()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.aufgehoben_am IS NOT NULL THEN
        RAISE EXCEPTION 'bericht_kennzahl_abwahl_aufgehoben: eine aufgehobene Abwahl bleibt, wie sie ist'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_kennzahl_abwahl_aufgehoben';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bericht_kennzahl_abwahl_einmal_aufheben ON bericht_kennzahl_abwahl;
CREATE TRIGGER bericht_kennzahl_abwahl_einmal_aufheben
    BEFORE UPDATE ON bericht_kennzahl_abwahl
    FOR EACH ROW EXECUTE FUNCTION bericht_kennzahl_abwahl_einmal_aufheben();

ALTER TABLE bericht_kennzahl_abwahl ENABLE ROW LEVEL SECURITY;
ALTER TABLE bericht_kennzahl_abwahl FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bericht_kennzahl_abwahl_tenant_isolation ON bericht_kennzahl_abwahl;
CREATE POLICY bericht_kennzahl_abwahl_tenant_isolation ON bericht_kennzahl_abwahl
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben. Kein DELETE für die
-- Anwendung; die Verwaltungsrolle liest (Kaskade IP-8, Strukturläufer IP-9 bilden
-- den Entwurf neu) und räumt im Offboarding ab.
-- -----------------------------------------------------------------------------
REVOKE ALL ON bericht_kennzahl_abwahl FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bericht_kennzahl_abwahl TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON bericht_kennzahl_abwahl TO ${appDbUser};
GRANT SELECT, DELETE ON bericht_kennzahl_abwahl TO ${adminDbUser};

COMMENT ON TABLE bericht_kennzahl_abwahl IS
    'UEMS AP-12 IP-6: abgewählte Kennzahlen eines Berichts (Q4, V3). Keine Zeile = gewählt; '
    'die Bildung des Abzugs lässt eine wirksam abgewählte Kennzahl weg.';
