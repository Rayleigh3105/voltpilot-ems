-- =============================================================================
-- UEMS AP-11 IP-8 — Ereignis `kennzahl_neu_gebildet`: die Kaskaden-Naht der
-- Kennzahlen meldet, dass sie einen endgültigen Kennzahl-Wert als Version n + 1
-- neu gebildet hat
-- =============================================================================
-- Die Reservierung aus AP-11 IP-1 (events-vocabulary-vectors.json, Block
-- `reserviert`) wird eingelöst. Geschrieben wird die Meldung in derselben
-- Transaktion wie die Versionen (uems/KorrekturKaskade → uems/KennzahlKaskade →
-- uems/KennzahlNeuGebildet), von der BYPASSRLS-Rolle, die seit V20260912190000
-- INSERT auf messreihe_ereignis hat. Diese Migration weitet NUR das Vokabular —
-- ADDITIV, ohne Tabelle, ohne Spalte, ohne Zeile:
--
--   1. messreihe_ereignis_vokabular() ist der Stand von V20260915050100 Zeichen für
--      Zeichen — nur EINE Zeile kommt hinten dazu (das 33. Wort): nur cloud,
--      Zeitraum halboffen = die Periode des Werts, Bezug NUR die Kennzahl, Pflicht
--      `ausloeser` (K-… oder EW-…) und `version` (≥ 2).
--   2. messreihe_ereignis_bezug_erlaubt() kennt `kennzahl` als siebten Schlüssel von
--      `kennungen` (das Kennzeichen KZ-…, Text wie die übrigen).
--   3. Der Art-CHECK ist eine wörtliche Liste — er wird ersetzt, in der Reihenfolge
--      des Vokabulars (Muster V20260914140000).
--
-- Die Zwillinge im Gleichschritt: services/api uems/EreignisVokabular und
-- MessreiheEreignisRepository, services/timescale-writer EreignisVokabular und
-- MessreiheEreignisRepository, services/ingest BoxEventsValidator (Artenliste),
-- frontend/portal uemsEreignis.ts, events-vocabulary-vectors.json,
-- events-raw.event.schema.json.
--
-- Bestandsschutz: keine vorhandene Zeile wird geändert, kein Fremdschlüssel
-- verschärft, keine Tabelle angelegt. Jede bisher angenommene Meldung bleibt
-- angenommen, jede verworfene verworfen, mit demselben Grund.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. `kennzahl_neu_gebildet` — additiv
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
     '{}'::text[], ARRAY['komponente', 'messkanal', 'messstelle', 'bezugsgroesse']::text[],
     ARRAY['korrektur', 'korrektur_art', 'status']::text[],
     ARRAY['ersatzwert', 'fassung_alt', 'fassung_neu', 'import']::text[],
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
     '{}'::text[], false),
    ('bericht_freigegeben', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['nr', 'datenstand', 'pruefsumme']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('bericht_revision_angestossen', ARRAY['cloud']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['nr', 'anstoss_art', 'anlass_kennung']::text[],
     ARRAY['anlass_fassung']::text[],
     '{}'::text[], false),
    ('bericht_entwurf_neu_gebildet', ARRAY['cloud']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['datenstand']::text[],
     ARRAY['anlass_kennung']::text[],
     '{}'::text[], false),
    ('bericht_abgerufen', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['nr', 'format']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('kennzahl_neu_gebildet', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['kennzahl']::text[], '{}'::text[],
     ARRAY['ausloeser', 'version']::text[],
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
    'Messstelle, Pflicht ausloeser = K-... oder EW-...); seit AP-09 IP-7 trifft correction GENAU EINEN Bezug — '
    'die Reihe (komponente + messkanal) oder die Bezugsgröße (bezugsgroesse mit fassung_alt, fassung_neu, '
    'optional import; Kennung BK-...) — das Entweder-oder prüft der Schreibweg; seit AP-12 IP-4 gibt es die vier '
    'Berichts-Ereignisse bericht_freigegeben (kunde), bericht_revision_angestossen (cloud), '
    'bericht_entwurf_neu_gebildet (cloud) und bericht_abgerufen (kunde) — Zeitpunkt, Bezug NUR der Bericht '
    '(bericht = BR-...), Pflicht je Art nr/datenstand/pruefsumme, nr/anstoss_art/anlass_kennung, datenstand, '
    'nr/format; seit AP-11 IP-8 gibt es kennzahl_neu_gebildet (nur cloud, [von, bis) = die Periode '
    'des Kennzahl-Werts, Bezug NUR die Kennzahl (kennzahl = KZ-...), Pflicht ausloeser = K-... oder EW-... und version '
    '>= 2 — ein endgültiger Wert wurde als Version n + 1 neu gebildet).';

-- -----------------------------------------------------------------------------
-- 2. Der Bezug: `kennungen` darf die Kennzahl nennen (V20260915050100, geweitet)
-- -----------------------------------------------------------------------------
-- Rahmen wie bisher: jeder Schlüssel ein Text, die Pflicht-Bezüge der Art da, kein
-- Bezug, den die Art nicht kennt. Neu ist nur der siebte Schlüssel `kennzahl` (das
-- Kennzeichen der Kennzahl zur Zeit der Meldung).
CREATE OR REPLACE FUNCTION messreihe_ereignis_bezug_erlaubt(
    p_art TEXT, p_kennungen JSONB, p_messkanal TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_kennungen) IS DISTINCT FROM 'object' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_each(p_kennungen) k
                WHERE k.key NOT IN ('box', 'datenquelle', 'komponente', 'messstelle', 'bezugsgroesse',
                                    'bericht', 'kennzahl')
                   OR jsonb_typeof(k.value) <> 'string')
    AND COALESCE((
      SELECT v.bezug_pflicht <@ b.bezug AND b.bezug <@ (v.bezug_pflicht || v.bezug_erlaubt)
        FROM messreihe_ereignis_vokabular() v,
             LATERAL (SELECT ARRAY(SELECT jsonb_object_keys(p_kennungen))
                             || CASE WHEN p_messkanal IS NULL THEN '{}'::text[]
                                     ELSE ARRAY['messkanal']::text[] END AS bezug) b
       WHERE v.art = p_art), false)
  END
$$;

-- -----------------------------------------------------------------------------
-- 3. Der Art-CHECK ist eine wörtliche Liste — er wird ersetzt, in der Reihenfolge des
-- Vokabulars (MessreiheEreignisMigrationTest liest ihn so).
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_ereignis DROP CONSTRAINT IF EXISTS messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change', 'substitute', 'correction',
    'verteilung_geaendert', 'bilanz_neu_berechnet', 'bericht_freigegeben', 'bericht_revision_angestossen',
    'bericht_entwurf_neu_gebildet', 'bericht_abgerufen', 'kennzahl_neu_gebildet'));
