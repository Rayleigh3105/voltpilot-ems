-- UEMS AP-19 IP-22 (MG1–MG3): Vertrag Bericht 1.5 — die Vorlage `managementbewertung` (Nr. 7,
-- Fassung 1, Unternehmen × Jahr) und acht Quellenarten `energieziel · massnahme · abweichung ·
-- feststellung · internes_audit · dokument · beschluss · berichtsstand` (MG3). Additiv: jedes
-- bisherige Wort bleibt an seiner Nummer (Vereinigung mit V20260924214500 für bericht_vokabular()
-- und V20260924071945 für bericht_vorlage()); keine Tabelle, keine Spalte, kein CHECK, keine
-- Bestandszeile ändert sich — bericht_quelle_art_chk und bericht_vorlage_passt() fragen die
-- Funktionen. Keine der neuen Quellenarten trägt Kennzahl-Werte: darum erreicht keine Korrektur
-- die Managementbewertung über die Kaskade (MG3). Rechte der Vorlage sind `energiemanagement.*`
-- (Java, BerichtRechte.kennung) — kein Wort der Datenbank.

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
    ('vorlage', 7, 'managementbewertung'),
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
    ('quelle_art', 11, 'energieziel'),
    ('quelle_art', 12, 'massnahme'),
    ('quelle_art', 13, 'abweichung'),
    ('quelle_art', 14, 'feststellung'),
    ('quelle_art', 15, 'internes_audit'),
    ('quelle_art', 16, 'dokument'),
    ('quelle_art', 17, 'beschluss'),
    ('quelle_art', 18, 'berichtsstand'),
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

-- MG1: eine Managementbewertung gilt für das Unternehmen und ein Jahr — ein Paar, in der Folge der
-- Vorlagen-Datei angehängt; jede andere Vorlage behält ihre Paare.
CREATE OR REPLACE FUNCTION bericht_vorlage()
RETURNS TABLE (vorlage TEXT, geltung_art TEXT, zeitraum_art TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('monatsbericht_standort', 'standort', 'monat'),
    ('jahresbericht_standort', 'standort', 'jahr'),
    ('monatsbericht_unternehmen', 'unternehmen', 'monat'),
    ('jahresbericht_unternehmen', 'unternehmen', 'jahr'),
    ('energetische_bewertung', 'unternehmen', 'datengrundlage'),
    ('leistungsvergleich', 'unternehmen', 'monat'),
    ('leistungsvergleich', 'unternehmen', 'jahr'),
    ('leistungsvergleich', 'unternehmen', 'datengrundlage'),
    ('leistungsvergleich', 'standort', 'monat'),
    ('leistungsvergleich', 'standort', 'jahr'),
    ('leistungsvergleich', 'standort', 'datengrundlage'),
    ('managementbewertung', 'unternehmen', 'jahr')
$$;
