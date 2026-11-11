-- =============================================================================
-- V20261017050000 - Alerting Scheibe 6: Herkunft "steuerung"
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§7 Scheibe 6, Entscheid 10A).
--
-- Scheibe 1 (V20261015130000) sagte das additiv voraus: "'steuerung' (Rezept
-- 'Sag mir Bescheid') ist Scheibe 6 - die CHECK weitet additiv, wenn ihre
-- Scheibe kommt." Diese Migration löst das ein: "In Überwachung umwandeln"
-- an einer alten vp.notify.push-Regelkarte legt eine EIGENE Überwachung mit
-- dieser Herkunft an (derselbe Weg wie herkunft = 'eigen',
-- UeberwachungAnlegenService#anlegen, nur mit einem anderen, vom Client
-- gewählten Herkunfts-Wort - die Rechteprüfung bleibt identisch:
-- ueberwachung.eigene/verwalten).
--
-- Additiv: nur die CHECK wird erweitert, keine bestehende Zeile, Spalte oder
-- Policy ändert sich.
-- =============================================================================

ALTER TABLE ueberwachung DROP CONSTRAINT ueberwachung_herkunft_chk;
ALTER TABLE ueberwachung ADD CONSTRAINT ueberwachung_herkunft_chk
    CHECK (herkunft IN ('ab_werk', 'vorschlag', 'eigen', 'steuerung'));
