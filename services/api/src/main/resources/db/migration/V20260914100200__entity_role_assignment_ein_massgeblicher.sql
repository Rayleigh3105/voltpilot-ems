-- =============================================================================
-- V20260914100200 - „hoechstens ein massgeblicher je (Geraet, Rolle)" DB-hart
-- machen (Review vp-review-agg-r1 SOLLTE 1). Bisher war die Invariante rein
-- service-gefuehrt (demote-then-insert); auf der kundenoffenen Route koennten
-- zwei gleichzeitige PUTs auf dasselbe (Geraet, Rolle) zwei is_primary=TRUE-Zeilen
-- erzeugen -> stille Doppelzaehlung im kanonischen Wert. Ein partieller
-- Unique-Index schliesst das: die zweite nebenlaeufige Transaktion laeuft sauber
-- in den Constraint (der Dienst uebersetzt ihn in 409) statt eine zweite Wahrheit
-- zu erzeugen. Rein additiv; der eingebaute demote-then-insert-Weg erfuellt den
-- Index innerhalb EINER Transaktion (der alte Primary ist vor dem INSERT FALSE).
--
-- Der Index ist PARTIELL (WHERE is_primary): mehrere NICHT-massgebliche Kandidaten
-- je (Geraet, Rolle) bleiben erlaubt; nur der EINE massgebliche ist eindeutig. Ein
-- Geraet mit mehreren Rollen (Hybrid: pv UND storage) traegt je Rolle einen
-- Massgeblichen - verschiedene role-Werte, kein Konflikt.
--
-- Kann kein table-CONSTRAINT sein: Postgres kennt kein partielles UNIQUE als
-- Tabellen-Constraint, nur als Index.
-- =============================================================================

-- Bestandsdaten zuerst konsistent machen: sollte je (Geraet, Rolle) mehr als ein
-- Massgeblicher existieren (die alte, nur service-gefuehrte Regel liess das an der
-- DB zu), den kleinsten id deterministisch behalten und die uebrigen demoten -
-- so kann der Unique-Index nie an Altdaten scheitern. Beruehrt NUR bereits
-- invalide Zeilen (die Rolle/der Wert bleiben, nur das Massgeblich-Kennzeichen faellt).
UPDATE entity_role_assignment a SET is_primary = FALSE
 WHERE a.is_primary
   AND EXISTS (
     SELECT 1 FROM entity_role_assignment b
      WHERE b.entity_id = a.entity_id AND b.role = a.role AND b.is_primary
        AND b.id < a.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_role_primary
    ON entity_role_assignment (entity_id, role) WHERE is_primary;

COMMENT ON INDEX uq_entity_role_primary IS
    'Hoechstens ein massgeblicher (is_primary) Wert je (Geraet, Rolle) - DB-hart statt nur '
    'service-gefuehrt (Review vp-review-agg-r1 SOLLTE 1). Partiell WHERE is_primary.';
