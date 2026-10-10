-- UEMS AP-16 IP-21: Die energetische Bewertung nutzt die bestehende Bericht-Maschine.
-- Additiv: Vorlage und Datengrundlagen-Zeitraum, vier Quellenarten und die Wiedervorlage am Bericht.

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

CREATE OR REPLACE FUNCTION bericht_vorlage()
RETURNS TABLE (vorlage TEXT, geltung_art TEXT, zeitraum_art TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('monatsbericht_standort', 'standort', 'monat'),
    ('jahresbericht_standort', 'standort', 'jahr'),
    ('monatsbericht_unternehmen', 'unternehmen', 'monat'),
    ('jahresbericht_unternehmen', 'unternehmen', 'jahr'),
    ('energetische_bewertung', 'unternehmen', 'datengrundlage')
$$;

ALTER TABLE bericht ADD COLUMN wiedervorlage_monate INTEGER NOT NULL DEFAULT 12;
ALTER TABLE bericht ADD CONSTRAINT bericht_wiedervorlage_monate_chk
    CHECK (wiedervorlage_monate BETWEEN 1 AND 120);

ALTER TABLE bericht DROP CONSTRAINT bericht_zeitraum_schluessel_chk;
ALTER TABLE bericht ADD CONSTRAINT bericht_zeitraum_schluessel_chk
    CHECK (CASE zeitraum_art
               WHEN 'monat' THEN zeitraum_schluessel ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
               WHEN 'jahr' THEN zeitraum_schluessel ~ '^[0-9]{4}$'
               WHEN 'datengrundlage' THEN zeitraum_schluessel ~
                    '^[0-9]{4}-(0[1-9]|1[0-2])(/[0-9]{4}-(0[1-9]|1[0-2]))?$'
               ELSE false
           END);

CREATE OR REPLACE FUNCTION bericht_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['archiviert_am', 'geltung_id', 'wiedervorlage_monate'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['archiviert_am', 'geltung_id', 'wiedervorlage_monate']) THEN
    RAISE EXCEPTION 'bericht %: Kennung, Vorlage, Geltung und Zeitraum bleiben', OLD.kennung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_identitaet_bleibt';
  END IF;
  IF NEW.wiedervorlage_monate IS DISTINCT FROM OLD.wiedervorlage_monate
     AND NEW.vorlage <> 'energetische_bewertung' THEN
    RAISE EXCEPTION 'bericht %: Wiedervorlage gehört nur zur energetischen Bewertung', OLD.kennung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bericht_wiedervorlage_nur_bewertung';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (wiedervorlage_monate) ON bericht TO ${appDbUser};

COMMENT ON COLUMN bericht.wiedervorlage_monate IS
    'AP-16 S5: Wiedervorlage der energetischen Bewertung in Monaten; Startwert 12, Änderung mit Begründung.';
