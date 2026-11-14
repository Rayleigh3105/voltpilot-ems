-- =============================================================================
-- V20261114180000 - Steuerlogik Stufe 2, zweiter Teil: Auslieferung und Mitlauf.
-- -----------------------------------------------------------------------------
-- steuerlogik: je (logik_id, fassung) eine Logik, wie VoltPilot sie als Datei
-- angenommen hat (docs/contracts/v2/steuerlogik.md). Der Dienst neben der API
-- liest und prüft sie und baut das Artefakt; hier liegen der Text, wie er kam,
-- die kanonische Form und das Artefakt als TEXT, nicht als JSONB: JSONB ordnet
-- Schlüssel um, und die Reihenfolge unter states ist die Reihenfolge der
-- Auswertung. Das Artefakt bleibt so Byte für Byte, was der Dienst gebaut hat.
-- logik_id ist die flow_id des Artefakts im Satz auf v2/flows. Höchstens eine
-- Fassung je Logik läuft mit.
--
-- steuerlogik_lauf: der jüngste Block "logik" des Herzschlags je Box und
-- Logik (steuerlogik-rueckmeldung.md), ersetzt mit jedem Herzschlag.
-- steuerlogik_wechsel: das Vergleichsprotokoll "würde schalten" gegen "ist
-- geschaltet" über die Zeit, je Zeile ein Wechsel; Schlüssel ist der Lauf
-- (seit) und seine laufende Nummer, so dass ein wiederholter Herzschlag
-- nichts doppelt schreibt und eine Lücke sichtbar bleibt. Der Eingang hält
-- es auf 90 Tage.
--
-- Mandantenbezogen mit RLS wie flow_definition und flow_device_ack.
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerlogik (
    logik_id       UUID        NOT NULL,
    fassung        INTEGER     NOT NULL CHECK (fassung >= 1),
    tenant_id      UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id        UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    quelltext      TEXT        NOT NULL,
    kanonisch      TEXT        NOT NULL,
    artefakt       TEXT        NOT NULL,
    content_hash   TEXT        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
    bericht        JSONB       NOT NULL,
    zustand        TEXT        NOT NULL CHECK (zustand IN ('mitlaufend', 'stillgelegt')),
    angelegt_am    TIMESTAMPTZ NOT NULL DEFAULT now(),
    angelegt_von   TEXT,
    stillgelegt_am TIMESTAMPTZ,
    PRIMARY KEY (logik_id, fassung)
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_site ON steuerlogik (site_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_steuerlogik_eine_mitlaufende
    ON steuerlogik (logik_id) WHERE zustand = 'mitlaufend';

CREATE TABLE IF NOT EXISTS steuerlogik_lauf (
    device_id    UUID        NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    logik_id     UUID        NOT NULL,
    tenant_id    UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id      UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    fassung      INTEGER     NOT NULL,
    content_hash TEXT        NOT NULL,
    zustand      TEXT        NOT NULL CHECK (zustand IN ('mitlaufend')),
    seit         TIMESTAMPTZ NOT NULL,
    rueckmeldung JSONB       NOT NULL,
    gemeldet_am  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, logik_id)
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_lauf_site ON steuerlogik_lauf (site_id);

CREATE TABLE IF NOT EXISTS steuerlogik_wechsel (
    device_id UUID        NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    logik_id  UUID        NOT NULL,
    lauf_seit TIMESTAMPTZ NOT NULL,
    nr        BIGINT      NOT NULL CHECK (nr >= 1),
    tenant_id UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id   UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    fassung   INTEGER     NOT NULL,
    t         TIMESTAMPTZ NOT NULL,
    geraet    TEXT        NOT NULL,
    was       TEXT        NOT NULL CHECK (was IN ('wunsch', 'ist')),
    neu       JSONB,
    andere    JSONB,
    lage      TEXT,
    PRIMARY KEY (device_id, logik_id, lauf_seit, nr)
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_wechsel_logik_t ON steuerlogik_wechsel (logik_id, t);
CREATE INDEX IF NOT EXISTS idx_steuerlogik_wechsel_site ON steuerlogik_wechsel (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON steuerlogik         TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON steuerlogik_lauf    TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON steuerlogik_wechsel TO ${appDbUser};

ALTER TABLE steuerlogik ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_isolation ON steuerlogik;
CREATE POLICY steuerlogik_isolation ON steuerlogik
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerlogik_lauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik_lauf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_lauf_isolation ON steuerlogik_lauf;
CREATE POLICY steuerlogik_lauf_isolation ON steuerlogik_lauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerlogik_wechsel ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik_wechsel FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_wechsel_isolation ON steuerlogik_wechsel;
CREATE POLICY steuerlogik_wechsel_isolation ON steuerlogik_wechsel
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
