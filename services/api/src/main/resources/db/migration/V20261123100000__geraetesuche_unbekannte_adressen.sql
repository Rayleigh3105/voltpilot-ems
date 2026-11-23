-- =============================================================================
-- Gerätesuche: ein Go-Kern-Box (Edge Light, Edge Industrie) meldet die
-- Adressen des unbekannt-Zählers mit (docs/contracts/v2/mqtt-geraetesuche.md
-- DP-3 A, geändert). Die Docker-Box meldet weiter nur die Zahl; die Spalte
-- bleibt dann NULL.
--
-- DP-3 A gilt unverändert: keine MAC, kein Hostname, kein Gerätename - nur ip
-- und, soweit beim Ansprechen schon offen gefunden, ports. Dieselbe 30-Tage-
-- Frist wie die Funde (geraetesuche_aufraeumen löscht die ganze Zeile).
-- =============================================================================

ALTER TABLE geraetesuche
    ADD COLUMN IF NOT EXISTS weitere_unbekannte_geraete JSONB;

ALTER TABLE geraetesuche
    ADD CONSTRAINT geraetesuche_unbekannte_geraete_chk
        CHECK (weitere_unbekannte_geraete IS NULL OR jsonb_typeof(weitere_unbekannte_geraete) = 'array');
