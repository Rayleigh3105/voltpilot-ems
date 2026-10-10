-- =============================================================================
-- UEMS AP-09 IP-7 — der Wert einer Bezugsgröße: eingeben, berichtigen, freigeben
-- =============================================================================
-- Der Schreibweg der Werte (POST /api/v1/bezugsgroessen/{id}/werte und
-- POST …/werte/{periode}/berichtigung) braucht zwei Dinge, die es noch nicht gibt:
--
--   1. Das Ereignis `correction` mit Bezug `bezugsgroesse` (F4, §6.1 des Konzepts).
--      messreihe_ereignis_vokabular() ist der Stand von V20260914140000 Zeichen für
--      Zeichen — nur die Zeile `correction` trägt die Bezugsgröße als zweiten Bezug
--      und die Felder `fassung_alt`, `fassung_neu`, `import`. Keiner der beiden Bezüge
--      ist in der LISTE Pflicht; GENAU EINEN (die Reihe komponente + messkanal ODER
--      die Bezugsgröße) prüft der Schreibweg (EreignisVokabular — wie „Reihe
--      unvollständig“ schon heute). Jede bisher angenommene Meldung bleibt
--      angenommen, jede verworfene verworfen, mit demselben Grund.
--      messreihe_ereignis_bezug_erlaubt() kennt `bezugsgroesse` als fünften
--      Schlüssel von `kennungen` (Text, wie die übrigen).
--   2. bezugsgroesse_berichtigung — der VORGANG einer Berichtigung (BK-<Jahr>-<Nr.>),
--      Muster messreihe_korrektur: Fassung 1 legt an, jede weitere trägt nur die
--      Entscheidung. Die Wert-Fassungen in bezugsgroesse_wert bleiben TATSACHEN in
--      der Nummerierung des Vertrags (B5: „Jonas gibt frei → Fassung 2 wirksam“ —
--      die freigegebene Berichtigung ist EINE Zeile mit Urheber UND Freigeber,
--      bezugsgroesse_wert_freigeber_chk). Ein offener Vorschlag ist noch keine
--      Fassung des Werts: er steht hier, bis eine zweite Person freigibt; dann
--      schreibt DIESELBE Transaktion die Wert-Fassung und das Ereignis. Bei
--      Vier-Augen aus (Vorgabe) ist der Vorgang sofort `freigegeben` (Fassung 1,
--      freigabe_vieraugen false) — so trägt JEDE Berichtigung ihre Kennung, und
--      `correction` nennt sie. Die Freigabe läuft über die Route aus AP-08 IP-15
--      (POST /api/v1/korrekturen/{kennung}/freigeben) — kein zweiter Weg.
--
-- Bestandsschutz: keine vorhandene Zeile wird geändert, kein Fremdschlüssel
-- verschärft, die neue Tabelle ist leer.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. `correction` mit Bezug `bezugsgroesse` — additiv
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
    'optional import; Kennung BK-...) — das Entweder-oder prüft der Schreibweg.';

