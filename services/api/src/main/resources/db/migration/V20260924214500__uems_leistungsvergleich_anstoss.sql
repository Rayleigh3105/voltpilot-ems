-- UEMS AP-17 IP-23 (A5, S4): der Anstoß an einer Bezugsbasis läuft weiter zu jedem
-- Leistungsvergleichs-Stand, der sie zitiert. Additiv, keine Tabelle, keine Spalte, keine
-- Bestandszeile:
--   1. bericht_vokabular() → anstoss_art 17–19 `bezugsbasis_anstoss · bezugsbasis_fassung ·
--      bezugsbasis_beendet` (bericht-vectors.json). Vereinigung mit V20260924071945 — jedes
--      bisherige Wort bleibt an seiner Nummer; bericht_revision_anstoss_art_chk fragt die
--      Funktion und wird nicht angefasst.
--   2. Das Wasserzeichen des Pfads 2 (bezugsbasis_struktur_gelesen, V20260924200500) liest
--      auch `bezugsbasis_aenderung` (Fassung freigegeben, Basis beendet): der CHECK auf
--      `protokoll` wird zur Vereinigung geweitet, nie enger.

CREATE OR REPLACE FUNCTION bericht_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('vorlage', 1, 'monatsbericht_standort'),
    ('vorlage', 2, 'jahresbericht_standort'),
    ('vorlage', 3, 'monatsbericht_unternehmen'),
    ('vorlage', 4, 'jahresbericht_unternehmen'),
    ('vorlage', 5, 'energetische_bewertung'),
    ('vorlage', 6, 'leistungsvergleich'),
    ('geltung_art', 1, 'standort'),
    ('geltung_art', 2, 'unternehmen'),
    ('zeitraum_art', 1, 'monat'),
    ('zeitraum_art', 2, 'jahr'),
    ('zeitraum_art', 3, 'datengrundlage'),
    ('quelle_art', 1, 'messstelle'),
    ('quelle_art', 2, 'kostenstelle'),
    ('quelle_art', 3, 'bezugsgroesse'),
    ('quelle_art', 4, 'stammdatum'),
    ('quelle_art', 5, 'kennzahl'),
    ('quelle_art', 6, 'umfang'),
    ('quelle_art', 7, 'energieeinsatz'),
    ('quelle_art', 8, 'messbedarf'),
    ('quelle_art', 9, 'messmittel'),
    ('quelle_art', 10, 'bezugsbasis'),
    ('quelle_bezug', 1, 'unmittelbar'),
    ('quelle_bezug', 2, 'mittelbar'),
    ('quelle_bezug', 3, 'vergleich'),
    ('anstoss_art', 1, 'korrektur_freigegeben'),
    ('anstoss_art', 2, 'korrektur_zurueckgenommen'),
    ('anstoss_art', 3, 'ersatzwert_wirksam'),
    ('anstoss_art', 4, 'ersatzwert_zurueckgenommen'),
    ('anstoss_art', 5, 'bezugsgroesse_fassung'),
    ('anstoss_art', 6, 'kennzahl_fassung_rueckwirkend'),
    ('anstoss_art', 7, 'zuordnung_rueckwirkend'),
    ('anstoss_art', 8, 'anlage_umzug_rueckwirkend'),
    ('anstoss_art', 9, 'flaeche_rueckwirkend'),
    ('anstoss_art', 10, 'verteilung_rueckwirkend'),
    ('anstoss_art', 11, 'einstufung_fassung'),
    ('anstoss_art', 12, 'kriterien_fassung'),
    ('anstoss_art', 13, 'umfang_fassung'),
    ('anstoss_art', 14, 'messbedarf_zustand'),
    ('anstoss_art', 15, 'prozess_zuordnung_rueckwirkend'),
    ('anstoss_art', 16, 'messmittel_angabe'),
    ('anstoss_art', 17, 'bezugsbasis_anstoss'),
    ('anstoss_art', 18, 'bezugsbasis_fassung'),
    ('anstoss_art', 19, 'bezugsbasis_beendet'),
    ('anstoss_zustand', 1, 'offen'),
    ('anstoss_zustand', 2, 'erledigt'),
    ('anstoss_zustand', 3, 'verworfen'),
    ('handlung', 1, 'abrufen'),
    ('handlung', 2, 'pdf'),
    ('handlung', 3, 'csv'),
    ('handlung', 4, 'anlegen'),
    ('handlung', 5, 'freigeben'),
    ('handlung', 6, 'verwerfen'),
    ('handlung', 7, 'archivieren'),
    ('handlung', 8, 'wiedervorlage_aendern')
$$;

-- Späte Ankunft (out-of-order): gibt es das Wasserzeichen noch nicht, legt V20260924200500
-- es an; dann bleibt es bei dessen CHECK, und diese Migration weitet nichts.
DO $$
BEGIN
    IF to_regclass('bezugsbasis_struktur_gelesen') IS NOT NULL THEN
        ALTER TABLE bezugsbasis_struktur_gelesen
            DROP CONSTRAINT IF EXISTS bezugsbasis_struktur_gelesen_protokoll_chk;
        ALTER TABLE bezugsbasis_struktur_gelesen
            ADD CONSTRAINT bezugsbasis_struktur_gelesen_protokoll_chk CHECK (protokoll IN
                ('ort_aenderung', 'messstelle_aenderung', 'kennzahl_aenderung', 'bezugsgroesse_aenderung',
                 'bezugsbasis_aenderung'));
    END IF;
END $$;
