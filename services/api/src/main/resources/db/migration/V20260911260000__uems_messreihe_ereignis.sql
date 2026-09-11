-- UEMS AP-07 IP-8: die Ereignis-Tabelle je Kundenbereich — append-only, nie gelöscht.
--
-- messreihe_ereignis nimmt JEDES Ereignis des geschlossenen Vokabulars auf
-- (docs/contracts/v2/events-vocabulary.md, Entscheid E11 = A), gleich von wem:
-- vom Writer aus seinem Bestandsweg (die sechs Arten, die er heute in
-- device_measurement_event schreibt — dort schreibt er UNVERÄNDERT weiter, bis
-- der Lesepfad IP-14 umzieht), vom Writer aus dem Redpanda-Topic `events.raw`
-- (Box, Datenannahme, Writer, Cloud, Kunde) und aus der api
-- (MessreiheEreignisRepository, für Gerätegrenze und Übergabe).
--
-- ⚠ NIE GELÖSCHT (AP-07 §4.3, E8, §4.9 Nr. 7). Keine Retention, keine
-- Kompression (RLS-Tabelle, E7), KEIN Fremdschlüssel auf etwas Löschbares
-- (Anlage, Box, Komponente, Datenquelle, Messstelle, Gerät): ein Ereignis
-- überlebt Unclaim, Purge und das Löschen einer Anlage. Der EINE Löschweg ist
-- das Offboarding des Kundenbereichs (TenantRepository.offboard, Admin-Rolle);
-- `tenant_id` hängt deshalb RESTRICT am Mandanten.
--
-- ⚠ UNVERÄNDERLICH. Die App-Rolle (api UND Writer verbinden als dieselbe
-- ${appDbUser}) darf lesen und anhängen, nie ändern, nie löschen; die
-- Admin-Rolle liest und löscht (nur fürs Offboarding), ändert nie; ein
-- Trigger lehnt JEDES UPDATE ab. Eine Korrektur ist ein neues Ereignis.
--
-- EINE ZEILE = EINE MELDUNG. Ein offenes Ereignis (`data_gap`, `handover`)
-- wird nie per UPDATE geschlossen, sondern FORTGESCHRIEBEN: eine weitere Zeile
-- mit derselben `ereignis_id` (Vertrag §3), die erste Meldung bleibt lesbar.
-- Der Bezug der Folge-Meldung auf ihre erste Meldung IST die gemeinsame
-- `ereignis_id`; die jüngste Meldung (`eingang`) ist der Stand des Ereignisses.
-- Welche Felder eine Fortschreibung setzen darf, prüft der Schreibweg mit
-- EreignisVokabular.pruefeFortschreibung (api) bzw. seinem Writer-Zwilling.
--
-- IDEMPOTENZ: `meldung` ist der Fingerabdruck der GANZEN Meldung ohne
-- Eingangszeit (md5 über Kennung, Art, Urheber, Zeiten, Bezug, Nutzlast,
-- Herkunft — gesetzt vom Trigger, nie vom Aufrufer). Eine erneut zugestellte
-- identische Meldung trifft `uq_messreihe_ereignis_meldung` und erzeugt keine
-- zweite Zeile (ON CONFLICT DO NOTHING); eine Fortschreibung unterscheidet
-- sich in mindestens einem Feld und wird angehängt.
--
-- DER BEZUG, WIE GEMELDET, UND WIE AUFGELÖST. Der Vertrag nennt Box,
-- Datenquelle, Komponente und Messstelle mit einer KENNUNG (Box aus dem Topic
-- als UUID, Datenquelle „DQ-4“, Messstelle „MS-06“ …). `kennungen` hält sie
-- wörtlich; `device_id`, `data_source_id`, `entity_id`, `messstelle_id`
-- halten, wozu der Schreibweg sie eindeutig auflösen konnte (UUID-Form
-- wörtlich, DQ-n/MS-n über die Kennzeichen-Tabellen des Kundenbereichs) —
-- sonst NULL, nie geraten. `messkanal` ist Text und braucht keine Auflösung.
-- `geraet_id` (Gerät-Einbau) und `site_id` (Anlage) sind Herkunft, kein
-- Vertrags-Bezug.
--
-- DER BESTANDSWEG (`aus_bestand`). Was der Writer aus device_measurement_event
-- spiegelt, kennt nur Box + Punkt (`point_key` = Messkanal), nie die
-- Komponente, und die `_pipeline`-Lücke hat keinen Zeitraum, nur den
-- Zeitpunkt des Umschlags, der sie meldete (die Box hat verdrängt: Urheber
-- `box`, `erkannt_aus = verdraengung`, gezählte Werte als `erwartet_fehlend`).
-- Diese Zeilen sind gekennzeichnet und von der Bezug- und Zeitraum-Pflicht
-- ausgenommen — sonst gilt für sie jede Regel; `messreihe_ereignis_bestand_chk`
-- hält die Ausnahme eng.
--
-- DAS VOKABULAR IN DER DATENBANK. messreihe_ereignis_vokabular() ist die EINE
-- Stelle, an der das Vokabular hier steht (je Art Urheber, Zeitform, Bezug,
-- Felder, Fortschreibbares, Bestand); die CHECKs fragen es. Dieselben Fakten
-- wie EreignisVokabular.Art und events-vocabulary-vectors.json —
-- MessreiheEreignisMigrationTest beweist die Gleichheit Zeile für Zeile. Eine
-- neue Art kommt mit einer neuen Migration, die DIESEN Stand abschreibt
-- (Funktion ersetzen, `messreihe_ereignis_art_chk` weiten).

