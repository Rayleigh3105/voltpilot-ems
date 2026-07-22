-- MIG (v1 -> v2 automatic entity migration, report §6): the backfill MARKER.
--
-- The api's V2SiteBackfillRunner composes the v2 pilot entities of every site
-- on boot. Without a marker the design is broken in exactly one place: the
-- documented rollback (delete the site's entity rows) would be silently undone
-- by the next api restart. So the runner only touches sites where this column
-- is NULL and stamps it on success - the rollback STICKS, and clearing the
-- column is how an operator deliberately re-arms one site.
--
-- One additive nullable column, in the spirit of site.v2_history_cutover_at:
-- NULL = never auto-backfilled (the state of every site before this deploy).
-- The V2 RLS policy + grants cover the site table already, so nothing else
-- changes. Idempotent, so it layers over the compose bootstrap like V1.
ALTER TABLE site ADD COLUMN IF NOT EXISTS v2_backfilled_at TIMESTAMPTZ;

COMMENT ON COLUMN site.v2_backfilled_at IS
    'When the automatic v1->v2 entity backfill composed this site (NULL = never; '
    'the runner only touches NULL rows, so a rollback that deletes the entities '
    'is not re-migrated on the next boot).';
