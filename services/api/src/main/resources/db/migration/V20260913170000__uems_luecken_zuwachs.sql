-- =============================================================================
-- UEMS AP-08 IP-6 — der Zuwachs über eine Lücke als Nutzlast von `data_gap`
-- =============================================================================
-- Der Zähler hat weitergezählt, während die Werte fehlten: die Differenz der
-- beiden Stände um die Lücke ist GEMESSEN, aber auf keine Viertelstunde
-- VERTEILBAR (AP-08 E2 = A). Die Lücke trägt sie darum als Nutzlast:
-- `zuwachs`, `einheit`, `stand_vor`, `stand_nach` — optional und fortschreibbar
-- (der Lücken-Melder schreibt sie mit dem Schließen fort).
--
-- ADDITIV: die Funktion wird KOMPLETT neu geschrieben — der Stand von
-- V20260913130000, Zeichen für Zeichen, mit genau dieser einen Änderung in der
-- Zeile `data_gap` (vier Felder mehr, dieselben vier fortschreibbar). Keine Art
-- kommt hinzu (der Art-CHECK bleibt), keine bestehende Zeile wird ungültig, keine
-- Tabelle ändert sich. Die Regeln der Felder (nur zusammen, nur geschlossen, nur
-- an einer Reihe, zuwachs = stand_nach − stand_vor, Einheit aus dem Vokabular)
-- prüft der Schreibweg (EreignisVokabular.pruefeZuwachs) — die Datenbank prüft
-- wie bisher, welche Felder eine Art tragen darf.
--
-- Getrennt und ohne Tabelle, weil der Writer-Test diese Datei auf seiner
-- Datenbank ausführt (EreignisTabelleImTest).
CREATE OR REPLACE FUNCTION messreihe_ereignis_vokabular()
RETURNS TABLE (art TEXT, urheber TEXT[], zeitform TEXT, grenzen TEXT, offen_erlaubt BOOLEAN,
               bezug_pflicht TEXT[], bezug_erlaubt TEXT[], pflicht TEXT[], felder TEXT[],
               fortschreibbar TEXT[], bestand BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('data_gap', ARRAY['writer', 'box', 'cloud']::text[], 'zeitraum', 'halboffen', true,
     ARRAY['box']::text[], ARRAY['datenquelle', 'komponente', 'messkanal', 'messstelle']::text[],
     ARRAY['erkannt_aus']::text[],
     ARRAY['erwartet_fehlend', 'nachgeliefert_am', 'fehlerklasse', 'ursache_ereignis',
           'zuwachs', 'einheit', 'stand_vor', 'stand_nach']::text[],
     ARRAY['bis', 'erwartet_fehlend', 'nachgeliefert_am', 'ursache_ereignis',
           'zuwachs', 'einheit', 'stand_vor', 'stand_nach']::text[], true),
    ('backfill', ARRAY['writer', 'cloud']::text[], 'zeitraum', 'geschlossen', false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     ARRAY['eingang_von', 'eingang_bis', 'anzahl']::text[],
     ARRAY['erwartet']::text[],
     '{}'::text[], false),
    ('duplicate_conflict', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'komponente', 'messkanal']::text[], ARRAY['messstelle']::text[],
     ARRAY['messzeit', 'gespeicherter_wert', 'abgewiesener_wert', 'sequenzen']::text[],
     ARRAY['einheit']::text[],
     '{}'::text[], false),
    ('sequence_gap', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz_erwartet', 'sequenz_erhalten', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('sequence_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz_erwartet', 'sequenz_erhalten']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('late_arrival', ARRAY['writer', 'cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['eingangszeit', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('counter_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['stand_alt', 'stand_neu']::text[],
     ARRAY['messzeit_alt', 'einheit']::text[],
     '{}'::text[], true),
    ('counter_overflow', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['stand_alt', 'stand_neu', 'messzeit_alt', 'wertebereich_modul',
           'hoechstzuwachs_je_kadenz', 'kadenz_s']::text[],
     ARRAY['einheit']::text[],
     '{}'::text[], false),
    ('device_boundary', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente']::text[], ARRAY['messkanal', 'messstelle']::text[],
     ARRAY['anlass', 'einbau_alt', 'einbau_neu', 'eingetragen_am']::text[],
     ARRAY['endstand', 'anfangsstand', 'einheit', 'bestaetigt_ereignis']::text[],
     '{}'::text[], false),
    ('handover', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', true,
     ARRAY['datenquelle']::text[], '{}'::text[],
     ARRAY['anlass', 'box_alt', 'box_neu']::text[],
     '{}'::text[],
     ARRAY['bis']::text[], false),
    ('unassigned_reader', ARRAY['writer']::text[], 'zeitraum', 'geschlossen', false,
     ARRAY['box', 'datenquelle', 'komponente']::text[], ARRAY['messkanal']::text[],
     ARRAY['anzahl']::text[],
     ARRAY['zustaendige_box']::text[],
     '{}'::text[], false),
    ('rejected', ARRAY['datenannahme', 'writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'grund']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('clock_ahead', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'vor_s']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('too_old', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'alter_s']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('clock_jump', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz', 'sprung_s']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('box_restart', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     '{}'::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('device_restart', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     '{}'::text[],
     ARRAY['herzschlag_vorher', 'herzschlag_nachher']::text[],
     '{}'::text[], false),
    ('frozen_source', ARRAY['box', 'writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], ARRAY['komponente', 'messkanal']::text[],
     '{}'::text[],
     ARRAY['lesungen', 'herzschlag']::text[],
     '{}'::text[], false),
    ('range_limit', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], ARRAY['komponente']::text[],
     '{}'::text[],
     ARRAY['statuswort']::text[],
     '{}'::text[], false),
    ('layout_changed', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     '{}'::text[],
     ARRAY['fassung_erwartet', 'fassung_gelesen', 'karten_erwartet', 'karten_gelesen']::text[],
     '{}'::text[], false),
    ('error_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('state_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('bitfield_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('text_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true)
$$;

COMMENT ON FUNCTION messreihe_ereignis_vokabular() IS
    'Das EINE Vokabular der Ereignisse (AP-07 IP-8, Vertrag events-vocabulary.md). Seit AP-07 '
    'IP-13 darf late_arrival auch von `cloud` kommen; seit AP-08 IP-4 gibt es counter_overflow '
    '(nur writer, Zeitpunkt, Rechnung als Pflichtfelder); seit AP-07 IP-9 darf backfill auch von '
    '`cloud` kommen (der Lücken-Melder der api); seit AP-08 IP-6 trägt data_gap den gemessenen '
    'Zuwachs (zuwachs, einheit, stand_vor, stand_nach — optional, fortschreibbar).';
