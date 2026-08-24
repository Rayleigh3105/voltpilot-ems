-- =============================================================================
-- V20260837000000 - Eine eingetragene Ladepunkt-Kennung laesst sich WIEDER
-- ENTFERNEN (Captain-Order 24.08.2026: "Ebenso will ich die moeglichkeit haben
-- eingebene kennungen zu loeschen").
-- -----------------------------------------------------------------------------
-- Die Allowlist war bewusst NUR-HINZUFUEGEND: die api hatte keinen Loesch-Pfad,
-- die App-Rolle kein DELETE-Recht, und die Box entfernte nie einen Eintrag. Der
-- Captain hebt das ausdruecklich auf - der Pflege-Ort ist das Portal, und dort
-- muss auch das Zuruecknehmen moeglich sein.
--
-- ⚠ ENTFERNEN IST HIER EIN GRABSTEIN, KEIN LOESCHEN - und genau das ist der
-- Grund, warum diese Migration KEIN `GRANT DELETE` gibt. Das retained Dokument
-- wird als GANZES ersetzt: eine Kennung nur WEGZULASSEN wuerde von einer Box,
-- die gerade offline war, nie gesehen (sie behaelt, was sie hat - `charge_points`
-- fuegt nur hinzu). Das Portal muss die Loeschung also DAUERHAFT fuehren und in
-- JEDEM folgenden Dokument nennen, bis die Kennung wieder eingetragen wird. Eine
-- geloeschte Zeile koennte das nicht.
--
-- Die Regel als RECHT bleibt damit bestehen, ihre BEDEUTUNG wandert: aus "die
-- App-Rolle kann eine Kennung nicht entfernen" wird "sie kann eine Kennung nicht
-- VERGESSEN" (dieselbe append-only-Disziplin wie bei den Journal-Tabellen des
-- Hauses). Geschrieben wird die Ruecknahme als UPDATE, und UPDATE hat die Rolle
-- seit V20260834000000 - es braucht deshalb kein neues Recht.
--
-- Ein erneutes Eintragen derselben Kennung BELEBT die Zeile wieder (der Upsert
-- setzt removed_at zurueck), sie verschwindet dann aus der Grabstein-Liste und
-- steht wieder in `charge_points` - eine Kennung steht nie in beiden.
--
-- Alles ADDITIV: eine Anlage, die nie eine Kennung entfernt, verhaelt sich
-- zeichengleich wie vor dieser Migration, und eine aeltere Box ueberliest das
-- neue Vertragsfeld und behaelt ihre Kennung (der Vorzustand, nie eine falsche
-- Handlung).
--
-- Datums-Version nach der AGENTS.md-Regel zur Migrations-Koordination: sie
-- sortiert NACH dem hoechsten schon ausgelieferten Stand.
-- =============================================================================

ALTER TABLE site_charge_point_allowlist
    -- NULL = die Kennung ist eingetragen. Ein Zeitstempel = sie wurde
    -- zurueckgenommen und reist als Grabstein weiter mit.
    ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
    -- Wer sie entfernt hat (JWT-Subject) - dieselbe Papier-Spur wie added_by.
    ADD COLUMN IF NOT EXISTS removed_by TEXT;

-- Die Grabstein-Liste eines Standorts wird bei JEDEM Dokument gelesen; ohne
-- Index waere das ein Scan ueber die ganze (kleine) Tabelle je Veroeffentlichung.
CREATE INDEX IF NOT EXISTS idx_site_charge_point_allowlist_removed
    ON site_charge_point_allowlist (site_id, removed_at);
