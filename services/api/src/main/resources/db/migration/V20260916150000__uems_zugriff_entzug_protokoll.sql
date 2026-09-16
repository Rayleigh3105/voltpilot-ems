-- =============================================================================
-- UEMS AP-03 IP-9 — der Entzug steht auch im Änderungsprotokoll des Standorts
-- =============================================================================
-- §4.7 (Protokoll): „Jeder Entzug: Zeit · wer · wen · Standort/Rolle/
-- Unterstützung · Grund — im Zugriffsprotokoll des Kundenbereichs UND als Zeile
-- im Änderungsprotokoll des Standorts (AP-02 §4.4, damit AP-12 den
-- Berichtszeitraum erklären kann)."
--
-- `zugriff_protokoll` (V20260915030000) trägt die erste Zeile schon. Diese
-- Migration weitet allein das Vokabular von `ort_aenderung` (V20260911100000) um
-- zwei Wörter:
--
--   zugriff_zugewiesen — eine Person darf an diesem Ort handeln (Rolle × Ort)
--   zugriff_entzogen   — sie darf es nicht mehr, ab jetzt
--
-- Beide sind PUNKTE, keine Zeiträume: sie gelten an ihrem Tag und werden von
-- keinem späteren Eintrag „abgelöst" — das Lesemodell
-- (AenderungsprotokollRepository, STROM_ORT) gibt ihnen darum `gilt_bis` =
-- `gilt_ab`. Für Berichte sind sie KEINE Strukturänderung
-- (BerichtRegeln.struktur: eine unbekannte Art ist `keine_strukturaenderung`),
-- sie stoßen also keine Revision an — ein Entzug ändert keine Zahl.
--
-- Der CHECK wird als WÖRTLICHE Liste ersetzt, in der Reihenfolge des Bestands
-- plus der zwei neuen Wörter (Muster V20260911270000 für
-- data_source_aenderung_art_chk).
--
-- Bestandsschutz: keine Tabelle, keine Spalte, keine Zeile, kein Fremdschlüssel.
-- Ein CHECK wird allein GEWEITET — jede heute erlaubte Zeile bleibt erlaubt,
-- jede heute abgelehnte bis auf die zwei neuen Wörter abgelehnt.
-- -----------------------------------------------------------------------------

ALTER TABLE ort_aenderung DROP CONSTRAINT IF EXISTS ort_aenderung_art_chk;
ALTER TABLE ort_aenderung ADD CONSTRAINT ort_aenderung_art_chk
    CHECK (art IN ('angelegt', 'bearbeitet', 'verschoben', 'korrigiert',
                   'flaeche_geaendert', 'archiviert', 'wiederhergestellt',
                   'geloescht', 'zugriff_zugewiesen', 'zugriff_entzogen'));

