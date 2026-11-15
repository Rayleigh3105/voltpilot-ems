-- =============================================================================
-- V20261115230000 - Steuerlogik Stufe 6, Zusammenführen: der Steuerweg je Anlage.
-- -----------------------------------------------------------------------------
-- Eine Regel des Regel-Baukastens lässt sich als Logik des Kerns ausführen
-- (docs/contracts/v2/steuerlogik.md, „Zusammenführen“). Die Regel bleibt, was
-- der Kunde bearbeitet; ihre Übersetzung ist eine abgeleitete Logik in
-- steuerlogik mit herkunft 'regel' und der Regel als herkunft_flow_id.
--
-- Keine Anlage wechselt still: steuerweg hält je Anlage den Schalter, ab Werk
-- 'alt' (ohne Zeile). 'mitlauf': die abgeleiteten Logiken laufen auf der Box
-- mit, der alte Weg (Node-RED) schaltet. 'kern': nach einem ausdrücklichen
-- Schritt schalten die abgeleiteten Logiken, der alte Weg ist für diese Regeln
-- aus dem Satz auf v2/flows genommen. Zurück auf 'alt' wirkt sofort.
-- Jeder Schritt steht in steuerweg_schritt (wer, wann, Rolle, welche Regeln).
--
-- Auf Edge Light gibt es für Regeln keinen alten Weg: dort läuft eine Regel,
-- sobald sie eingeschaltet wird, als abgeleitete Logik scharf.
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerweg (
    site_id   UUID        PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    modus     TEXT        NOT NULL CHECK (modus IN ('alt', 'mitlauf', 'kern')),
    seit      TIMESTAMPTZ NOT NULL,
    von       TEXT,
    rolle     TEXT
);

-- Der Löschzug zählt und löscht je tenant_id (LoeschzugIndexdeckungTest).
CREATE INDEX IF NOT EXISTS idx_steuerweg_tenant ON steuerweg (tenant_id, site_id);

CREATE TABLE IF NOT EXISTS steuerweg_schritt (
    id        UUID        PRIMARY KEY,
    tenant_id UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id   UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    was       TEXT        NOT NULL CHECK (was IN ('mitlauf', 'kern', 'zurueck')),
    am        TIMESTAMPTZ NOT NULL,
    von       TEXT,
    rolle     TEXT,
    daten     JSONB
);

CREATE INDEX IF NOT EXISTS idx_steuerweg_schritt_tenant ON steuerweg_schritt (tenant_id, site_id, am);

ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS herkunft TEXT;
ALTER TABLE steuerlogik DROP CONSTRAINT IF EXISTS steuerlogik_herkunft_check;
ALTER TABLE steuerlogik ADD CONSTRAINT steuerlogik_herkunft_check
    CHECK (herkunft IS NULL OR herkunft IN ('regel'));
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS herkunft_flow_id UUID;
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS herkunft_fassung INTEGER;
ALTER TABLE steuerlogik DROP CONSTRAINT IF EXISTS steuerlogik_herkunft_regel_check;
ALTER TABLE steuerlogik ADD CONSTRAINT steuerlogik_herkunft_regel_check
    CHECK ((herkunft IS NULL) = (herkunft_flow_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_steuerlogik_herkunft_flow ON steuerlogik (herkunft_flow_id)
    WHERE herkunft_flow_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON steuerweg         TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON steuerweg_schritt TO ${appDbUser};

ALTER TABLE steuerweg ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerweg FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerweg_isolation ON steuerweg;
CREATE POLICY steuerweg_isolation ON steuerweg
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerweg_schritt ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerweg_schritt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerweg_schritt_isolation ON steuerweg_schritt;
CREATE POLICY steuerweg_schritt_isolation ON steuerweg_schritt
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
