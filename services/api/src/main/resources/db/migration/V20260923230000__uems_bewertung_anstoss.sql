-- UEMS AP-16 IP-23, S3: Die energetische Bewertung nutzt beide bestehenden
-- Berichts-Kaskaden. Additiv sind sechs Anlass-Arten und vier weitere
-- Änderungsprotokolle im zeilenweisen Wasserzeichen.

CREATE OR REPLACE FUNCTION bericht_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('vorlage', 1, 'monatsbericht_standort'),
    ('vorlage', 2, 'jahresbericht_standort'),
    ('vorlage', 3, 'monatsbericht_unternehmen'),
    ('vorlage', 4, 'jahresbericht_unternehmen'),
    ('vorlage', 5, 'energetische_bewertung'),
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

ALTER TABLE bericht_struktur_gelesen
    DROP CONSTRAINT bericht_struktur_gelesen_protokoll_chk;
ALTER TABLE bericht_struktur_gelesen
    ADD CONSTRAINT bericht_struktur_gelesen_protokoll_chk CHECK (protokoll IN (
        'ort_aenderung', 'messstelle_aenderung', 'energieeinsatz_aenderung',
        'bewertung_aenderung', 'messbedarf_aenderung', 'geraet_aenderung'));

COMMENT ON TABLE bericht_struktur_gelesen IS
    'AP-12 IP-9/AP-16 IP-23: Wasserzeichen je gelesener Struktur- oder Bewertungs-Protokollzeile; '
    'Urteil und getroffene Einträge werden in derselben Transaktion wie die Berichts-Naht geschrieben.';
