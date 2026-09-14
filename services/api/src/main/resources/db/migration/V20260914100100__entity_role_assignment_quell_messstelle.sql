-- =============================================================================
-- V20260914100100 - die Rollen-Zuordnung (entity_role_assignment, V20260719040000)
-- verallgemeinern: ein zugeordneter Wert darf jetzt ENTWEDER ein nativer Kanal
-- (capability, wie bisher) ODER ein Gesamtwert / eine berechnete Messstelle
-- (quell_messstelle_id) sein. Rein additiv - KEIN zweites Modell (Hausregel):
-- das vorhandene Rollen-Zuordnungs-System traegt den Summenwert als zuordenbaren
-- Wert neben dem Kanal, genau wie messstelle_formel_term ENTWEDER messkanal ODER
-- messstelle bindet.
--
-- Konzept vp-agg-konzept2-f3 §2.6.3 / vp-agg-konzept3-r8. Die „genau ein
-- massgeblicher je (Geraet, Rolle)"-Regel bleibt Service-gefuehrt (feiner
-- gescopet ueber entity_id) - keine DB-Invariante, wie schon im Kopf von
-- V20260719040000 vermerkt.
--
-- ⚠ DER MANDANT REIST MIT: quell_messstelle_id verweist ueber (…, tenant_id) auf
-- messstelle(id, tenant_id) (die Falle aus V20260911100000), nicht nur ueber die
-- id. So kann eine Zuordnung nie auf die Messstelle eines fremden Mandanten
-- zeigen, auch wenn der FK-Check die RLS umgeht.
--
-- LOESCHEN. Komponente weg -> Zuordnung weg: der bestehende entity_id-FK ist
-- ON DELETE CASCADE (unveraendert). Zugeordnete Messstelle hart geloescht
-- (Offboarding ueber die Admin-Rolle) -> Zuordnung weg: der neue
-- quell_messstelle_id-FK ist ebenfalls ON DELETE CASCADE. Das ARCHIVIEREN einer
-- Messstelle (archiviert_am gesetzt, der Normalfall) loescht keine Zeile - der
-- Lese-/Aggregationsweg (RollenZuordnungService) behandelt eine archivierte
-- Quelle als „nicht mehr da" und zeigt sie ehrlich als unaufgeloest, statt stumm
-- weiterzuzeigen.
-- =============================================================================

-- Der Summenwert als zuordenbarer Wert (optional; NULL = ein nativer Kanal).
ALTER TABLE entity_role_assignment
    ADD COLUMN IF NOT EXISTS quell_messstelle_id UUID;

-- Der Mandant reist mit; hart geloeschte Messstelle raeumt die Zuordnung ab.
ALTER TABLE entity_role_assignment
    DROP CONSTRAINT IF EXISTS entity_role_assignment_quell_fk;
ALTER TABLE entity_role_assignment
    ADD CONSTRAINT entity_role_assignment_quell_fk
        FOREIGN KEY (quell_messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE CASCADE;

-- capability wird optional: der Wert ist ENTWEDER ein Kanal ODER ein Summenwert.
ALTER TABLE entity_role_assignment
    ALTER COLUMN capability DROP NOT NULL;

-- Genau eines von beiden - nie beide, nie keines (dasselbe Entweder-Oder wie am
-- Formel-Term). coalesce(…, false): ein CHECK nimmt NULL an.
ALTER TABLE entity_role_assignment
    DROP CONSTRAINT IF EXISTS entity_role_assignment_wert_chk;
ALTER TABLE entity_role_assignment
    ADD CONSTRAINT entity_role_assignment_wert_chk CHECK (coalesce(
        (capability IS NOT NULL AND btrim(capability) <> '' AND quell_messstelle_id IS NULL)
        OR (capability IS NULL AND quell_messstelle_id IS NOT NULL),
        false));

-- Eine Zuordnung je (Komponente, Summenwert) - das Gegenstueck zu
-- uq_entity_role_assignment (entity_id, capability) fuer den nativen Fall. NULLs
-- sind in einem Unique verschieden, also stossen die zwei Uniques nie aneinander:
-- native Zeilen tragen quell_messstelle_id NULL, Summenwert-Zeilen capability NULL.
ALTER TABLE entity_role_assignment
    DROP CONSTRAINT IF EXISTS uq_entity_role_assignment_quell;
ALTER TABLE entity_role_assignment
    ADD CONSTRAINT uq_entity_role_assignment_quell UNIQUE (entity_id, quell_messstelle_id);

-- „Welche Zuordnungen zeigen auf diese Messstelle?" (Archivieren/Aufloesen).
CREATE INDEX IF NOT EXISTS idx_entity_role_assignment_quell
    ON entity_role_assignment (quell_messstelle_id);

COMMENT ON COLUMN entity_role_assignment.quell_messstelle_id IS
    'Optional: der zugeordnete Wert ist ein Gesamtwert / eine berechnete Messstelle '
    '(neben dem nativen capability-Kanal, genau eines von beiden). Der Mandant reist im '
    'zusammengesetzten FK mit. Konzept vp-agg-konzept2-f3 §2.6.3.';
