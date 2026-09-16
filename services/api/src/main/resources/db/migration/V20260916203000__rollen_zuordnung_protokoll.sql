-- H-2: Live-Rollen sind Ereignisse im bestehenden Anlagenprotokoll.
-- Keine neuen Tabellen/Spalten/Bestandszeilen. Der Rollenwert selbst ist TEXT
-- ohne CHECK; uq_entity_role_primary bleibt unverändert.
ALTER TABLE ort_aenderung DROP CONSTRAINT IF EXISTS ort_aenderung_art_chk;
ALTER TABLE ort_aenderung ADD CONSTRAINT ort_aenderung_art_chk
    CHECK (art IN ('angelegt', 'bearbeitet', 'verschoben', 'korrigiert',
                   'flaeche_geaendert', 'archiviert', 'wiederhergestellt',
                   'geloescht', 'zugriff_zugewiesen', 'zugriff_entzogen',
                   'rolle_gesetzt', 'rolle_entzogen'));
