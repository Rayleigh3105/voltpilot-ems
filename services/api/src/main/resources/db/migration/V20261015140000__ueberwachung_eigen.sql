-- =============================================================================
-- V20261015140000 - Alerting Scheibe 2: eigene Überwachungen am Wert
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.2, §6.4, §6.6, §7 Scheibe 2), Captain-
-- Entscheid 15C (15.10.2026, Preis-Hinweis ab Werk für Privatkunden).
--
-- Scheibe 1 (V20261015130000) kannte an Herkunft nur 'ab_werk' und 'vorschlag'
-- und sagte das additiv voraus: "'eigen' (freie Regel am Wert) ist Scheibe 2
-- ... die CHECK weitet additiv, wenn ihre Scheibe kommt." Diese Migration löst
-- genau das ein: eine Person legt am Menü "..." eines Werts selbst eine Regel
-- an (#6.8 "Vom Wert zur fertigen Regel: drei Taps"), Rechte
-- ueberwachung.eigene/ueberwachung.verwalten (bereits in der Rechte-Matrix,
-- Entscheid 5A) prüft die API beim Anlegen (@Recht, RechtZiel.DIENST).
--
-- Additiv: nur die CHECK wird erweitert, keine bestehende Zeile, Spalte oder
-- Policy ändert sich; "steuerung" (Rezept "Sag mir Bescheid") bleibt Scheibe 6.
-- =============================================================================

ALTER TABLE ueberwachung DROP CONSTRAINT ueberwachung_herkunft_chk;
ALTER TABLE ueberwachung ADD CONSTRAINT ueberwachung_herkunft_chk
    CHECK (herkunft IN ('ab_werk', 'vorschlag', 'eigen'));
