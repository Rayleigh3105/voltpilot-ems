-- =============================================================================
-- Edge Light K2 (Konzept vp-edge-light-update, U-4 A): die gepackten Programme
-- eines signierten Edge-Light-Release liegen im Portal und sind offen abrufbar.
--
--   release_seq  das Release im Register (edge_release); geht mit ihm
--   arch         die Plattform wie im Manifest (linux/mipsle, linux/arm64)
--   gz_sha256,   Prüfsumme und Größe der gepackten Lieferung, ABGESCHRIEBEN
--   gz_size      aus dem signierten Manifest beim ersten Teil - nie vom
--                Hochladenden genannt
--   daten        die Bytes; wachsen Teil für Teil (der Release-Lauf lädt in
--                Teilen, damit kein Proxy-Größenlimit greift)
--   fertig_am    gesetzt erst, wenn daten genau gz_size Bytes hat UND die
--                Prüfsumme gz_sha256 ist. Nur dann liefert die offene Route aus.
--
-- Die Echtheit entsteht nicht hier: die Box prüft das Manifest gegen ihre
-- eingebackene Wurzel und den Download gegen gz_sha256 aus diesem Manifest.
-- Plattform-Betriebsdatum wie edge_release, kein Kundendatum: die App-Rolle
-- liest und schreibt nicht (Zugriff über die Admin-Verbindung).
-- =============================================================================

CREATE TABLE IF NOT EXISTS edge_light_programm (
    release_seq BIGINT      NOT NULL REFERENCES edge_release (release_seq) ON DELETE CASCADE,
    arch        TEXT        NOT NULL CHECK (arch ~ '^[a-z0-9]+/[a-z0-9]+(/[a-z0-9]+)?$'),
    gz_sha256   TEXT        NOT NULL CHECK (gz_sha256 ~ '^[0-9a-f]{64}$'),
    gz_size     BIGINT      NOT NULL CHECK (gz_size > 0),
    daten       BYTEA       NOT NULL DEFAULT ''::bytea,
    fertig_am   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT,
    PRIMARY KEY (release_seq, arch),
    CHECK (fertig_am IS NULL OR octet_length(daten) = gz_size)
);

CREATE INDEX IF NOT EXISTS edge_light_programm_fertig_sha
    ON edge_light_programm (gz_sha256) WHERE fertig_am IS NOT NULL;

REVOKE ALL ON edge_light_programm FROM ${appDbUser};
