-- =============================================================================
-- UEMS AP-08 Nachtrag — die Korrektur-Art `menge_nachgetragen`.
--
-- Captain 15.09.2026, Empfehlung B: ein Tag, der vor AP-08 IP-5
-- (V20260912205000) schon endgültig war, trägt keine Menge. Der Nachtrag läuft
-- über den regulären Korrekturweg — Vorschlag des Systems, Freigabe von Hand,
-- Version 2 mit Protokoll —, weil eine endgültige Zeile nach E5 nie still
-- geändert wird. Den Vorschlag legt `uems/TagesmengeNachtrag` an, die Version
-- schreibt die Kaskade (`uems/KorrekturKaskade`).
--
-- ADDITIV. Ersetzt NUR die Funktion messreihe_korrektur_vokabular() durch ihre
-- Zeilen aus events-vocabulary-vectors.json (Block vokabular.korrektur_art um
-- das sechste Wort geweitet) — so, wie V20260913190000 es für jede Weitung
-- vorsieht. Keine Tabelle, keine Spalte, kein CHECK und keine Bestandszeile
-- ändert sich; jede bestehende Zeile trägt ein Wort, das weiter im Vokabular
-- steht. Die CHECKs fragen messreihe_korrektur_wort / …_merkmal und sehen das
-- neue Wort ohne eigene Änderung.
-- =============================================================================

CREATE OR REPLACE FUNCTION messreihe_korrektur_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT, buchstabe TEXT, zuwachs TEXT, bezug TEXT,
               zeitform TEXT, folgt_auf TEXT[], grund_pflicht BOOLEAN, ersatzwert BOOLEAN,
               beleg_pflicht BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('ersatzwert_methode', 1, 'gleichmaessig_verteilen', 'a', 'gemessen', NULL::text, 'zeitraum',
     NULL::text[], NULL::boolean, NULL::boolean, NULL::boolean),
    ('ersatzwert_methode', 2, 'profil_vorperiode', 'b', 'gemessen', 'vorperiode', 'zeitraum', NULL, NULL, NULL, NULL),
    ('ersatzwert_methode', 3, 'profil_vergleichsquelle', 'c', 'gemessen', 'vergleichsquelle', 'zeitraum', NULL, NULL, NULL, NULL),
    ('ersatzwert_methode', 4, 'ablesestand_nachtragen', 'd', NULL, 'ablesestaende', 'zeitpunkt', NULL, NULL, NULL, NULL),
    ('ersatzwert_methode', 5, 'wert_eingeben', 'e', 'keiner', 'betrag', 'zeitraum', NULL, NULL, NULL, NULL),
    ('ersatzwert_methode', 6, 'vorperiode_uebernehmen', 'f', 'keiner', 'vorperiode', 'zeitraum', NULL, NULL, NULL, NULL),
    ('ersatzwert_methode', 7, 'vergleichsquelle_uebernehmen', 'g', 'keiner', 'vergleichsquelle', 'zeitraum', NULL, NULL, NULL, NULL),
    ('ersatzwert_status', 1, 'wirksam', NULL, NULL, NULL, NULL, '{}'::text[], false, NULL, NULL),
    ('ersatzwert_status', 2, 'zurueckgenommen', NULL, NULL, NULL, NULL, ARRAY['wirksam'], true, NULL, NULL),
    ('korrektur_art', 1, 'nachlieferung_nach_endgueltigkeit', NULL, NULL, NULL, NULL, NULL, NULL, false, false),
    ('korrektur_art', 2, 'ablesestaende_nachgetragen', NULL, NULL, NULL, NULL, NULL, NULL, false, false),
    ('korrektur_art', 3, 'umklassifizierung', NULL, NULL, NULL, NULL, NULL, NULL, false, false),
    ('korrektur_art', 4, 'ersatzwert', NULL, NULL, NULL, NULL, NULL, NULL, true, false),
    ('korrektur_art', 5, 'wert_berichtigt', NULL, NULL, NULL, NULL, NULL, NULL, false, true),
    ('korrektur_art', 6, 'menge_nachgetragen', NULL, NULL, NULL, NULL, NULL, NULL, false, false),
    ('korrektur_status', 1, 'vorschlag', NULL, NULL, NULL, NULL, '{}'::text[], false, NULL, NULL),
    ('korrektur_status', 2, 'freigegeben', NULL, NULL, NULL, NULL, ARRAY['vorschlag'], false, NULL, NULL),
    ('korrektur_status', 3, 'abgelehnt', NULL, NULL, NULL, NULL, ARRAY['vorschlag'], true, NULL, NULL),
    ('korrektur_status', 4, 'zurueckgenommen', NULL, NULL, NULL, NULL, ARRAY['freigegeben'], true, NULL, NULL)
$$;

COMMENT ON FUNCTION messreihe_korrektur_vokabular() IS
    'Die Woerter von Ersatzwert und Korrektur (AP-08 IP-12): vokabular.ersatzwert_methode, '
    'ersatzwert_status, korrektur_art, korrektur_status aus events-vocabulary-vectors.json, Zeile '
    'fuer Zeile; die EINE Stelle, die jeder CHECK der beiden Tabellen fragt. Seit V20260924013000 '
    'mit korrektur_art menge_nachgetragen (Nachtrag der Tagesmenge vor AP-08 IP-5).';
