-- =============================================================================
-- UEMS AP-10 IP-8 — die Verteilung einer Messstelle auf Kostenstellen:
-- 100 % je Tag, oder ausdrücklich „nicht verteilt“
-- =============================================================================
-- Konzept vp-uems-ap10-bilanzen §4.6, §8 IP-8; Captain-Entscheide E11 = A (eigene
-- zeitgültige Beziehung, Satz je Tag, Summe genau 100 % an jedem Tag mit Zeilen)
-- und E12 = A (Tagesanteile). Vertrag docs/contracts/v2/verteilung.md +
-- verteilung-vectors.json (Regel `satz_ab_tag`).
--
-- Was entsteht:
--
--   1. `messstelle_verteilung` — Messstelle → Kostenstelle mit `anteil_prozent`,
--      je Tag (`gueltig_ab`, `gueltig_bis` = LETZTER Tag, NULL = offen — dieselbe
--      Zeitform wie messstelle_prozess), `aufgehoben_am` für die Korrektur am
--      selben Tag. Beendet oder aufgehoben, nie gelöscht, nie umgeschrieben.
--   2. Die 100 % ZUR COMMIT-ZEIT: ein Constraint-Trigger `DEFERRABLE INITIALLY
--      DEFERRED`. Ein Satz mit zwei Zielen verschiebt Anteile zwischen ihnen — nach
--      jeder einzelnen Zeile geprüft, wäre jeder solche Satz mittendrin ungültig
--      (70/30 → 60/40: nach dem Beenden der alten Zeilen 0 %, nach der ersten neuen
--      60 %), obwohl er am Ende genau 100 % ergibt. Geprüft wird darum am Ende der
--      Transaktion der GANZE Stand der Messstelle: an jedem Tag, an dem sich die
--      Menge der geltenden Zeilen ändert, ist die Summe 100 % — oder es gilt keine
--      Zeile („nicht verteilt“, nie „zu 0 % verteilt“).
--   3. „Ein Anteil gilt nie länger als seine Kostenstelle“ — KEINE eigene Prüfung:
--      das Trigger-Paar aus V20260913160000 bekommt seine zweite Zuordnungs-Tabelle
--      (`uems_zuordnung_im_ziel('kostenstelle', 'kostenstelle_id', …)`). Die Seite
--      der Kostenstelle (`kostenstelle_deckt_zuordnungen`) findet die Anteile über
--      pg_trigger von selbst, und `uems_zuordnungen_ausserhalb` nennt sie in der
--      409-Liste.
--   4. Das Ereignis `verteilung_geaendert` als 27. Art — ADDITIV: die Funktion
--      messreihe_ereignis_vokabular() wird KOMPLETT neu geschrieben (der Stand von
--      V20260913190000, Zeichen für Zeichen, plus genau diese eine Zeile am Ende),
--      der Art-CHECK wird zur Obermenge. Bezug ist NUR die Messstelle.
--   5. Das Protokoll an der Messstelle kennt `verteilung_geaendert`.
--
-- Die Anteile (0, 100] mit höchstens einer Nachkommastelle: der CHECK rundet nie
-- still — 33,33 % ist ein Fehler, keine 33,3 %.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Schreibweg VerteilungService, Regel
-- VerteilungRegeln.satzAbTag): die Form der Anfrage, die archivierte Messstelle,
-- „derselbe Satz noch einmal ändert nichts“ und die Fassung (neue Fassung beendet
-- die laufende am Vortag, am selben Tag nur als Korrektur). Die Datenbank hält,
-- was ein Schreiber ohne diese Regeln nie brechen darf: Mandant, Ziel, Tage, 100 %.
--
-- Nicht dieses Paket: kein Bilanz-Lesemodell (IP-9), keine Periodenwerte
-- berechneter oder verteilter Messstellen (IP-10/IP-11), keine Korrektur-Kaskade
-- (IP-11), keine Herkunft (IP-12), kein Portal (IP-15), keine Rechte-Durchsetzung
-- (AP-03).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- 1. messstelle_verteilung — Messstelle → Kostenstelle je Tag, mit Anteil
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messstelle_verteilung (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    messstelle_id   UUID        NOT NULL,
    kostenstelle_id UUID        NOT NULL,
    anteil_prozent  NUMERIC     NOT NULL,
    gueltig_ab      DATE        NOT NULL,
    gueltig_bis     DATE,
    aufgehoben_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT messstelle_verteilung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_verteilung_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_verteilung_kostenstelle_fk FOREIGN KEY (kostenstelle_id, tenant_id)
        REFERENCES kostenstelle (id, tenant_id) ON DELETE RESTRICT,
    -- (0, 100], höchstens eine Nachkommastelle — nie still gerundet.
    CONSTRAINT messstelle_verteilung_anteil_chk CHECK (
        anteil_prozent > 0 AND anteil_prozent <= 100 AND anteil_prozent = round(anteil_prozent, 1)),
    CONSTRAINT messstelle_verteilung_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Dasselbe Ziel gilt an einem Tag höchstens einmal (die Summe der Ziele hält der
    -- Commit-Zeit-Trigger).
    CONSTRAINT messstelle_verteilung_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        kostenstelle_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
-- „Wie ist diese Messstelle verteilt?“ (Leseweg des Formel-Terms, Schreibweg).
CREATE INDEX IF NOT EXISTS idx_messstelle_verteilung_messstelle
    ON messstelle_verteilung (tenant_id, messstelle_id, gueltig_ab) WHERE aufgehoben_am IS NULL;
-- „Was hängt an dieser Kostenstelle?“ (Ende der Kostenstelle, die 409-Liste).
CREATE INDEX IF NOT EXISTS idx_messstelle_verteilung_kostenstelle
    ON messstelle_verteilung (tenant_id, kostenstelle_id, gueltig_ab) WHERE aufgehoben_am IS NULL;

-- -----------------------------------------------------------------------------
-- 2. 100 % je Tag — zur COMMIT-Zeit
--
-- Die Summe ist eine Stufenfunktion der Tage; sie ändert sich nur an einem
-- `gueltig_ab` oder am Tag nach einem `gueltig_bis`. An jedem dieser Tage, an dem
-- überhaupt eine Zeile gilt, muss sie genau 100 sein. Geprüft wird der GANZE Stand
-- der Messstelle, wie ihn die Transaktion am Ende hinterlässt (auch ein Beenden
-- oder Aufheben feuert — aufgehobene Zeilen zählen nicht). Läuft als Aufrufer:
-- unter RLS sieht die App-Rolle genau den eigenen Kundenbereich, und darin liegen
-- alle Zeilen der Messstelle.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messstelle_verteilung_hundert_prozent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT t.tag, sum(v.anteil_prozent) AS summe INTO r
    FROM (SELECT DISTINCT x.tag
            FROM messstelle_verteilung w
            CROSS JOIN LATERAL (VALUES (w.gueltig_ab), (w.gueltig_bis + 1)) AS x (tag)
           WHERE w.tenant_id = NEW.tenant_id AND w.messstelle_id = NEW.messstelle_id
             AND w.aufgehoben_am IS NULL AND x.tag IS NOT NULL) t
    JOIN messstelle_verteilung v
      ON v.tenant_id = NEW.tenant_id AND v.messstelle_id = NEW.messstelle_id
     AND v.aufgehoben_am IS NULL
     AND v.gueltig_ab <= t.tag AND (v.gueltig_bis IS NULL OR v.gueltig_bis >= t.tag)
   GROUP BY t.tag
  HAVING sum(v.anteil_prozent) <> 100
   ORDER BY t.tag
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Verteilung der Messstelle %: am % ergeben die Anteile % %% — an jedem Tag mit Zeilen sind es genau 100 %%',
      NEW.messstelle_id, r.tag, r.summe
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_verteilung_hundert_prozent';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS messstelle_verteilung_hundert_prozent ON messstelle_verteilung;
CREATE CONSTRAINT TRIGGER messstelle_verteilung_hundert_prozent
    AFTER INSERT OR UPDATE ON messstelle_verteilung
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION messstelle_verteilung_hundert_prozent();

-- -----------------------------------------------------------------------------
-- 3. Ein Anteil gilt nie länger als seine Kostenstelle — die Hälfte der
--    ZUORDNUNG am vorhandenen Trigger-Paar (V20260913160000). Die Hälfte des
--    Ziels (`kostenstelle_deckt_zuordnungen`) steht schon und findet diese Tabelle
--    über pg_trigger.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS messstelle_verteilung_im_ziel ON messstelle_verteilung;
CREATE TRIGGER messstelle_verteilung_im_ziel BEFORE INSERT OR UPDATE ON messstelle_verteilung
    FOR EACH ROW EXECUTE FUNCTION uems_zuordnung_im_ziel('kostenstelle', 'kostenstelle_id', 'messstelle_verteilung_kostenstelle_besteht');

-- -----------------------------------------------------------------------------
-- 4. Ein Wort mehr im Ereignis-Vokabular: `verteilung_geaendert`
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
    'verteilung_geaendert (nur kunde, Zeitpunkt = Beginn des ersten Tags, Bezug nur die Messstelle).';

-- Der Art-CHECK ist eine wörtliche Liste — er wird ersetzt, in der Reihenfolge des
-- Vokabulars (MessreiheEreignisMigrationTest liest ihn so). Die neue Liste ist eine
-- Obermenge der alten: keine vorhandene Zeile kann abgewiesen werden.
ALTER TABLE messreihe_ereignis DROP CONSTRAINT IF EXISTS messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change', 'substitute', 'correction',
    'verteilung_geaendert'));

