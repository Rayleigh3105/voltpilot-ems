-- =============================================================================
-- V20261017020000 - Alerting Scheibe 4: Bündeln binnen 30 Sekunden
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4 Nr. 6, §6.6, §9): "Auslöser derselben
-- Regel innerhalb von 30 Sekunden gehen in EINE Nachricht"; eine gebündelte
-- Nachricht baut der Zusteller je Empfänger NUR aus den Meldungen, die dieser
-- sieht (die Sicht-/Ruhezeit-Prüfung bleibt pro Zeile, unverändert).
--
-- benachrichtigung.buendel_schluessel gruppiert Ausgangszeilen, die zur
-- selben Zeit fällig werden sollen: NULL (Scheibe 0-3, jede einfache Regel)
-- sendet wie bisher einzeln und sofort; ein Schlüssel (Mehrfach-Regel, Scheibe
-- 4) sendet verzögert bis zum Ende des 30-Sekunden-Fensters, damit mehrere
-- binnen dieser Zeit ausgelöste Bezüge beim Zusteller zusammenfinden
-- (UeberwachungsService.versenden, Zusteller.sendeBuendel).
--
-- Additiv: keine bestehende Spalte, Zeile oder Policy ändert sich.
-- =============================================================================

ALTER TABLE benachrichtigung ADD COLUMN IF NOT EXISTS buendel_schluessel TEXT;

CREATE INDEX IF NOT EXISTS idx_benachrichtigung_buendel
    ON benachrichtigung (buendel_schluessel) WHERE buendel_schluessel IS NOT NULL;

COMMENT ON COLUMN benachrichtigung.buendel_schluessel IS
    'Alerting Scheibe 4 (§6.4 Nr. 6): Zeilen mit demselben Schlüssel (+ Empfänger + Weg), die zur selben Zeit fällig werden, fasst der Zusteller zu EINER Nachricht zusammen; NULL sendet einzeln wie bisher.';