-- -----------------------------------------------------------------------------
-- Das Vokabular
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
    ('late_arrival', ARRAY['writer']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['eingangszeit', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('counter_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['stand_alt', 'stand_neu']::text[],
     ARRAY['messzeit_alt', 'einheit']::text[],
     '{}'::text[], true),
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

-- Urheber je Art (Vertrag §4, Prüfschritt 3 „urheber_unzulaessig“).
CREATE OR REPLACE FUNCTION messreihe_ereignis_urheber_erlaubt(p_art TEXT, p_urheber TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM messreihe_ereignis_vokabular() v
                 WHERE v.art = p_art AND p_urheber = ANY (v.urheber))
$$;

-- Die Zeitform (Prüfschritt 6 „zeit_ungueltig“): ein Zeitpunkt hat weder `von`
-- noch `bis`; ein Zeitraum beginnt mit `von` (= `zeit`, der Spalte der
-- Hypertable) und endet nach `von` (halboffen) bzw. nicht davor (geschlossen);
-- offen (`bis` NULL) nur, wo die Art es erlaubt, und nie von der Box. Minute und
-- Viertelstunden-Raster bleiben Regeln des Schreibwegs.
CREATE OR REPLACE FUNCTION messreihe_ereignis_zeit_erlaubt(
    p_art TEXT, p_urheber TEXT, p_zeit TIMESTAMPTZ, p_von TIMESTAMPTZ, p_bis TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE((
    SELECT CASE
             WHEN v.zeitform = 'zeitpunkt' THEN p_von IS NULL AND p_bis IS NULL
             WHEN p_von IS NULL OR p_zeit IS DISTINCT FROM p_von THEN false
             WHEN p_bis IS NULL THEN v.offen_erlaubt AND p_urheber <> 'box'
             WHEN v.grenzen = 'halboffen' THEN p_bis > p_von
             ELSE p_bis >= p_von
           END
      FROM messreihe_ereignis_vokabular() v WHERE v.art = p_art), false)
$$;

-- Der Bezug (Prüfschritt 4 „schema_verletzt“): die Pflicht-Bezüge der Art sind
-- da, kein Bezug, den die Art nicht kennt; `kennungen` trägt nur Box,
-- Datenquelle, Komponente und Messstelle, jede als Text.
CREATE OR REPLACE FUNCTION messreihe_ereignis_bezug_erlaubt(
    p_art TEXT, p_kennungen JSONB, p_messkanal TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_kennungen) IS DISTINCT FROM 'object' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_each(p_kennungen) k
                WHERE k.key NOT IN ('box', 'datenquelle', 'komponente', 'messstelle')
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

-- Die Nutzlast (Prüfschritt 4 „schema_verletzt“): genau die Felder der Art —
-- alle Pflichtfelder, sonst nur ihre erlaubten. Typen und Regeln prüft der
-- Schreibweg (EreignisVokabular); die Datenbank hält den Rahmen.
CREATE OR REPLACE FUNCTION messreihe_ereignis_nutzlast_erlaubt(p_art TEXT, p_nutzlast JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_nutzlast) IS DISTINCT FROM 'object' THEN false ELSE
    COALESCE((
      SELECT v.pflicht <@ k.felder AND k.felder <@ (v.pflicht || v.felder)
        FROM messreihe_ereignis_vokabular() v,
             LATERAL (SELECT ARRAY(SELECT jsonb_object_keys(p_nutzlast)) AS felder) k
       WHERE v.art = p_art), false)
  END
$$;

-- -----------------------------------------------------------------------------
-- Die Tabelle
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_ereignis (
    -- Die Zeit des Ereignisses auf seiner Achse: der Zeitpunkt, bzw. `von` eines
    -- Zeitraums; beim Bestandsweg der Zeitpunkt des Umschlags (occurred_at).
    zeit            TIMESTAMPTZ NOT NULL,
    tenant_id       UUID        NOT NULL,
    -- Fingerabdruck dieser Meldung (Trigger), der Idempotenz-Schlüssel.
    meldung         UUID        NOT NULL,
    -- Die Kennung des Ereignisses, vom Urheber vergeben; eine Wiederholung und
    -- eine Fortschreibung tragen dieselbe.
    ereignis_id     UUID        NOT NULL,
    art             TEXT        NOT NULL,
    urheber         TEXT        NOT NULL,
    von             TIMESTAMPTZ,
    -- NULL: offen (nur data_gap/handover, nie von der Box) oder beim Bestandsweg
    -- unbekannt.
    bis             TIMESTAMPTZ,
    site_id         UUID,
    kennungen       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    device_id       UUID,
    data_source_id  UUID,
    entity_id       UUID,
    messkanal       TEXT,
    messstelle_id   UUID,
    geraet_id       UUID,
    nutzlast        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    aus_bestand     BOOLEAN     NOT NULL DEFAULT false,
    -- Die Eingangszeit: `ingested_at` von events.raw bzw. des Umschlags, sonst
    -- der Augenblick des Anhängens.
    eingang         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_ereignis_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
        'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
        'late_arrival', 'counter_reset', 'device_boundary', 'handover', 'unassigned_reader',
        'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart', 'device_restart',
        'frozen_source', 'range_limit', 'layout_changed', 'error_change', 'state_change',
        'bitfield_change', 'text_change')),
    CONSTRAINT messreihe_ereignis_urheber_chk
        CHECK (messreihe_ereignis_urheber_erlaubt(art, urheber)),
    CONSTRAINT messreihe_ereignis_zeit_chk
        CHECK (aus_bestand OR messreihe_ereignis_zeit_erlaubt(art, urheber, zeit, von, bis)),
    CONSTRAINT messreihe_ereignis_bezug_chk
        CHECK (aus_bestand OR messreihe_ereignis_bezug_erlaubt(art, kennungen, messkanal)),
    CONSTRAINT messreihe_ereignis_nutzlast_chk
        CHECK (messreihe_ereignis_nutzlast_erlaubt(art, nutzlast)),
    -- Eine aufgelöste Kennung hat immer ihre gemeldete.
    CONSTRAINT messreihe_ereignis_aufgeloest_chk CHECK (
        (device_id IS NULL OR kennungen ? 'box')
        AND (data_source_id IS NULL OR kennungen ? 'datenquelle')
        AND (entity_id IS NULL OR kennungen ? 'komponente')
        AND (messstelle_id IS NULL OR kennungen ? 'messstelle')),
    CONSTRAINT messreihe_ereignis_messkanal_chk
        CHECK (messkanal IS NULL OR (btrim(messkanal) <> '' AND length(messkanal) <= 240)),
    -- Der Bestandsweg: nur seine sechs Arten, die Lücke von der Box (verdrängt),
    -- die Übergänge vom Writer; die Box ist bekannt und aufgelöst, sonst nichts;
    -- kein Zeitraum; ein Messkanal genau bei den Übergängen.
    CONSTRAINT messreihe_ereignis_bestand_chk CHECK (NOT aus_bestand OR (
        art IN ('state_change', 'error_change', 'bitfield_change', 'text_change',
                'counter_reset', 'data_gap')
        AND urheber = CASE WHEN art = 'data_gap' THEN 'box' ELSE 'writer' END
        AND von IS NULL AND bis IS NULL
        AND device_id IS NOT NULL
        AND kennungen = jsonb_build_object('box', device_id::text)
        AND data_source_id IS NULL AND entity_id IS NULL AND messstelle_id IS NULL
        AND geraet_id IS NULL
        AND (messkanal IS NULL) = (art = 'data_gap')))
);

-- 30-Tage-Chunks: Ereignisse sind dünn und bleiben für immer; ohne die
-- Vorgabe-Indizes (sie stünden ohne tenant_id vorn).
SELECT create_hypertable('messreihe_ereignis', 'zeit', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '30 days',
                         create_default_indexes => FALSE);

-- Die Idempotenz (Hypertable: die Zeit gehört in jeden eindeutigen Index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_ereignis_meldung
    ON messreihe_ereignis (tenant_id, meldung, zeit);
-- Die Meldungen EINES Ereignisses (Wiederholung? Fortschreibung?).
CREATE INDEX IF NOT EXISTS idx_messreihe_ereignis_ereignis
    ON messreihe_ereignis (tenant_id, ereignis_id);
-- Die späteren Leser: je Reihe, je Quelle, je Box, je Messstelle über die Zeit.
CREATE INDEX IF NOT EXISTS idx_messreihe_ereignis_reihe
    ON messreihe_ereignis (tenant_id, entity_id, messkanal, zeit DESC) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messreihe_ereignis_quelle
    ON messreihe_ereignis (tenant_id, data_source_id, zeit DESC) WHERE data_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messreihe_ereignis_box
    ON messreihe_ereignis (tenant_id, device_id, zeit DESC) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messreihe_ereignis_messstelle
    ON messreihe_ereignis (tenant_id, messstelle_id, zeit DESC) WHERE messstelle_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Der Fingerabdruck und die Unveränderlichkeit
-- -----------------------------------------------------------------------------
-- Zeiten als Epochensekunden: unabhängig von der Zeitzone der Sitzung. jsonb
-- ordnet die Schlüssel der Nutzlast selbst; der Array-Text trennt die Felder
-- eindeutig (NULL bleibt null, kein Feld verschiebt ein anderes).
CREATE OR REPLACE FUNCTION messreihe_ereignis_meldung() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.meldung := md5(jsonb_build_array(
      NEW.ereignis_id, NEW.art, NEW.urheber,
      extract(epoch FROM NEW.zeit), extract(epoch FROM NEW.von), extract(epoch FROM NEW.bis),
      NEW.site_id, NEW.kennungen, NEW.device_id, NEW.data_source_id, NEW.entity_id,
      NEW.messkanal, NEW.messstelle_id, NEW.geraet_id, NEW.nutzlast, NEW.aus_bestand)::text)::uuid;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messreihe_ereignis_meldung ON messreihe_ereignis;
CREATE TRIGGER messreihe_ereignis_meldung BEFORE INSERT ON messreihe_ereignis
    FOR EACH ROW EXECUTE FUNCTION messreihe_ereignis_meldung();

-- Dieselbe Funktion wie component_change_event (V20260843000000) und die
-- UEMS-Protokolle. NUR UPDATE: DELETE ist dem Offboarding vorbehalten (Grant).
DROP TRIGGER IF EXISTS messreihe_ereignis_append_only ON messreihe_ereignis;
CREATE TRIGGER messreihe_ereignis_append_only BEFORE UPDATE ON messreihe_ereignis
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_ereignis ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_ereignis FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_ereignis_tenant_isolation ON messreihe_ereignis;
CREATE POLICY messreihe_ereignis_tenant_isolation ON messreihe_ereignis
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte: V2/V4 ALTER DEFAULT PRIVILEGES gäben beiden Rollen ALLES — erst
-- zurücknehmen, dann eng erteilen. App (api + Writer): lesen, anhängen.
-- Admin: lesen, löschen (nur TenantRepository.offboard). UPDATE niemand.
-- -----------------------------------------------------------------------------
REVOKE ALL ON messreihe_ereignis FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON messreihe_ereignis TO ${appDbUser};
GRANT SELECT, DELETE ON messreihe_ereignis TO ${adminDbUser};

COMMENT ON TABLE messreihe_ereignis IS
    'Ereignisse je Kundenbereich (AP-07 IP-8): append-only, nie geloescht (nur Offboarding), '
    'ohne Retention und Kompression; eine Zeile je Meldung, Fortschreibung = weitere Zeile '
    'mit derselben ereignis_id; Vokabular in messreihe_ereignis_vokabular().';
COMMENT ON COLUMN messreihe_ereignis.meldung IS
    'md5-Fingerabdruck der ganzen Meldung ohne Eingangszeit (Trigger); Idempotenz-Schluessel.';
COMMENT ON COLUMN messreihe_ereignis.kennungen IS
    'Bezug wie gemeldet (box, datenquelle, komponente, messstelle); die *_id-Spalten sind die '
    'eindeutig aufgeloesten Kennungen, sonst NULL.';
COMMENT ON COLUMN messreihe_ereignis.aus_bestand IS
    'Vom Writer aus seinem Bestandsweg device_measurement_event gespiegelt: Box + Punkt, keine '
    'Komponente; data_gap ohne Zeitraum.';