-- -----------------------------------------------------------------------------
-- 5. Das Protokoll an der Messstelle kennt die Verteilung. Geweitet, indem der
-- AKTUELLE Stand abgeschrieben wird — der von V20260913160000 (prozesse_zugeordnet).
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_aenderung DROP CONSTRAINT IF EXISTS messstelle_aenderung_art_chk;
ALTER TABLE messstelle_aenderung ADD CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
    'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert',
    'ort_zugeordnet', 'ort_korrigiert', 'stellung_zugeordnet', 'stellung_korrigiert',
    'quelle_gebunden', 'quelle_beendet',
    'einstellung_geaendert',
    'zaehler_gewechselt',
    'kadenz_geaendert',
    'formel_geaendert',
    'prozesse_zugeordnet',
    'verteilung_geaendert'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_verteilung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_verteilung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_verteilung_tenant_isolation ON messstelle_verteilung;
CREATE POLICY messstelle_verteilung_tenant_isolation ON messstelle_verteilung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben. Eine Zeile wird beendet
-- oder aufgehoben: die App-Rolle ändert nur `gueltig_bis` und `aufgehoben_am`, sie
-- löscht nichts. Das Offboarding (TenantRepository.offboard) räumt die Anteile vor
-- der Messstelle und der Kostenstelle ab.
-- -----------------------------------------------------------------------------
REVOKE ALL ON messstelle_verteilung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON messstelle_verteilung TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON messstelle_verteilung TO ${appDbUser};
GRANT SELECT, DELETE ON messstelle_verteilung TO ${adminDbUser};

COMMENT ON TABLE messstelle_verteilung IS
    'UEMS AP-10 IP-8: Verteilung einer Messstelle auf Kostenstellen je Tag (E11); an jedem Tag mit Zeilen genau 100 % (Constraint-Trigger zur Commit-Zeit), ohne Zeile nicht verteilt; gilt nie laenger als ihre Kostenstelle (uems_zuordnung_im_ziel).';
COMMENT ON FUNCTION messstelle_verteilung_hundert_prozent() IS
    'Commit-Zeit-Pruefung der 100 % je Tag: an jedem Tag, an dem sich die geltenden Zeilen einer Messstelle aendern und mindestens eine gilt, ist die Summe genau 100.';
