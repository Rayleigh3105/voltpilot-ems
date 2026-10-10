-- UEMS AP-17 IP-21b (S1, V4): der Leistungsvergleich zitiert genau EINE Kennzahl — ein Bericht je
-- Vorlage × Geltung × Zeitraum × Kennzahl. Additiv: eine neue, in jeder Bestandszeile leere Spalte
-- (nur der Leistungsvergleich trägt sie), ein Verweis mit dem Mandanten und die Eindeutigkeit V4 als
-- Vereinigung — jede andere Vorlage behält ihren Schlüssel, weil NULL als gleich zählt (NULLS NOT
-- DISTINCT). Keine Bestandszeile ändert sich; kein bestehender CHECK wird verengt.

ALTER TABLE bericht ADD COLUMN IF NOT EXISTS kennzahl_id UUID;

-- Der Mandant reist mit (wie standort/unternehmen). RESTRICT: eine zitierte Kennzahl wird nie hart
-- gelöscht — das Offboarding entfernt die Berichte vor den Kennzahlen (TenantRepository.offboard).
ALTER TABLE bericht ADD CONSTRAINT bericht_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
    REFERENCES kennzahl (id, tenant_id) ON DELETE RESTRICT;

-- Genau der Leistungsvergleich trägt eine Kennzahl; jede andere Vorlage keine.
ALTER TABLE bericht ADD CONSTRAINT bericht_kennzahl_chk
    CHECK ((kennzahl_id IS NOT NULL) = (vorlage = 'leistungsvergleich'));

-- V4 je Kennzahl (IP-21a Folgepunkt): 409 bericht_gibt_es_schon bleibt der Name; auch ein
-- archivierter Bericht belegt seinen Schlüssel.
ALTER TABLE bericht DROP CONSTRAINT IF EXISTS bericht_gibt_es_schon;
ALTER TABLE bericht ADD CONSTRAINT bericht_gibt_es_schon
    UNIQUE NULLS NOT DISTINCT (tenant_id, vorlage, geltung_art, geltung_id, zeitraum_schluessel, kennzahl_id);

CREATE INDEX IF NOT EXISTS idx_bericht_kennzahl ON bericht (tenant_id, kennzahl_id) WHERE kennzahl_id IS NOT NULL;
