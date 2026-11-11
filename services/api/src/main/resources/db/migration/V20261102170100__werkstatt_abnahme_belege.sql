-- =============================================================================
-- Werkstatt-Automatik V1, Paket P6c: die Abnahme mit den Belegen des
-- Werkstatt-Dienstes (Entscheid WI-7 A: die bestehende Tabelle, erweitert).
--
-- werkstatt_abnahme bleibt append-only (Trigger aus V20261026200000). Neu:
--   quelle         'hand' (der bisherige Weg im Portal, Haken) oder 'dienst'
--   belege         je Prüfung der Werkstatt-Regel der Beleg des Dienstes, als
--                  Objekt {"<prüfung>": "<beleg>"} (Kennungen wie
--                  docs/contracts/werkstatt-pruefungen.json)
--   freigabe_id    unter welcher Freigabe die Box entstand
--   einloesung_id  die Einlösung, auf die sich Host-Schlüssel, Tunnel und
--                  Probe-Fenster beziehen
--   passwort_age   das Root-Passwort, verschlüsselt für den age-Schlüssel
--                  „Box-Passwörter“ (Entscheid WI-6 A). Nur der Betreiber kann
--                  es entschlüsseln; das Passwort selbst kommt nie hierher.
-- Eine Abnahme des Dienstes hat alle vier; die alten Zeilen sind 'hand'.
-- =============================================================================

ALTER TABLE werkstatt_abnahme ADD COLUMN IF NOT EXISTS quelle TEXT NOT NULL DEFAULT 'hand';
ALTER TABLE werkstatt_abnahme ADD COLUMN IF NOT EXISTS belege JSONB;
ALTER TABLE werkstatt_abnahme ADD COLUMN IF NOT EXISTS freigabe_id UUID REFERENCES werkstatt_freigabe (id);
ALTER TABLE werkstatt_abnahme ADD COLUMN IF NOT EXISTS einloesung_id UUID REFERENCES werkstatt_einloesung (id);
ALTER TABLE werkstatt_abnahme ADD COLUMN IF NOT EXISTS passwort_age TEXT;

ALTER TABLE werkstatt_abnahme DROP CONSTRAINT IF EXISTS werkstatt_abnahme_quelle_chk;
ALTER TABLE werkstatt_abnahme ADD CONSTRAINT werkstatt_abnahme_quelle_chk CHECK (quelle IN ('hand', 'dienst'));

ALTER TABLE werkstatt_abnahme DROP CONSTRAINT IF EXISTS werkstatt_abnahme_dienst_chk;
ALTER TABLE werkstatt_abnahme ADD CONSTRAINT werkstatt_abnahme_dienst_chk CHECK (
    (quelle = 'hand' AND belege IS NULL AND freigabe_id IS NULL AND einloesung_id IS NULL AND passwort_age IS NULL)
    OR (quelle = 'dienst' AND belege IS NOT NULL AND jsonb_typeof(belege) = 'object'
        AND freigabe_id IS NOT NULL AND einloesung_id IS NOT NULL AND passwort_age IS NOT NULL));

ALTER TABLE werkstatt_abnahme DROP CONSTRAINT IF EXISTS werkstatt_abnahme_passwort_chk;
ALTER TABLE werkstatt_abnahme ADD CONSTRAINT werkstatt_abnahme_passwort_chk CHECK (passwort_age IS NULL
    OR (length(passwort_age) <= 4000
        AND passwort_age LIKE '-----BEGIN AGE ENCRYPTED FILE-----%'
        AND passwort_age LIKE '%-----END AGE ENCRYPTED FILE-----%'));

CREATE INDEX IF NOT EXISTS idx_werkstatt_abnahme_einloesung ON werkstatt_abnahme (einloesung_id);
