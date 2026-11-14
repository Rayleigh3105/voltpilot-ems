-- =============================================================================
-- V20261114200000 - Steuerlogik Stufe 3: scharf schalten, Stellwerte, Protokoll.
-- -----------------------------------------------------------------------------
-- steuerlogik bekommt den Zustand 'scharf': die Box gibt die Wünsche dieser
-- Fassung an den Schiedsrichter (docs/contracts/v2/steuerlogik.md "Scharf").
-- Je Logik ist höchstens EINE Fassung aktiv - mitlaufend oder scharf; der
-- eindeutige Index aus V20261114180000 wird dafür ersetzt. Das Artefakt einer
-- Zeile ist immer das, was gerade ausgeliefert wird (mit armed und den
-- gestellten Werten); scharf_am/scharf_von halten den protokollierten Schritt,
-- hinweise die Hinweise, die im Dialog standen und mit der einen Bestätigung
-- an der Fassung gespeichert sind (E5 = C).
--
-- steuerlogik_einstellung: je Logik die gestellten Werte (Form des Dokuments,
-- JSON-Objekt als TEXT wie die übrigen Texte der Logik) und ihr Stand. Ein
-- Wert ist keine Fassung: er reist im Bündel neben dem Text und startet die
-- Logik nicht neu; der Stand zählt jede Änderung, die Box meldet ihn zurück.
--
-- steuerlogik_protokoll: was Menschen an einer Logik getan haben - angenommen,
-- scharf geschaltet, zurückgenommen, stillgelegt, einen Wert gestellt - mit
-- wer, wann, Rolle und den Daten dahinter (Bericht 8.6, 8.9).
--
-- steuerlogik_lauf kennt den gemeldeten Zustand 'scharf'.
--
-- Mandantenbezogen mit RLS wie die Tabellen aus V20261114180000.
-- =============================================================================

ALTER TABLE steuerlogik DROP CONSTRAINT IF EXISTS steuerlogik_zustand_check;
ALTER TABLE steuerlogik ADD CONSTRAINT steuerlogik_zustand_check
    CHECK (zustand IN ('mitlaufend', 'scharf', 'stillgelegt'));

ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS scharf_am  TIMESTAMPTZ;
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS scharf_von TEXT;
ALTER TABLE steuerlogik ADD COLUMN IF NOT EXISTS hinweise   JSONB;

DROP INDEX IF EXISTS uq_steuerlogik_eine_mitlaufende;
CREATE UNIQUE INDEX IF NOT EXISTS uq_steuerlogik_eine_aktive
    ON steuerlogik (logik_id) WHERE zustand IN ('mitlaufend', 'scharf');

ALTER TABLE steuerlogik_lauf DROP CONSTRAINT IF EXISTS steuerlogik_lauf_zustand_check;
ALTER TABLE steuerlogik_lauf ADD CONSTRAINT steuerlogik_lauf_zustand_check
    CHECK (zustand IN ('mitlaufend', 'scharf'));

CREATE TABLE IF NOT EXISTS steuerlogik_einstellung (
    logik_id     UUID        PRIMARY KEY,
    tenant_id    UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id      UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    stand        BIGINT      NOT NULL CHECK (stand >= 0),
    werte        TEXT        NOT NULL,
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_einstellung_site ON steuerlogik_einstellung (site_id);

CREATE TABLE IF NOT EXISTS steuerlogik_protokoll (
    id        UUID        PRIMARY KEY,
    tenant_id UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id   UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    logik_id  UUID        NOT NULL,
    fassung   INTEGER     NOT NULL CHECK (fassung >= 1),
    was       TEXT        NOT NULL CHECK (was IN ('angenommen', 'scharf', 'zurueck', 'stillgelegt', 'stellwert')),
    am        TIMESTAMPTZ NOT NULL,
    von       TEXT,
    von_name  TEXT,
    rolle     TEXT,
    daten     JSONB
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_protokoll_logik_am ON steuerlogik_protokoll (logik_id, am);
CREATE INDEX IF NOT EXISTS idx_steuerlogik_protokoll_site ON steuerlogik_protokoll (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON steuerlogik_einstellung TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON steuerlogik_protokoll   TO ${appDbUser};

ALTER TABLE steuerlogik_einstellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik_einstellung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_einstellung_isolation ON steuerlogik_einstellung;
CREATE POLICY steuerlogik_einstellung_isolation ON steuerlogik_einstellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerlogik_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_protokoll_isolation ON steuerlogik_protokoll;
CREATE POLICY steuerlogik_protokoll_isolation ON steuerlogik_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
