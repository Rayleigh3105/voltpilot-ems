-- =============================================================================
-- UEMS AP-08 IP-12 — Korrektur und Ersatzwert: zwei Tabellen, ein Vokabular,
-- zwei Ereignis-Arten
-- =============================================================================
-- ⚠ EIN ERSATZWERT IST KEIN MESSWERT — UND MAN MUSS ES IHM ANSEHEN. Hier entsteht
-- die erste Stelle, an der ein Mensch eine Zahl setzt, die der Zähler nie
-- geliefert hat. Darum ist jede dieser Zahlen BEGRÜNDET (Pflicht), GEKENNZEICHNET
-- (eigene Tabelle, eigene Kennung, eigene Methode — nie eine Zeile der
-- Messwert- oder Periodentabellen) und WIDERRUFBAR (Rücknahme als Fortschreibung).
-- Kein Rohwert wird angefasst: diese Migration ändert keine Zeile einer
-- bestehenden Tabelle, und von hier aus führt kein Weg in eine.
--
-- Was entsteht (AP-08 §4.6, §8 IP-12; Captain-Entscheide E7, E8, E14):
--
--   1. `substitute` und `correction` als 25. und 26. Art des geschlossenen
--      Ereignis-Vokabulars — ADDITIV: die Funktion wird KOMPLETT neu geschrieben
--      (der Stand von V20260913170000, Zeichen für Zeichen, plus genau diese zwei
--      Zeilen am Ende), der Art-CHECK wird zur Obermenge. Keine bestehende Zeile
--      wird ungültig.
--   2. `messreihe_korrektur_vokabular()`: die EINE Stelle, an der die Wörter der
--      beiden Tabellen stehen — Zeile für Zeile `vokabular.ersatzwert_methode`,
--      `ersatzwert_status`, `korrektur_art`, `korrektur_status` der Vektor-Datei
--      docs/contracts/v2/events-vocabulary-vectors.json, dieselben Wörter, die die
--      Meldungen `substitute`/`correction` tragen. Jeder CHECK fragt sie; keiner
--      trägt eine eigene Wortliste. Weitet der Vertrag ein Vokabular, ersetzt eine
--      NEUE Migration nur diese Funktion (UemsKorrekturErsatzwertMigrationTest
--      druckt den VALUES-Block).
--   3. `messreihe_ersatzwert` — der Ersatzwert (EW-<Jahr>-<lfd. Nr.>).
--   4. `messreihe_korrektur` — die Korrektur (K-<Jahr>-<lfd. Nr.>).
--
-- DIE UNTERSCHEIDUNG, DIE E7 VERLANGT — in der Datenbank, nicht nur im Text:
--   * a–c (gleichmaessig_verteilen, profil_vorperiode, profil_vergleichsquelle,
--     `zuwachs = gemessen`) verteilen einen GEMESSENEN Zuwachs. Die Zeile nennt
--     die Lücke (`luecke_ereignis_id`) und trägt deren Zuwachs samt Ständen; ein
--     Trigger prüft, dass genau diese `data_gap`-Meldung an genau dieser Reihe mit
--     genau diesem Zuwachs existiert und der Zeitraum in ihren Viertelstunden
--     liegt. Die Summe der Ersatzwerte IST damit der gemessene Zuwachs — sie hat
--     keine zweite, getippte Quelle.
--   * e, f, g (wert_eingeben, vorperiode_uebernehmen, vergleichsquelle_uebernehmen,
--     `zuwachs = keiner`) dürfen NUR stehen, wo über den Zeitraum kein Zuwachs
--     gemessen ist: derselbe Trigger lehnt sie ab, sobald eine `data_gap` mit
--     Zuwachs die Reihe im Zeitraum berührt. f/g sagt E7 wörtlich; e folgt aus
--     §4.6 („nicht gezählte Zeit oder Lücke einer Intervallmengen-/
--     Leistungsreihe“) und der Invariante aus F21 („die Summe über eine
--     Zählerstand-Lücke bleibt der gemessene Zuwachs“) — sonst könnte eine
--     eingegebene Zahl den gemessenen Zuwachs überschreiben.
--   * d (ablesestand_nachtragen, `zuwachs` leer) betrifft keine Lücke: ein
--     Zeitpunkt auf die Minute mit Endstand und/oder Anfangsstand; der Zeitraum
--     ist die Viertelstunde, zu der er gehört (Zeitpunkt in (von, bis]).
--
-- APPEND-ONLY. Eine Zeile ist eine FASSUNG: Fassung 1 legt an (sie trägt alles,
-- was den Ersatzwert bzw. die Korrektur ausmacht), jede weitere schreibt NUR den
-- neuen Status fort — mit Grund, Urheber und Zeitpunkt, alle anlegenden Spalten
-- leer (so kann nichts auseinanderlaufen). Welcher Status auf welchen folgt,
-- steht im Vokabular (`folgt_auf`): Ersatzwert wirksam → zurueckgenommen;
-- Korrektur vorschlag → freigegeben | abgelehnt, freigegeben → zurueckgenommen.
-- Lückenlos 1, 2, 3 … je Kennung (Trigger). Ein UPDATE lehnt der Trigger für
-- JEDE Rolle ab — auch für die Verwaltungsrolle mit Recht und den Eigentümer;
-- DELETE hat nur die Verwaltungsrolle, und nur das Offboarding benutzt es.
--
-- DAS VERHÄLTNIS ZU `messreihe_korrektur_vorschlag` (V20260912190000, AP-07
-- IP-13): dort steht die ERKENNUNG — eine Zeile je Reihe und Viertelstunde, in
-- der ein Rohwert nach der Frist eintraf, Zustand offen/erledigt/verworfen, vom
-- Stundenlauf geschrieben. Hier steht der VORGANG — eine Korrektur, die solche
-- Zeilen einer Reihe bündelt (F10: K-2026-0007 über 15 Viertelstunden), geprüft,
-- freigegeben oder abgelehnt wird. Die Liste ist die Vorstufe und bleibt, wie sie
-- ist; AP-08 IP-14 macht aus offenen Zeilen eine Korrektur der Art
-- `nachlieferung_nach_endgueltigkeit` (dasselbe Wort wie ihr `grund`) und setzt
-- die Zeile auf erledigt. Zwei Tabellen, zwei Aussagen — keine zweite Wahrheit.
--
-- NICHT HIER: keine Rechenmethode (IP-13), keine Vorschlags-Erzeugung (IP-14),
-- keine Vier-Augen-Prüfung (IP-15, E8 ist eine Einstellung je Unternehmen), keine
-- Route, kein Portal (IP-16), keine Kaskade und keine Versionen der Perioden
-- (IP-17), keine Rechte-Durchsetzung (AP-03).
--
-- KEIN FREMDSCHLÜSSEL AUF ETWAS LÖSCHBARES (Belegschutz, §6.3: „nie löschbar;
-- AP-12 markiert sie als Beleg“): Reihe, Messstelle, Vergleichsquelle und Lücke
-- stehen als Kennung, nie als Verweis — ein Ersatzwert überlebt die Messstelle
-- wie ein Ereignis. Nur der Mandant (RESTRICT) und die Korrektur → ihr Ersatzwert
-- (beides nie gelöscht) sind Fremdschlüssel.

