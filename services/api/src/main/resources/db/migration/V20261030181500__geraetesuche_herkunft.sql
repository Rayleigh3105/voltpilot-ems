-- =============================================================================
-- Gerätesuche, Folgepaket „Herkunft“ (vp-gs-folge-herkunft, 30.10.2026) —
-- Konzept vp-portal-geraetesuche-konzept §4 „Verlauf“, §7 „Protokoll und was der
-- Kunde sieht“; offen genannt in PR 1606 und PR 1608.
--
-- Das nur anfügende Protokoll der Suche lernt zwei Arten dazu:
--
--   uebernommen          ein Fund wurde über „Übernehmen“ zu einer Komponente
--                        (POST …/components mit Bezug auf Suche + Fund)
--   adresse_uebernommen  die neue Adresse eines Fundes ging an eine bestehende
--                        Komponente (DP-7 A, PUT …/components/{id})
--
-- Beide tragen, was der Satz „aus der Gerätesuche vom …“ und die Aktivität der
-- Box brauchen, und überleben damit den Läufer nach 30 Tagen (DP-3 A), der Suche
-- und Funde löscht: die Komponente (entity_id, ohne Fremdschlüssel wie such_id —
-- das Protokoll überlebt auch sie), der Schlüssel des Fundes (<erkenner>:
-- <Seriennummer oder ip:port>, nie eine MAC) und wann gesucht wurde. Ein
-- übernommenes Gerät darf im Protokoll stehen (DP-3 A: „Das Protokoll enthält
-- nur Zähler und übernommene Geräte“). Einen Namen trägt das Protokoll weiter
-- nicht (keine Spalte für einen Gerätenamen): den der Komponente liest die
-- Aktivität aus der Komponente selbst.
--
-- Keine neue Tabelle: Mandanten-RLS, FORCE, Standort-Zaun und die Rechte
-- (SELECT, INSERT für die App-Rolle — nur anfügend) aus V20261030140000 gelten
-- für die neuen Spalten unverändert.
-- =============================================================================

ALTER TABLE geraetesuche_protokoll ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE geraetesuche_protokoll ADD COLUMN IF NOT EXISTS fund_schluessel TEXT;
ALTER TABLE geraetesuche_protokoll ADD COLUMN IF NOT EXISTS gesucht_am TIMESTAMPTZ;

-- Die Arten: der Bestand aus V20261030140000 plus die zwei Übernahmen.
ALTER TABLE geraetesuche_protokoll DROP CONSTRAINT IF EXISTS geraetesuche_protokoll_art_chk;
ALTER TABLE geraetesuche_protokoll ADD CONSTRAINT geraetesuche_protokoll_art_chk
    CHECK (art IN ('gestartet', 'abbruch', 'beendet', 'uebernommen', 'adresse_uebernommen'));

-- Eine Übernahme nennt immer Komponente, Fund und Suchtag - und nur sie.
ALTER TABLE geraetesuche_protokoll DROP CONSTRAINT IF EXISTS geraetesuche_protokoll_uebernahme_chk;
ALTER TABLE geraetesuche_protokoll ADD CONSTRAINT geraetesuche_protokoll_uebernahme_chk CHECK (
    (art IN ('uebernommen', 'adresse_uebernommen'))
        = (entity_id IS NOT NULL AND fund_schluessel IS NOT NULL AND gesucht_am IS NOT NULL));

-- Die Herkunft je Komponente (Komponentenliste) und das Falten einer Suche
-- (gestartet + abbruch + beendet) in eine Zeile der Aktivität.
CREATE INDEX IF NOT EXISTS idx_geraetesuche_protokoll_komponente
    ON geraetesuche_protokoll (entity_id, am DESC) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_geraetesuche_protokoll_suche
    ON geraetesuche_protokoll (such_id);
