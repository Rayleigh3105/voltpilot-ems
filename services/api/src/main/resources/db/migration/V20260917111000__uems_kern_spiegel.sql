-- AP-07 IP-17: only proven core/catalog mirrors receive an annotation.
-- Existing rows remain NULL (no backfill, default, new FK or rollup change).
-- The cloud writer owns this metadata; no registry/measurement-config wire change.
ALTER TABLE telemetry_v2 ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE telemetry_v2 ADD COLUMN IF NOT EXISTS spiegel_point_key TEXT;
ALTER TABLE telemetry_v2 ADD CONSTRAINT telemetry_v2_kern_spiegel_chk
    CHECK ((role IS NULL AND spiegel_point_key IS NULL)
        OR coalesce(role = 'spiegel' AND length(spiegel_point_key) > 0, false));

COMMENT ON COLUMN telemetry_v2.role IS
    'Cloud-only Kern/Katalog-Spiegel: spiegel nur bei belegtem identischem Register '
    'derselben Komponente und zeitgueltiger Messauswahl. NULL = keine solche Aussage.';
COMMENT ON COLUMN telemetry_v2.spiegel_point_key IS
    'Der Katalogpunkt, der den Kern-Kanal zur Messzeit spiegelt; keine zweite Messreihe. '
    'Betriebliche Kern-Rollups bleiben unveraendert; UEMS liest seine fuehrenden Quellenbindungen.';
-- Existing table-level SELECT/INSERT grants and FORCE RLS cover both nullable columns.
