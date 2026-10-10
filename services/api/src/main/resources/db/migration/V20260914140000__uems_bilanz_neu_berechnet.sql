-- =============================================================================
-- UEMS AP-10 IP-11 — Ereignis `bilanz_neu_berechnet`: die Korrektur-Kaskade meldet,
-- dass sie die Bilanz-Werte einer Messstelle neu berechnet hat
-- =============================================================================
-- Das Kostenstellen-Lesemodell (GET /api/v1/unternehmen/kostenstellen/{id}/energie)
-- speichert NICHTS: ein verteilter Wert wird beim Lesen aus den gespeicherten
-- Tageswerten gebildet und trägt die Version seiner Quelle. Diese Migration weitet
-- darum NUR das Vokabular — ADDITIV, ohne Tabelle, ohne Spalte, ohne Zeile:
--
--   1. messreihe_ereignis_vokabular() wird KOMPLETT neu geschrieben: der Stand von
--      V20260913230000 (verteilung_geaendert) Zeichen für Zeichen, dazu EINE Zeile
--      `bilanz_neu_berechnet` (nur cloud, Zeitraum halboffen, Bezug NUR die Messstelle,
--      Pflicht `ausloeser`). Jede Prüfung, die die Funktion fragt (Kennungen,
--      Nutzlast, Urheber), kennt das Wort damit sofort — es gibt keine zweite Liste.
--   2. Der Art-CHECK von messreihe_ereignis bekommt das Wort als letztes angehängt
--      (die Liste ist eine Obermenge, keine vorhandene Zeile wird abgewiesen).
--
-- Die Zwillinge im Gleichschritt: services/api uems/EreignisVokabular,
-- services/timescale-writer EreignisVokabular, services/ingest BoxEventsValidator
-- (Artenliste), frontend/portal uemsEreignis.ts, events-vocabulary-vectors.json,
-- events-raw.event.schema.json.
--
-- NICHT HIER: keine Tabelle für verteilte Werte, keine Rechte-Durchsetzung, kein
-- Portal. Geschrieben wird die Meldung in derselben Transaktion wie die Versionen
-- (uems/KorrekturKaskade → uems/BilanzNeuBerechnet), von der BYPASSRLS-Rolle, die
-- seit V20260912190000 INSERT auf messreihe_ereignis hat.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. Ein Wort mehr im Ereignis-Vokabular: `bilanz_neu_berechnet`
-- -----------------------------------------------------------------------------
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
     '{}'::text[], true),
    ('substitute', ARRAY['kunde']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['messstelle']::text[],
     ARRAY['ersatzwert', 'methode', 'status']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('correction', ARRAY['cloud', 'kunde']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['messstelle']::text[],
     ARRAY['korrektur', 'korrektur_art', 'status']::text[],
     ARRAY['ersatzwert']::text[],
     '{}'::text[], false),
    ('verteilung_geaendert', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['messstelle']::text[], '{}'::text[],
     ARRAY['eingetragen_am']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('bilanz_neu_berechnet', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['messstelle']::text[], '{}'::text[],
     ARRAY['ausloeser']::text[],
     '{}'::text[],
     '{}'::text[], false)
$$;

COMMENT ON FUNCTION messreihe_ereignis_vokabular() IS
    'Das EINE Vokabular der Ereignisse (AP-07 IP-8, Vertrag events-vocabulary.md). Seit AP-07 '
    'IP-13 darf late_arrival auch von `cloud` kommen; seit AP-08 IP-4 gibt es counter_overflow '
    '(nur writer, Zeitpunkt, Rechnung als Pflichtfelder); seit AP-07 IP-9 darf backfill auch von '
    '`cloud` kommen (der Lücken-Melder der api); seit AP-08 IP-6 trägt data_gap den gemessenen '
    'Zuwachs (zuwachs, einheit, stand_vor, stand_nach — optional, fortschreibbar); seit AP-08 '
    'IP-12 gibt es substitute (Ersatzwert, nur kunde) und correction (Korrektur, cloud oder kunde) '
    '— je Statuswechsel eine neue Meldung, nie fortgeschrieben; seit AP-10 IP-8 gibt es '
    'verteilung_geaendert (nur kunde, Zeitpunkt = Beginn des ersten Tags, Bezug nur die Messstelle); seit AP-10 '
    'IP-11 gibt es bilanz_neu_berechnet (nur cloud, [von, bis) = die neu berechneten Tage, Bezug nur die '
    'Messstelle, Pflicht ausloeser = K-... oder EW-...).';

-- -----------------------------------------------------------------------------
-- 2. Der Art-CHECK ist eine wörtliche Liste — er wird ersetzt, in der Reihenfolge des
-- Vokabulars (MessreiheEreignisMigrationTest liest ihn so).
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_ereignis DROP CONSTRAINT IF EXISTS messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change', 'substitute', 'correction',
    'verteilung_geaendert', 'bilanz_neu_berechnet'));
