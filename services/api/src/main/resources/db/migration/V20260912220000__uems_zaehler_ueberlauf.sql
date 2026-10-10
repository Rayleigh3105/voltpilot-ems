-- =============================================================================
-- UEMS AP-08 IP-4 — Überlauf: ein Wort mehr im Vokabular und die Deklaration der
-- Zählerreihe
-- =============================================================================
-- Eine Zählerreihe steigt, bis sie es nicht tut. Vier Brüche kennt der
-- Verbrauchsvertrag (docs/contracts/v2/verbrauch.md, Z4–Z7): Gerätegrenze,
-- Rücksetzung, Überlauf, Neustart. Gerechnet werden sie in
-- `uems/VerbrauchRegeln` (und dem Python-Zwilling) — diese Migration rechnet
-- nichts. Sie legt zwei Dinge an:
--
--   1. `counter_overflow` als 24. Art des geschlossenen Ereignis-Vokabulars
--      (AP-08 §4.3, E4, W11): Funktion + Art-CHECK. ADDITIV — keine bestehende
--      Zeile wird ungültig, kein Wort ändert seine Bedeutung.
--   2. `messreihe_zaehler_deklaration()`: die EINE Stelle, an der Writer und
--      Verdichtungs-Läufe fragen, was eine Zählerreihe rechenbar macht
--      (Wertebereich, Höchstzuwachs, Zählverlust bei Neustart). Die Felder dazu
--      baut AP-08 IP-7 (Katalog `wertebereich_modul`/`laeuft_ueber`,
--      Messstelle `anschlussleistung_kw`); bis dahin antwortet sie LEER — und
--      damit ist jeder fallende Stand eine Rücksetzung (E4: „geraten wird der
--      Höchstwert nicht“) und jeder Neustart „bis zu 255 s“ (AP-05).
--
-- Die Neuberechnung aus Ereignissen (Arbeitslisten-Grund `ereignis`) steht in
-- der Folge-Migration V20260912221000 — getrennt, weil der Writer-Test DIESE
-- Datei auf seiner Datenbank ausführt, die die Arbeitslisten nicht kennt.

-- -----------------------------------------------------------------------------
-- 1. EIN Wort mehr im Vokabular: `counter_overflow`
-- -----------------------------------------------------------------------------
-- Die Funktion wird KOMPLETT neu geschrieben — der Stand von V20260912190000
-- (late_arrival auch von `cloud`), Zeichen für Zeichen, mit genau dieser einen
-- Änderung: die Zeile `counter_overflow` direkt nach `counter_reset`, in der
-- Reihenfolge der Vektor-Datei. Hausregel: den AKTUELLEN Stand abschreiben, nie
-- den der Ur-Migration erraten.
--
-- `counter_overflow` meldet NUR der Writer; die Pflichtfelder sind die Rechnung
-- zum Nachlesen (Modul − stand_alt + stand_neu ≤ Höchstzuwachs × Abstand ÷
-- Kadenz). `bestand = false`: die Bestandstabelle device_measurement_event kennt
-- das Wort nicht und schreibt für denselben Sprung weiter `counter_reset`.
CREATE OR REPLACE FUNCTION messreihe_ereignis_vokabular()
RETURNS TABLE (art TEXT, urheber TEXT[], zeitform TEXT, grenzen TEXT, offen_erlaubt BOOLEAN,
               bezug_pflicht TEXT[], bezug_erlaubt TEXT[], pflicht TEXT[], felder TEXT[],
               fortschreibbar TEXT[], bestand BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('data_gap', ARRAY['writer', 'box', 'cloud']::text[], 'zeitraum', 'halboffen', true,
     ARRAY['box']::text[], ARRAY['datenquelle', 'komponente', 'messkanal', 'messstelle']::text[],
     ARRAY['erkannt_aus']::text[],
     ARRAY['erwartet_fehlend', 'nachgeliefert_am', 'fehlerklasse', 'ursache_ereignis']::text[],
     ARRAY['bis', 'erwartet_fehlend', 'nachgeliefert_am', 'ursache_ereignis']::text[], true),
    ('backfill', ARRAY['writer']::text[], 'zeitraum', 'geschlossen', false,
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
    '(nur writer, Zeitpunkt, Rechnung als Pflichtfelder).';

-- Der Art-CHECK ist eine wörtliche Liste (V20260911260000) — er wird ersetzt, in
-- der Reihenfolge des Vokabulars (MessreiheEreignisMigrationTest liest ihn so).
-- Die Prüfung der vorhandenen Zeilen kann nichts abweisen: die neue Liste ist
-- eine Obermenge der alten.
ALTER TABLE messreihe_ereignis DROP CONSTRAINT IF EXISTS messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change'));

-- -----------------------------------------------------------------------------
-- 2. Was eine Zählerreihe rechenbar macht: die Deklaration zur Zeit
-- -----------------------------------------------------------------------------
-- Eine Zeile oder keine. Jede Spalte darf leer sein, und leer heißt „nicht
-- deklariert“ — nie 0, nie ein Vorgabewert:
--
--   wertebereich_modul        Z6: bei diesem Stand beginnt der Zähler bei 0
--   hoechstzuwachs_je_kadenz  Z6: der größte plausible Zuwachs je `kadenz_s`
--   kadenz_s                  die Kadenz, auf die sich der Höchstzuwachs bezieht
--   neustart_verlust_s        Z7: so viele Sekunden Zählung kann ein Neustart
--                             kosten (AP-05: das Speicherintervall der Karte);
--                             leer = die Regel nimmt „bis zu 255 s“
--
-- Ein Überlauf braucht Wertebereich UND Höchstzuwachs UND Kadenz; fehlt eine
-- Angabe, gibt es keinen Überlauf, sondern die Rücksetzung mit „bis zu 1 Kadenz
-- nicht gezählt“ (Z5) — die benannte Unvollständigkeit statt einer Zahl.
--
-- HEUTE LEER: die Deklaration gehört AP-08 IP-7 (Vorlage/Messstelle). IP-7
-- ersetzt NUR den Rumpf dieser Funktion (CREATE OR REPLACE, gleiche Signatur);
-- Writer und Läufe fragen weiter hier. STABLE, weil sie später Tabellen liest;
-- ausführbar für jede Rolle (PUBLIC, wie jede Funktion), die RLS der später
-- gelesenen Tabellen gilt dann für den Aufrufer.
CREATE OR REPLACE FUNCTION messreihe_zaehler_deklaration(
    p_tenant UUID, p_entity UUID, p_messkanal TEXT, p_zeit TIMESTAMPTZ)
RETURNS TABLE (wertebereich_modul NUMERIC, hoechstzuwachs_je_kadenz NUMERIC, kadenz_s INTEGER,
               neustart_verlust_s INTEGER)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULL::numeric, NULL::numeric, NULL::integer, NULL::integer
   WHERE false
$$;

COMMENT ON FUNCTION messreihe_zaehler_deklaration(UUID, UUID, TEXT, TIMESTAMPTZ) IS
    'Was eine Zaehlerreihe zur Zeit rechenbar macht (AP-08 IP-4, Z6/Z7): Wertebereich, '
    'Hoechstzuwachs je Kadenz, Neustart-Verlust. Leer = nicht deklariert (kein Ueberlauf, '
    'Neustart bis zu 255 s). Den Rumpf fuellt AP-08 IP-7.';