-- -----------------------------------------------------------------------------
-- 1. Zwei Wörter mehr im Ereignis-Vokabular: `substitute` und `correction`
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
     '{}'::text[], false)
$$;

COMMENT ON FUNCTION messreihe_ereignis_vokabular() IS
    'Das EINE Vokabular der Ereignisse (AP-07 IP-8, Vertrag events-vocabulary.md). Seit AP-07 '
    'IP-13 darf late_arrival auch von `cloud` kommen; seit AP-08 IP-4 gibt es counter_overflow '
    '(nur writer, Zeitpunkt, Rechnung als Pflichtfelder); seit AP-07 IP-9 darf backfill auch von '
    '`cloud` kommen (der Lücken-Melder der api); seit AP-08 IP-6 trägt data_gap den gemessenen '
    'Zuwachs (zuwachs, einheit, stand_vor, stand_nach — optional, fortschreibbar); seit AP-08 '
    'IP-12 gibt es substitute (Ersatzwert, nur kunde) und correction (Korrektur, cloud oder kunde) '
    '— je Statuswechsel eine neue Meldung, nie fortgeschrieben.';

-- Der Art-CHECK ist eine wörtliche Liste — er wird ersetzt, in der Reihenfolge des
-- Vokabulars (MessreiheEreignisMigrationTest liest ihn so). Die neue Liste ist eine
-- Obermenge der alten: keine vorhandene Zeile kann abgewiesen werden.
ALTER TABLE messreihe_ereignis DROP CONSTRAINT IF EXISTS messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change', 'substitute', 'correction'));