-- -----------------------------------------------------------------------------
-- 2. Der Bezug: `kennungen` darf die Bezugsgröße nennen (V20260911260000, geweitet)
-- -----------------------------------------------------------------------------
-- Rahmen wie bisher: jeder Schlüssel ein Text, die Pflicht-Bezüge der Art da, kein
-- Bezug, den die Art nicht kennt. Neu ist nur der fünfte Schlüssel `bezugsgroesse`
-- (das Kennzeichen der Bezugsgröße zur Zeit der Meldung).
CREATE OR REPLACE FUNCTION messreihe_ereignis_bezug_erlaubt(
    p_art TEXT, p_kennungen JSONB, p_messkanal TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_kennungen) IS DISTINCT FROM 'object' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_each(p_kennungen) k
                WHERE k.key NOT IN ('box', 'datenquelle', 'komponente', 'messstelle', 'bezugsgroesse')
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
-- 3. bezugsgroesse_berichtigung — der Vorgang einer Berichtigung (F2–F4, E6)
-- -----------------------------------------------------------------------------
-- Fassung 1 legt an: die Bezugsgröße, die Periode (Tage, letzter EINSCHLIESSLICH,
-- wie bezugsgroesse_wert), die Wert-Fassung, die sie ersetzt, der neue Betrag, die
-- Begründung (10–500 Zeichen) und der Ersteller. Ihr Status ist `vorschlag` (Vier-
-- Augen an) oder sofort `freigegeben` (aus). Nach einem Vorschlag kommt GENAU EINE
-- Entscheidung: `freigegeben` (wer freigibt, Begründung, die Einstellung dieses
-- Augenblicks, die Wert-Fassung, die sie schrieb) oder `abgelehnt` (nur Grund —
-- eine Route dafür gibt es noch nicht, wie bei AP-08 IP-15). Nie geändert, nie
-- gelöscht (nur das Offboarding).
--
-- Die Wörter sind die von `korrektur_status` (messreihe_korrektur_vokabular(),
-- Vertrag events-vocabulary-vectors.json) — `zurueckgenommen` gibt es hier nicht:
-- eine Rücknahme ist eine neue Fassung des WERTS (C7, AP-09 IP-13).
CREATE TABLE IF NOT EXISTS bezugsgroesse_berichtigung (
    tenant_id           UUID          NOT NULL,
    -- BK-<Jahr>-<lfd. Nr.> je Kundenbereich; vergeben vom Schreibweg.
    kennung             TEXT          NOT NULL,
    fassung             INTEGER       NOT NULL,
    status              TEXT          NOT NULL,
    -- ---- Fassung 1: was die Berichtigung ausmacht -------------------------------
    bezugsgroesse_id    UUID,
    periode_von         DATE,
    periode_bis         DATE,
    zeitzone            TEXT,
    -- Die wirksame Wert-Fassung, die die Berichtigung ersetzt.
    ersetzt_fassung     INTEGER,
    -- In der Einheit der Bezugsgröße (U1), nie negativ (U6).
    betrag              NUMERIC(18, 6),
    begruendung         TEXT,
    -- Der eingegebene Text, wie er ankam („48.200“).
    geliefert_text      TEXT,
    -- ---- Fassung > 1: die Entscheidung -----------------------------------------
    grund               TEXT,
    -- Die Vier-Augen-Einstellung, unter der die Fassung entstand (AP-08 E8).
    freigabe_vieraugen  BOOLEAN,
    -- Die Wert-Fassung, die ein `freigegeben` in bezugsgroesse_wert schrieb.
    wert_fassung        INTEGER,
    -- Wer DIESE Fassung schrieb: Fassung 1 = Ersteller, eine Entscheidung = wer entschied.
    actor_sub           TEXT,
    actor_name          TEXT          NOT NULL,
    actor_rolle         TEXT,
    actor_art           TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT bezugsgroesse_berichtigung_pk PRIMARY KEY (tenant_id, kennung, fassung),
    CONSTRAINT bezugsgroesse_berichtigung_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_berichtigung_bezugsgroesse_fk
        FOREIGN KEY (bezugsgroesse_id, tenant_id) REFERENCES bezugsgroesse (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_berichtigung_kennung_chk CHECK (kennung ~ '^BK-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT bezugsgroesse_berichtigung_fassung_chk CHECK (fassung >= 1),
    CONSTRAINT bezugsgroesse_berichtigung_status_chk CHECK (coalesce(
        messreihe_korrektur_wort('korrektur_status', status) AND status <> 'zurueckgenommen', false)),
    -- Fassung 1 ist ein Vorschlag (an) oder sofort freigegeben (aus); danach eine Entscheidung.
    CONSTRAINT bezugsgroesse_berichtigung_anfang_chk CHECK (
        (fassung = 1 AND status IN ('vorschlag', 'freigegeben'))
        OR (fassung > 1 AND status IN ('freigegeben', 'abgelehnt'))),
    CONSTRAINT bezugsgroesse_berichtigung_anlage_chk CHECK (coalesce(
        (fassung = 1 AND bezugsgroesse_id IS NOT NULL AND periode_von IS NOT NULL AND periode_bis IS NOT NULL
         AND zeitzone IS NOT NULL AND ersetzt_fassung IS NOT NULL AND betrag IS NOT NULL
         AND begruendung IS NOT NULL AND grund IS NULL)
        OR (fassung > 1 AND bezugsgroesse_id IS NULL AND periode_von IS NULL AND periode_bis IS NULL
            AND zeitzone IS NULL AND ersetzt_fassung IS NULL AND betrag IS NULL AND begruendung IS NULL
            AND geliefert_text IS NULL AND grund IS NOT NULL),
        false)),
    -- E8: ein Vorschlag entsteht nur bei an, das sofortige Freigeben nur bei aus; eine
    -- Freigabe hält die Einstellung ihres Augenblicks fest.
    CONSTRAINT bezugsgroesse_berichtigung_vieraugen_chk CHECK (coalesce(CASE
        WHEN status = 'vorschlag' THEN freigabe_vieraugen IS TRUE
        WHEN fassung = 1 THEN freigabe_vieraugen IS FALSE
        WHEN status = 'freigegeben' THEN freigabe_vieraugen IS NOT NULL
        ELSE true END, false)),
    CONSTRAINT bezugsgroesse_berichtigung_wert_fassung_chk CHECK (coalesce(
        (status = 'freigegeben') = (wert_fassung IS NOT NULL)
        AND (wert_fassung IS NULL OR wert_fassung >= 2), false)),
    CONSTRAINT bezugsgroesse_berichtigung_periode_chk CHECK (periode_von IS NULL OR periode_von <= periode_bis),
    CONSTRAINT bezugsgroesse_berichtigung_ersetzt_chk CHECK (ersetzt_fassung IS NULL OR ersetzt_fassung >= 1),
    CONSTRAINT bezugsgroesse_berichtigung_betrag_chk CHECK (betrag IS NULL OR betrag >= 0),
    CONSTRAINT bezugsgroesse_berichtigung_zeitzone_chk
        CHECK (zeitzone IS NULL OR zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT bezugsgroesse_berichtigung_begruendung_chk CHECK (coalesce(
        (begruendung IS NULL OR bezugsdaten_begruendung_gueltig(begruendung))
        AND (grund IS NULL OR bezugsdaten_begruendung_gueltig(grund)), false)),
    CONSTRAINT bezugsgroesse_berichtigung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsgroesse_berichtigung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsgroesse_berichtigung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

COMMENT ON TABLE bezugsgroesse_berichtigung IS
    'UEMS AP-09 IP-7: der Vorgang einer Berichtigung eines Bezugsgrößen-Werts (BK-<Jahr>-<Nr.>). Fassung 1 = '
    'Vorschlag (Vier-Augen an) oder sofort freigegeben (aus); danach genau eine Entscheidung. Die Wert-Fassung '
    'entsteht in bezugsgroesse_wert erst mit der Freigabe. Append-only.';

-- „Liegt für diesen Wert ein Vorschlag vor?“ und das Lesemodell der Werte.
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_berichtigung_wert
    ON bezugsgroesse_berichtigung (tenant_id, bezugsgroesse_id, periode_von)
    WHERE fassung = 1;

-- Nie geändert — für JEDE Rolle (dieselbe Funktion wie messreihe_korrektur).
DROP TRIGGER IF EXISTS bezugsgroesse_berichtigung_append_only ON bezugsgroesse_berichtigung;
CREATE TRIGGER bezugsgroesse_berichtigung_append_only BEFORE UPDATE ON bezugsgroesse_berichtigung
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_nie_geaendert();

-- Lückenlos, genau eine Entscheidung nach einem Vorschlag, und bei Vier-Augen an
-- nie der Ersteller als Freigeber (E8 — die Datenbank sagt es noch einmal).
CREATE OR REPLACE FUNCTION bezugsgroesse_berichtigung_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  vorher    TEXT;
  ersteller TEXT;
BEGIN
  IF NEW.fassung = 1 THEN
    RETURN NEW;
  END IF;
  SELECT b.status INTO vorher FROM bezugsgroesse_berichtigung b
   WHERE b.tenant_id = NEW.tenant_id AND b.kennung = NEW.kennung AND b.fassung = NEW.fassung - 1;
  IF vorher IS NULL THEN
    RAISE EXCEPTION 'bezugsgroesse_berichtigung %: Fassung % folgt auf keine Fassung %', NEW.kennung, NEW.fassung,
          NEW.fassung - 1
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_berichtigung_fassung_lueckenlos';
  END IF;
  IF vorher <> 'vorschlag' THEN
    RAISE EXCEPTION 'bezugsgroesse_berichtigung %: über den Vorschlag ist schon entschieden (%)', NEW.kennung, vorher
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_berichtigung_status_folgt';
  END IF;
  IF NEW.status = 'freigegeben' AND NEW.freigabe_vieraugen IS TRUE THEN
    SELECT b.actor_sub INTO ersteller FROM bezugsgroesse_berichtigung b
     WHERE b.tenant_id = NEW.tenant_id AND b.kennung = NEW.kennung AND b.fassung = 1;
    IF ersteller IS NOT DISTINCT FROM NEW.actor_sub THEN
      RAISE EXCEPTION 'bezugsgroesse_berichtigung %: bei Vier-Augen gibt eine zweite Person frei', NEW.kennung
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_berichtigung_zweite_person';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bezugsgroesse_berichtigung_folgt ON bezugsgroesse_berichtigung;
CREATE TRIGGER bezugsgroesse_berichtigung_folgt BEFORE INSERT ON bezugsgroesse_berichtigung
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_berichtigung_folgt();

ALTER TABLE bezugsgroesse_berichtigung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_berichtigung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsgroesse_berichtigung_tenant_isolation ON bezugsgroesse_berichtigung;
CREATE POLICY bezugsgroesse_berichtigung_tenant_isolation ON bezugsgroesse_berichtigung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: ALTER DEFAULT PRIVILEGES gab beiden Rollen alles — hier wird alles
-- genommen und eng neu gegeben. Die App liest und hängt an (ohne `created_at`),
-- die Verwaltungsrolle liest und löscht (nur das Offboarding). Kein Zähler.
REVOKE ALL ON bezugsgroesse_berichtigung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON bezugsgroesse_berichtigung TO ${appDbUser};
GRANT INSERT (tenant_id, kennung, fassung, status, bezugsgroesse_id, periode_von, periode_bis, zeitzone,
              ersetzt_fassung, betrag, begruendung, geliefert_text, grund, freigabe_vieraugen, wert_fassung,
              actor_sub, actor_name, actor_rolle, actor_art)
    ON bezugsgroesse_berichtigung TO ${appDbUser};
GRANT SELECT, DELETE ON bezugsgroesse_berichtigung TO ${adminDbUser};
