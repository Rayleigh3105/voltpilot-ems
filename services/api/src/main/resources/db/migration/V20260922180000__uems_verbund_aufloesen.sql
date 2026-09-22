-- AP-15 §5.5: gemeinsames Auflösen bleibt über API-Neustarts erkennbar.
-- Keine Zeile anlegen, keinen Verlauf löschen; art ist die Vereinigung des bisherigen CHECKs.
ALTER TABLE steuerungsverbund ADD COLUMN IF NOT EXISTS aufloesung_laeuft BOOLEAN NOT NULL DEFAULT false;
GRANT UPDATE (aufloesung_laeuft) ON steuerungsverbund TO ${appDbUser};

ALTER TABLE steuerungsverbund_aenderung DROP CONSTRAINT IF EXISTS steuerungsverbund_aenderung_art_chk;
ALTER TABLE steuerungsverbund_aenderung ADD CONSTRAINT steuerungsverbund_aenderung_art_chk
    CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt', 'vorbehalt', 'vorgabe_signal',
                   'geraete', 'erzeuger', 'box_getauscht', 'mitglied_ausgeschieden', 'aufgeloest'));