-- -----------------------------------------------------------------------------
-- 2. Die Wörter von Ersatzwert und Korrektur — EINE Stelle
-- -----------------------------------------------------------------------------
-- Je Zeile ein Wort mit seinen Merkmalen; ein Merkmal, das ein Vokabular nicht
-- kennt, ist leer. `nr` ist die Stelle in der Vektor-Datei.
--   ersatzwert_methode  buchstabe (a–g), zuwachs (gemessen | keiner | leer),
--                       bezug (vorperiode | vergleichsquelle | ablesestaende |
--                       betrag | leer), zeitform (zeitraum | zeitpunkt)
--   *_status            folgt_auf (leer = der Anfang), grund_pflicht
--   korrektur_art       ersatzwert (nennt genau dann einen Ersatzwert), beleg_pflicht
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
    ('korrektur_status', 1, 'vorschlag', NULL, NULL, NULL, NULL, '{}'::text[], false, NULL, NULL),
    ('korrektur_status', 2, 'freigegeben', NULL, NULL, NULL, NULL, ARRAY['vorschlag'], false, NULL, NULL),
    ('korrektur_status', 3, 'abgelehnt', NULL, NULL, NULL, NULL, ARRAY['vorschlag'], true, NULL, NULL),
    ('korrektur_status', 4, 'zurueckgenommen', NULL, NULL, NULL, NULL, ARRAY['freigegeben'], true, NULL, NULL)
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION messreihe_korrektur_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.messreihe_korrektur_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- Ein Merkmal eines Worts als Text ('true'/'false' bei den Ja-Nein-Merkmalen,
-- 'anfang' = 'true', wenn nichts davor steht); leer, wenn das Wort oder das
-- Merkmal fehlt — die CHECKs fragen darum zuerst messreihe_korrektur_wort.
CREATE OR REPLACE FUNCTION messreihe_korrektur_merkmal(p_vokabular TEXT, p_wort TEXT, p_merkmal TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_merkmal
           WHEN 'zuwachs' THEN v.zuwachs
           WHEN 'bezug' THEN v.bezug
           WHEN 'zeitform' THEN v.zeitform
           WHEN 'anfang' THEN (cardinality(v.folgt_auf) = 0)::text
           WHEN 'grund_pflicht' THEN v.grund_pflicht::text
           WHEN 'nennt_ersatzwert' THEN v.ersatzwert::text
           WHEN 'beleg_pflicht' THEN v.beleg_pflicht::text
         END
    FROM public.messreihe_korrektur_vokabular() v
   WHERE v.vokabular = p_vokabular AND v.wort = p_wort
$$;

-- Begründung, Grund und Beleg: Pflicht-Freitext ≥ 10 Zeichen (§4.6), gezählt in
-- Zeichen, nichts wird gekürzt — dieselbe Spanne wie die Bezugsdaten (500).
CREATE OR REPLACE FUNCTION messreihe_korrektur_text_gueltig(p_text TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT char_length(p_text) BETWEEN 10 AND 500 AND btrim(p_text) <> ''
$$;

-- Die betroffenen Reihen einer Korrektur: ein nicht leeres Array, je Element
-- genau {entity_id, messkanal} (Reihe = Mandant + Komponente + Messkanal, AP-07
-- E2), die Komponente in der kanonischen UUID-Form, keine Reihe doppelt.
CREATE OR REPLACE FUNCTION messreihe_korrektur_reihen_gueltig(p_reihen JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- CASE statt AND/OR: SQL verspricht keine Auswertungsreihenfolge, und
  -- jsonb_array_elements/jsonb_object_keys werfen auf der falschen Form.
  SELECT CASE WHEN jsonb_typeof(p_reihen) IS DISTINCT FROM 'array' OR jsonb_array_length(p_reihen) = 0
              THEN false
         ELSE NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_reihen) r
                 WHERE CASE WHEN jsonb_typeof(r) <> 'object' THEN true
                       ELSE ARRAY(SELECT jsonb_object_keys(r) ORDER BY 1) <> ARRAY['entity_id', 'messkanal']
                            OR jsonb_typeof(r -> 'entity_id') <> 'string'
                            OR jsonb_typeof(r -> 'messkanal') <> 'string'
                            OR NOT (r ->> 'entity_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                            OR btrim(r ->> 'messkanal') = '' OR length(r ->> 'messkanal') > 240
                       END)
              AND (SELECT count(DISTINCT r) FROM jsonb_array_elements(p_reihen) r) = jsonb_array_length(p_reihen)
         END
$$;

-- -----------------------------------------------------------------------------
-- 3. messreihe_ersatzwert — der Ersatzwert
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_ersatzwert (
    tenant_id           UUID        NOT NULL,
    -- EW-<Jahr>-<lfd. Nr.> je Kundenbereich (§4.6); vergeben vom Schreibweg.
    kennung             TEXT        NOT NULL,
    -- 1 = angelegt; jede weitere schreibt nur den Status fort (siehe Kopf).
    fassung             INTEGER     NOT NULL,
    status              TEXT        NOT NULL,
    -- ---- Fassung 1: was den Ersatzwert ausmacht --------------------------------
    methode             TEXT,
    -- Genau EINE Reihe (E2): Komponente + Messkanal; die Messstelle als Herkunft.
    entity_id           UUID,
    messkanal           TEXT,
    messstelle_id       UUID,
    -- Halboffen auf das Viertelstunden-Raster; bei Methode d die Viertelstunde des
    -- Ablesestands, der selbst in `zeitpunkt` steht.
    von                 TIMESTAMPTZ,
    bis                 TIMESTAMPTZ,
    zeitpunkt           TIMESTAMPTZ,
    begruendung         TEXT,
    beleg               TEXT,
    -- a–c: die Lücke und IHR gemessener Zuwachs (Kopie der data_gap-Meldung, vom
    -- Trigger gegen sie geprüft).
    luecke_ereignis_id  UUID,
    zuwachs             NUMERIC,
    stand_vor           NUMERIC,
    stand_nach          NUMERIC,
    -- Die Einheit von Zuwachs (a–c), Ablesestand (d) oder Betrag (e).
    einheit             TEXT,
    -- b, f: der Beginn des Vergleichszeitraums (Vorgabe 7 Tage früher).
    vorperiode_von      TIMESTAMPTZ,
    -- c, g: die Quellenbindung der Vergleichsquelle (messstelle_quelle, AP-04 E3).
    vergleich_quelle_id UUID,
    -- d: Endstand und/oder Anfangsstand.
    endstand            NUMERIC,
    anfangsstand        NUMERIC,
    -- e: der eingegebene Wert.
    betrag              NUMERIC,
    -- ---- Fassung > 1: die Fortschreibung ----------------------------------------
    grund               TEXT,
    -- Wer DIESE Fassung schrieb (Akteur-Vokabular AP-03, wie bezugsgroesse_wert):
    -- Fassung 1 = wer erfasste, zurueckgenommen = wer zurücknahm.
    actor_sub           TEXT,
    actor_name          TEXT        NOT NULL,
    actor_rolle         TEXT,
    actor_art           TEXT        NOT NULL,
    -- Die Erfassungszeit setzt die Datenbank (die App-Rolle hat kein Spaltenrecht).
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_ersatzwert_pk PRIMARY KEY (tenant_id, kennung, fassung),
    CONSTRAINT messreihe_ersatzwert_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_ersatzwert_kennung_chk CHECK (kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT messreihe_ersatzwert_fassung_chk CHECK (fassung >= 1),
    CONSTRAINT messreihe_ersatzwert_status_chk
        CHECK (coalesce(messreihe_korrektur_wort('ersatzwert_status', status), false)),
    CONSTRAINT messreihe_ersatzwert_methode_chk
        CHECK (methode IS NULL OR coalesce(messreihe_korrektur_wort('ersatzwert_methode', methode), false)),
    -- Fassung 1 beginnt mit dem Anfangs-Status, jede weitere nie.
    CONSTRAINT messreihe_ersatzwert_anfang_chk CHECK (
        NOT coalesce(messreihe_korrektur_wort('ersatzwert_status', status), false)
        OR (fassung = 1) = coalesce(messreihe_korrektur_merkmal('ersatzwert_status', status, 'anfang') = 'true', false)),
    -- Fassung 1 trägt den Ersatzwert, eine Fortschreibung nur ihren Status.
    CONSTRAINT messreihe_ersatzwert_anlage_chk CHECK (coalesce(
        (fassung = 1 AND methode IS NOT NULL AND entity_id IS NOT NULL AND messkanal IS NOT NULL
         AND von IS NOT NULL AND bis IS NOT NULL AND begruendung IS NOT NULL AND grund IS NULL)
        OR (fassung > 1 AND methode IS NULL AND entity_id IS NULL AND messkanal IS NULL
            AND messstelle_id IS NULL AND von IS NULL AND bis IS NULL AND zeitpunkt IS NULL
            AND begruendung IS NULL AND beleg IS NULL AND luecke_ereignis_id IS NULL
            AND zuwachs IS NULL AND stand_vor IS NULL AND stand_nach IS NULL AND einheit IS NULL
            AND vorperiode_von IS NULL AND vergleich_quelle_id IS NULL AND endstand IS NULL
            AND anfangsstand IS NULL AND betrag IS NULL), false)),
    CONSTRAINT messreihe_ersatzwert_messkanal_chk
        CHECK (messkanal IS NULL OR (btrim(messkanal) <> '' AND length(messkanal) <= 240)),
    CONSTRAINT messreihe_ersatzwert_zeitraum_chk CHECK (von IS NULL OR coalesce(
        von < bis AND uems_viertelstunde_raster(von) AND uems_viertelstunde_raster(bis), false)),
    -- E7 a–c: ein GEMESSENER Zuwachs, und er ist die Differenz der Stände (nie
    -- negativ); jede andere Methode trägt keinen. Dass es genau diese Lücke mit
    -- genau diesem Zuwachs gibt — bzw. bei e–g keine —, prüft der Trigger
    -- messreihe_ersatzwert_luecke (ein CHECK sieht keine andere Tabelle).
    CONSTRAINT messreihe_ersatzwert_zuwachs_chk CHECK (coalesce(CASE
        WHEN NOT coalesce(messreihe_korrektur_wort('ersatzwert_methode', methode), false) THEN true
        WHEN messreihe_korrektur_merkmal('ersatzwert_methode', methode, 'zuwachs') = 'gemessen'
          THEN luecke_ereignis_id IS NOT NULL AND zuwachs IS NOT NULL AND stand_vor IS NOT NULL
               AND stand_nach IS NOT NULL AND zuwachs = stand_nach - stand_vor AND zuwachs >= 0
        ELSE luecke_ereignis_id IS NULL AND zuwachs IS NULL AND stand_vor IS NULL AND stand_nach IS NULL
      END, false)),
    -- Worauf sich der Wert stützt — genau das, was die Methode nennt, und nichts sonst.
    CONSTRAINT messreihe_ersatzwert_bezug_chk CHECK (coalesce(CASE
        WHEN NOT coalesce(messreihe_korrektur_wort('ersatzwert_methode', methode), false) THEN true
        ELSE (vorperiode_von IS NOT NULL)
               = (messreihe_korrektur_merkmal('ersatzwert_methode', methode, 'bezug') IS NOT DISTINCT FROM 'vorperiode')
             AND (vorperiode_von IS NULL OR (uems_viertelstunde_raster(vorperiode_von) AND vorperiode_von < von))
             AND (vergleich_quelle_id IS NOT NULL)
               = (messreihe_korrektur_merkmal('ersatzwert_methode', methode, 'bezug') IS NOT DISTINCT FROM 'vergleichsquelle')
             AND (endstand IS NOT NULL OR anfangsstand IS NOT NULL)
               = (messreihe_korrektur_merkmal('ersatzwert_methode', methode, 'bezug') IS NOT DISTINCT FROM 'ablesestaende')
             AND (betrag IS NOT NULL)
               = (messreihe_korrektur_merkmal('ersatzwert_methode', methode, 'bezug') IS NOT DISTINCT FROM 'betrag')
             -- e: „Wert eingeben (mit Beleg)“ — ohne Beleg keine eingegebene Zahl.
             AND (betrag IS NULL OR beleg IS NOT NULL)
      END, false)),
    -- Eine Zahl ohne Einheit ist keine Menge: Zuwachs, Ablesestand und Betrag nennen
    -- sie; Vorperiode und Vergleichsquelle bringen ihre eigene mit.
    CONSTRAINT messreihe_ersatzwert_einheit_chk CHECK (coalesce(CASE
        WHEN NOT coalesce(messreihe_korrektur_wort('ersatzwert_methode', methode), false) THEN true
        ELSE (einheit IS NOT NULL) = (zuwachs IS NOT NULL OR endstand IS NOT NULL OR anfangsstand IS NOT NULL
                                      OR betrag IS NOT NULL)
             AND (einheit IS NULL OR (btrim(einheit) <> '' AND length(einheit) <= 16))
      END, false)),
    -- d: der Ablesestand auf die volle Minute, in (von, bis] einer Viertelstunde.
    CONSTRAINT messreihe_ersatzwert_zeitpunkt_chk CHECK (coalesce(CASE
        WHEN NOT coalesce(messreihe_korrektur_wort('ersatzwert_methode', methode), false) THEN true
        ELSE (zeitpunkt IS NOT NULL)
               = (messreihe_korrektur_merkmal('ersatzwert_methode', methode, 'zeitform') = 'zeitpunkt')
             AND (zeitpunkt IS NULL OR (
                   date_trunc('minute', zeitpunkt AT TIME ZONE 'UTC') = zeitpunkt AT TIME ZONE 'UTC'
                   AND von < zeitpunkt AND zeitpunkt <= bis
                   AND (bis AT TIME ZONE 'UTC') = (von AT TIME ZONE 'UTC') + INTERVAL '15 minutes'))
      END, false)),
    -- Begründung Pflicht (Fassung 1), Grund Pflicht, wo der Status es sagt.
    CONSTRAINT messreihe_ersatzwert_begruendung_chk CHECK (coalesce(
        (begruendung IS NULL OR messreihe_korrektur_text_gueltig(begruendung))
        AND (beleg IS NULL OR messreihe_korrektur_text_gueltig(beleg))
        AND (grund IS NULL OR messreihe_korrektur_text_gueltig(grund))
        AND (fassung = 1 OR grund IS NOT NULL
             OR messreihe_korrektur_merkmal('ersatzwert_status', status, 'grund_pflicht') IS DISTINCT FROM 'true'),
        false)),
    CONSTRAINT messreihe_ersatzwert_zahl_chk CHECK (
        coalesce(zuwachs <> 'NaN'::numeric, true) AND coalesce(stand_vor <> 'NaN'::numeric, true)
        AND coalesce(stand_nach <> 'NaN'::numeric, true) AND coalesce(endstand <> 'NaN'::numeric, true)
        AND coalesce(anfangsstand <> 'NaN'::numeric, true) AND coalesce(betrag <> 'NaN'::numeric, true)),
    CONSTRAINT messreihe_ersatzwert_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messreihe_ersatzwert_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messreihe_ersatzwert_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

-- Der Leseweg „welche Ersatzwerte hat diese Reihe?“ — nur die anlegenden Zeilen.
CREATE INDEX IF NOT EXISTS idx_messreihe_ersatzwert_reihe
    ON messreihe_ersatzwert (tenant_id, entity_id, messkanal, von)
    WHERE fassung = 1;

-- -----------------------------------------------------------------------------
-- 4. messreihe_korrektur — die Korrektur
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_korrektur (
    tenant_id           UUID        NOT NULL,
    -- K-<Jahr>-<lfd. Nr.> je Kundenbereich (§4.6); vergeben vom Schreibweg.
    kennung             TEXT        NOT NULL,
    fassung             INTEGER     NOT NULL,
    status              TEXT        NOT NULL,
    -- ---- Fassung 1: was die Korrektur ausmacht ---------------------------------
    art                 TEXT,
    -- Die betroffenen Reihe(n): [{"entity_id": …, "messkanal": …}, …].
    reihen              JSONB,
    -- Der betroffene Zeitraum, halboffen auf das Viertelstunden-Raster.
    von                 TIMESTAMPTZ,
    bis                 TIMESTAMPTZ,
    -- Pflicht; bei System-Vorschlägen vorbelegt (§4.6).
    begruendung         TEXT,
    beleg               TEXT,
    -- Nur Art `ersatzwert`: der Ersatzwert, den sie wirksam macht.
    ersatzwert_kennung  TEXT,
    ersatzwert_fassung  INTEGER GENERATED ALWAYS AS (CASE WHEN ersatzwert_kennung IS NULL THEN NULL ELSE 1 END) STORED,
    -- Die Vorschau alt/neu je Periode (Prüfung, E8/E14) — ihr Inhalt ist IP-14.
    vorschau            JSONB,
    -- ---- Fassung > 1: die Fortschreibung ----------------------------------------
    grund               TEXT,
    -- Wer DIESE Fassung schrieb: Fassung 1 = Ersteller, freigegeben = Freigeber,
    -- abgelehnt = wer prüfte, zurueckgenommen = wer widerrief. Ersteller und
    -- Freigeber sind damit zwei Zeilen, nie zwei Spalten, die man vertauschen kann.
    actor_sub           TEXT,
    actor_name          TEXT        NOT NULL,
    actor_rolle         TEXT,
    actor_art           TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_korrektur_pk PRIMARY KEY (tenant_id, kennung, fassung),
    CONSTRAINT messreihe_korrektur_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Der Ersatzwert, über seine anlegende Fassung, im selben Kundenbereich.
    CONSTRAINT messreihe_korrektur_ersatzwert_fk
        FOREIGN KEY (tenant_id, ersatzwert_kennung, ersatzwert_fassung)
        REFERENCES messreihe_ersatzwert (tenant_id, kennung, fassung) ON DELETE RESTRICT,
    CONSTRAINT messreihe_korrektur_kennung_chk CHECK (kennung ~ '^K-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT messreihe_korrektur_fassung_chk CHECK (fassung >= 1),
    CONSTRAINT messreihe_korrektur_status_chk
        CHECK (coalesce(messreihe_korrektur_wort('korrektur_status', status), false)),
    CONSTRAINT messreihe_korrektur_art_chk
        CHECK (art IS NULL OR coalesce(messreihe_korrektur_wort('korrektur_art', art), false)),
    -- E14: eine Korrektur beginnt IMMER als Vorschlag — auch die eines Menschen bei
    -- ausgeschalteter Vier-Augen-Prüfung (dann folgt die Freigabe derselben Person).
    CONSTRAINT messreihe_korrektur_anfang_chk CHECK (
        NOT coalesce(messreihe_korrektur_wort('korrektur_status', status), false)
        OR (fassung = 1) = coalesce(messreihe_korrektur_merkmal('korrektur_status', status, 'anfang') = 'true', false)),
    CONSTRAINT messreihe_korrektur_anlage_chk CHECK (coalesce(
        (fassung = 1 AND art IS NOT NULL AND reihen IS NOT NULL AND von IS NOT NULL AND bis IS NOT NULL
         AND begruendung IS NOT NULL AND vorschau IS NOT NULL AND grund IS NULL)
        OR (fassung > 1 AND art IS NULL AND reihen IS NULL AND von IS NULL AND bis IS NULL
            AND begruendung IS NULL AND beleg IS NULL AND ersatzwert_kennung IS NULL AND vorschau IS NULL),
        false)),
    CONSTRAINT messreihe_korrektur_reihen_chk
        CHECK (reihen IS NULL OR coalesce(messreihe_korrektur_reihen_gueltig(reihen), false)),
    CONSTRAINT messreihe_korrektur_zeitraum_chk CHECK (von IS NULL OR coalesce(
        von < bis AND uems_viertelstunde_raster(von) AND uems_viertelstunde_raster(bis), false)),
    -- Die Art sagt, ob ein Ersatzwert dazugehört und ob ein Beleg Pflicht ist.
    CONSTRAINT messreihe_korrektur_art_merkmal_chk CHECK (coalesce(CASE
        WHEN NOT coalesce(messreihe_korrektur_wort('korrektur_art', art), false) THEN true
        ELSE (ersatzwert_kennung IS NOT NULL) = (messreihe_korrektur_merkmal('korrektur_art', art, 'nennt_ersatzwert') = 'true')
             AND (beleg IS NOT NULL OR messreihe_korrektur_merkmal('korrektur_art', art, 'beleg_pflicht') = 'false')
      END, false)),
    CONSTRAINT messreihe_korrektur_begruendung_chk CHECK (coalesce(
        (begruendung IS NULL OR messreihe_korrektur_text_gueltig(begruendung))
        AND (beleg IS NULL OR messreihe_korrektur_text_gueltig(beleg))
        AND (grund IS NULL OR messreihe_korrektur_text_gueltig(grund))
        AND (fassung = 1 OR grund IS NOT NULL
             OR messreihe_korrektur_merkmal('korrektur_status', status, 'grund_pflicht') IS DISTINCT FROM 'true'),
        false)),
    CONSTRAINT messreihe_korrektur_vorschau_chk
        CHECK (vorschau IS NULL OR coalesce(jsonb_typeof(vorschau) = 'array' AND jsonb_array_length(vorschau) >= 1, false)),
    CONSTRAINT messreihe_korrektur_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messreihe_korrektur_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messreihe_korrektur_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

-- „Welche Korrekturen berühren diese Reihe?“ (Verlauf-Marker, Korrektur-Liste).
CREATE INDEX IF NOT EXISTS idx_messreihe_korrektur_reihen
    ON messreihe_korrektur USING gin (reihen jsonb_path_ops)
    WHERE fassung = 1;
-- Der Fremdschlüssel zum Ersatzwert, von der Seite der Korrektur.
CREATE INDEX IF NOT EXISTS idx_messreihe_korrektur_ersatzwert
    ON messreihe_korrektur (tenant_id, ersatzwert_kennung)
    WHERE ersatzwert_kennung IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 5. Trigger: nie geändert, lückenlos fortgeschrieben, und die Lücke hinter a–g
-- -----------------------------------------------------------------------------
-- Ein UPDATE ist nie eine Korrektur — für JEDE Rolle, auch mit Recht.
CREATE OR REPLACE FUNCTION messreihe_korrektur_nie_geaendert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% ist append-only: eine Rücknahme oder Entscheidung ist eine neue Fassung', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;

DROP TRIGGER IF EXISTS messreihe_ersatzwert_append_only ON messreihe_ersatzwert;
CREATE TRIGGER messreihe_ersatzwert_append_only BEFORE UPDATE ON messreihe_ersatzwert
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_nie_geaendert();
DROP TRIGGER IF EXISTS messreihe_korrektur_append_only ON messreihe_korrektur;
CREATE TRIGGER messreihe_korrektur_append_only BEFORE UPDATE ON messreihe_korrektur
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_nie_geaendert();

-- Fassung n folgt auf Fassung n − 1, und ihr Status folgt auf deren Status
-- (`folgt_auf` im Vokabular). Zwei gleichzeitige Fortschreibungen derselben
-- Fassung trifft der Primärschlüssel — eine gewinnt, nie beide.
CREATE OR REPLACE FUNCTION messreihe_korrektur_fassung_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  status_vokabular TEXT := CASE TG_TABLE_NAME WHEN 'messreihe_ersatzwert' THEN 'ersatzwert_status'
                                              ELSE 'korrektur_status' END;
  vorher TEXT;
BEGIN
  IF NEW.fassung = 1 THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT status FROM public.%I WHERE tenant_id = $1 AND kennung = $2 AND fassung = $3',
                 TG_TABLE_NAME)
     INTO vorher USING NEW.tenant_id, NEW.kennung, NEW.fassung - 1;
  IF vorher IS NULL THEN
    RAISE EXCEPTION '% %: Fassung % folgt auf keine Fassung %', TG_TABLE_NAME, NEW.kennung, NEW.fassung,
          NEW.fassung - 1
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_fassung_lueckenlos';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.messreihe_korrektur_vokabular() v
                  WHERE v.vokabular = status_vokabular AND v.wort = NEW.status
                    AND vorher = ANY (v.folgt_auf)) THEN
    RAISE EXCEPTION '% %: % folgt nicht auf %', TG_TABLE_NAME, NEW.kennung, NEW.status, vorher
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_status_folgt';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messreihe_ersatzwert_fassung_folgt ON messreihe_ersatzwert;
CREATE TRIGGER messreihe_ersatzwert_fassung_folgt BEFORE INSERT ON messreihe_ersatzwert
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_fassung_folgt();
DROP TRIGGER IF EXISTS messreihe_korrektur_fassung_folgt ON messreihe_korrektur;
CREATE TRIGGER messreihe_korrektur_fassung_folgt BEFORE INSERT ON messreihe_korrektur
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_fassung_folgt();

-- E7 in der Datenbank. a–c: die genannte Lücke gibt es — dieselbe Reihe, geschlossen,
-- mit GENAU diesem Zuwachs und diesen Ständen — und der Zeitraum liegt in ihren
-- Viertelstunden. e–g: KEINE Lücke mit gemessenem Zuwachs berührt Reihe und
-- Zeitraum. Gelesen wird mit den Rechten des Schreibers (RLS: nur sein
-- Kundenbereich). Eine offene Lücke hat noch keinen Zuwachs (der Lücken-Melder
-- schreibt ihn beim Schließen fort) und hält darum e–g nicht auf.
CREATE OR REPLACE FUNCTION messreihe_ersatzwert_luecke() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  regel TEXT;
BEGIN
  IF NEW.fassung <> 1 OR NOT coalesce(messreihe_korrektur_wort('ersatzwert_methode', NEW.methode), false) THEN
    RETURN NEW;
  END IF;
  regel := messreihe_korrektur_merkmal('ersatzwert_methode', NEW.methode, 'zuwachs');
  IF regel = 'gemessen' THEN
    IF NOT EXISTS (
        SELECT 1 FROM public.messreihe_ereignis e
         WHERE e.tenant_id = NEW.tenant_id AND e.ereignis_id = NEW.luecke_ereignis_id
           AND e.art = 'data_gap' AND e.entity_id = NEW.entity_id AND e.messkanal = NEW.messkanal
           AND e.bis IS NOT NULL AND jsonb_exists(e.nutzlast, 'zuwachs')
           AND (e.nutzlast ->> 'zuwachs')::numeric = NEW.zuwachs
           AND (e.nutzlast ->> 'stand_vor')::numeric = NEW.stand_vor
           AND (e.nutzlast ->> 'stand_nach')::numeric = NEW.stand_nach
           AND e.nutzlast ->> 'einheit' = NEW.einheit
           AND NEW.von >= to_timestamp((floor(extract(epoch FROM e.von) / 900) * 900)::double precision)
           AND NEW.bis <= to_timestamp((ceil(extract(epoch FROM e.bis) / 900) * 900)::double precision)) THEN
      RAISE EXCEPTION 'Ersatzwert % (%): keine Lücke mit genau diesem gemessenen Zuwachs an Reihe und Zeitraum',
            NEW.kennung, NEW.methode
        USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_ersatzwert_zuwachs_gemessen';
    END IF;
  ELSIF regel = 'keiner' THEN
    IF EXISTS (
        SELECT 1 FROM public.messreihe_ereignis e
         WHERE e.tenant_id = NEW.tenant_id AND e.art = 'data_gap'
           AND e.entity_id = NEW.entity_id AND e.messkanal = NEW.messkanal
           AND e.zeit < NEW.bis AND jsonb_exists(e.nutzlast, 'zuwachs')
           AND tstzrange(e.von, e.bis, '[)') && tstzrange(NEW.von, NEW.bis, '[)')) THEN
      RAISE EXCEPTION 'Ersatzwert % (%): über diesen Zeitraum ist ein Zuwachs gemessen — er wird verteilt (a–c), nie ersetzt',
            NEW.kennung, NEW.methode
        USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_ersatzwert_ohne_zuwachs';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messreihe_ersatzwert_luecke ON messreihe_ersatzwert;
CREATE TRIGGER messreihe_ersatzwert_luecke BEFORE INSERT ON messreihe_ersatzwert
    FOR EACH ROW EXECUTE FUNCTION messreihe_ersatzwert_luecke();

-- Die Korrektur zu einem Ersatzwert berührt seine Reihe und umfasst seinen
-- Zeitraum. (Dass es ihn gibt, sagt der Fremdschlüssel.)
CREATE OR REPLACE FUNCTION messreihe_korrektur_ersatzwert_passt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ew RECORD;
BEGIN
  IF NEW.fassung <> 1 OR NEW.ersatzwert_kennung IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT entity_id, messkanal, von, bis INTO ew FROM public.messreihe_ersatzwert
   WHERE tenant_id = NEW.tenant_id AND kennung = NEW.ersatzwert_kennung AND fassung = 1;
  IF FOUND AND NOT coalesce(
       NEW.reihen @> jsonb_build_array(jsonb_build_object('entity_id', ew.entity_id::text, 'messkanal', ew.messkanal))
       AND NEW.von <= ew.von AND ew.bis <= NEW.bis, false) THEN
    RAISE EXCEPTION 'Korrektur %: Ersatzwert % liegt nicht in ihren Reihen und ihrem Zeitraum',
          NEW.kennung, NEW.ersatzwert_kennung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_korrektur_ersatzwert_passt';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messreihe_korrektur_ersatzwert_passt ON messreihe_korrektur;
CREATE TRIGGER messreihe_korrektur_ersatzwert_passt BEFORE INSERT ON messreihe_korrektur
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_ersatzwert_passt();

-- -----------------------------------------------------------------------------
-- 6. Der Zaun
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_ersatzwert ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_ersatzwert FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_ersatzwert_tenant_isolation ON messreihe_ersatzwert;
CREATE POLICY messreihe_ersatzwert_tenant_isolation ON messreihe_ersatzwert
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_korrektur ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_korrektur FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_korrektur_tenant_isolation ON messreihe_korrektur;
CREATE POLICY messreihe_korrektur_tenant_isolation ON messreihe_korrektur
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- 7. Rechte
-- -----------------------------------------------------------------------------
-- V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue Tabelle
-- — hier wird ALLES genommen und eng neu gegeben. Die App liest und hängt an, nie
-- ändern, nie löschen; die Erfassungszeit setzt die Datenbank (`created_at` fehlt
-- in der Spaltenliste, `ersatzwert_fassung` ist berechnet). Die BYPASSRLS-Rolle
-- liest und löscht nur (das Offboarding); die Vorschläge des Systems (IP-14)
-- bringen ihr INSERT mit, wenn es sie gibt. Kein BIGSERIAL, kein Sequenz-Recht.
REVOKE ALL ON messreihe_ersatzwert, messreihe_korrektur FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT ON messreihe_ersatzwert TO ${appDbUser};
GRANT INSERT (tenant_id, kennung, fassung, status, methode, entity_id, messkanal, messstelle_id, von, bis,
              zeitpunkt, begruendung, beleg, luecke_ereignis_id, zuwachs, stand_vor, stand_nach, einheit,
              vorperiode_von, vergleich_quelle_id, endstand, anfangsstand, betrag, grund,
              actor_sub, actor_name, actor_rolle, actor_art)
    ON messreihe_ersatzwert TO ${appDbUser};

GRANT SELECT ON messreihe_korrektur TO ${appDbUser};
GRANT INSERT (tenant_id, kennung, fassung, status, art, reihen, von, bis, begruendung, beleg,
              ersatzwert_kennung, vorschau, grund, actor_sub, actor_name, actor_rolle, actor_art)
    ON messreihe_korrektur TO ${appDbUser};

GRANT SELECT, DELETE ON messreihe_ersatzwert, messreihe_korrektur TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 8. Was sie bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION messreihe_korrektur_vokabular() IS
    'Die Woerter von Ersatzwert und Korrektur (AP-08 IP-12): vokabular.ersatzwert_methode, '
    'ersatzwert_status, korrektur_art, korrektur_status aus events-vocabulary-vectors.json, Zeile '
    'fuer Zeile; die EINE Stelle, die jeder CHECK der beiden Tabellen fragt.';
COMMENT ON TABLE messreihe_ersatzwert IS
    'UEMS AP-08 IP-12: der Ersatzwert (EW-<Jahr>-<Nr.>) - eine gesetzte Zahl, die der Zaehler nie '
    'geliefert hat: begruendet, mit Methode a-g (E7), widerrufbar, nie geloescht. Append-only: '
    'Fassung 1 legt an, jede weitere schreibt nur den Status fort. a-c verteilen nur einen '
    'GEMESSENEN Zuwachs (Summe = Zuwachs), e-g stehen nur, wo keiner gemessen ist (Trigger). '
    'Kein Rohwert wird angefasst.';
COMMENT ON TABLE messreihe_korrektur IS
    'UEMS AP-08 IP-12: die Korrektur (K-<Jahr>-<Nr.>) - Vorschlag, freigegeben, abgelehnt, '
    'zurueckgenommen (E8, E14: beginnt immer als Vorschlag). Append-only: Fassung 1 legt an '
    '(Art, Reihen, Zeitraum, Begruendung, Vorschau), jede weitere schreibt den Status mit Urheber '
    'fort. Die Erkennung nach der Frist steht in messreihe_korrektur_vorschlag (AP-07) - die '
    'Vorstufe, nicht dieselbe Aussage.';
COMMENT ON COLUMN messreihe_ersatzwert.luecke_ereignis_id IS
    'a-c: die data_gap-Meldung, deren gemessenen Zuwachs der Ersatzwert verteilt; der Trigger '
    'messreihe_ersatzwert_luecke prueft Reihe, Zuwachs, Staende, Einheit und Zeitraum gegen sie.';
COMMENT ON COLUMN messreihe_korrektur.vorschau IS
    'Die Vorschau alt/neu je Periode (AP-08 §4.6), ein nicht leeres Array. Ihr Inhalt entsteht mit '
    'der Vorschlags-Erzeugung (IP-14); diese Tabelle haelt nur die Form.';
