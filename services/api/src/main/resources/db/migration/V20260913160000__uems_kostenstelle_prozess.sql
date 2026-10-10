-- =============================================================================
-- UEMS AP-10 IP-7 — Kostenstelle, Prozess und die Zuordnung einer Messstelle zu
-- Prozessen (Konzept vp-uems-ap10-bilanzen §4.2 Modell, §5.7 Bedienablauf, §8
-- IP-7; AP-00 E5 „zwei Achsen: Prozessbaum mit einer Ebene, flache Kostenstellen“;
-- Rechte E15 `kostenstelle.verwalten`, `prozess.verwalten`).
--
--   kostenstelle        FLACH — keine Eltern-Spalte, keine Hierarchie; besteht
--                       von `gueltig_ab` bis `gueltig_bis` (Tage)
--   prozess             höchstens EIN Elternteil, und nur EINE Ebene — erzwungen
--                       vom Trigger prozess_eine_ebene, nicht vom Dienst
--   messstelle_prozess  welche Messstelle an welchem Tag zu welchem Prozess
--                       gehört (0..n je Tag, ohne Anteil)
--
-- Und die drei Stellen, die auf diese Objekte gewartet haben:
--   * bezugsgroesse bekommt `prozess_id`/`kostenstelle_id`; der CHECK
--     bezugsgroesse_geltung_objekt_chk, der Schlüssel bezugsgroesse_geltung_uq
--     und der Trigger bezugsgroesse_identitaet_bleibt werden abgeschrieben und um
--     die zwei Spalten geweitet (V20260913104500 „das Paket, das sie baut, ergänzt
--     die Spalte und schreibt DIESEN CHECK ab“).
--   * messstelle_formel_term.verteilung_ziel bekommt seinen Fremdschlüssel auf
--     kostenstelle (V20260913143000 „das IP-7-Paket zieht den Schlüssel nach“).
--   * messstelle_aenderung_art_chk kennt `prozesse_zugeordnet`.
--
-- DIE TAGE (dieselbe Zeitform wie ort_zuordnung/messstelle_ort — keine dritte):
-- `gueltig_ab` ist ein Tag, `gueltig_bis` der LETZTE gültige Tag einschließlich,
-- NULL = offen; die Überlappung prüft daterange(ab, bis, '[]').
--
-- BEENDEN STATT LÖSCHEN: die App-Rolle hat auf keiner der drei Tabellen DELETE;
-- ein Objekt endet mit `gueltig_bis`. Nur das Offboarding löscht.
--
-- EINE ZUORDNUNG GILT NIE LÄNGER ALS IHR ZIEL (Konzept §4.6 „ein Anteil endet mit
-- seinem Ziel“, Referenzunternehmen 1.2: die Anteile auf 9000 enden am 31.12.2026
-- mit der Kostenstelle). Die Datenbank hält das von BEIDEN Seiten, mit EINEM Paar
-- Trigger-Funktionen:
--   uems_zuordnung_im_ziel()       an der ZUORDNUNG (BEFORE INSERT OR UPDATE):
--                                  ihre Tage liegen in den Tagen ihres Ziels, sonst
--                                  check_violation mit dem Constraint-Namen aus
--                                  TG_ARGV[2]. Argumente: Ziel-Tabelle,
--                                  Verweis-Spalte, Constraint-Name.
--   uems_ziel_deckt_zuordnungen()  am ZIEL (BEFORE UPDATE OF gueltig_ab,
--                                  gueltig_bis): ein Ende, das eine laufende
--                                  Zuordnung abschneiden würde, wird abgelehnt —
--                                  nie still gekürzt, nie still gelöscht.
-- Welche Zuordnungen ein Ziel hat, liest uems_zuordnungen_ausserhalb() aus
-- pg_trigger: JEDE Tabelle, an der uems_zuordnung_im_ziel mit dieser Ziel-Tabelle
-- hängt. Heute: messstelle_prozess → prozess und prozess (Eltern) → prozess. Die
-- Verteilung (AP-10 IP-8, `messstelle_verteilung` → kostenstelle) hängt denselben
-- Trigger an und ist damit an beiden Seiten gebunden — ohne zweite Liste, die man
-- vergessen könnte. Konvention der Zuordnungs-Tabelle: `tenant_id`, `gueltig_ab`,
-- `gueltig_bis`, wahlweise `aufgehoben_am` (ein aufgehobenes Intervall zählt nicht).
--
-- Die Rennen: die Zuordnung sperrt ihr Ziel FOR SHARE, das Beenden des Ziels hält
-- die Zeilensperre des UPDATE — wer zuerst kommt, gewinnt, der andere liest danach
-- den festgeschriebenen Stand (READ COMMITTED liest je Anweisung neu).
--
-- WAS DIE DATENBANK NICHT PRÜFT (Schreibweg KostenstelleProzessService):
-- ob die Messstelle archiviert ist, der „Satz ab Tag“ (welche Zeilen enden, welche
-- aufgehoben werden), rückwirkend im Protokoll, die Liste der Zuordnungen in der
-- 409-Antwort (sie liest dieselbe Funktion uems_zuordnungen_ausserhalb).
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS);
-- `tenant_id` steht vorn in jedem Unique- und Exklusions-Schlüssel.
--
-- Nicht dieses Paket: die Verteilung (IP-8), Kostenstellen-Lesemodell und
-- Periodenwerte (IP-11), Netzanschluss (IP-6), Portal (IP-15), Rechte-Durchsetzung
-- (AP-03).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- kostenstelle — flach (§4.2: Unternehmen 1 : 0..n, `gueltig_ab/bis` Tage)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kostenstelle (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    unternehmen_id  UUID        NOT NULL,
    -- „4100“, „9000“ — vom Kunden vergeben, nie weitergegeben (kein UPDATE-Recht).
    kennzeichen     TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    gueltig_ab      DATE        NOT NULL,
    gueltig_bis     DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT kostenstelle_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kostenstelle_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    -- Ein Kennzeichen je Kundenbereich, auch nach dem Ende (9000 bleibt 9000 in
    -- den Berichten 2026; die Nachfolger heißen 9010/9020).
    CONSTRAINT kostenstelle_kennzeichen_eindeutig UNIQUE (tenant_id, kennzeichen),
    -- Ziel der zusammengesetzten Verweise (der Mandant reist mit).
    CONSTRAINT kostenstelle_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT kostenstelle_kennzeichen_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT kostenstelle_name_chk CHECK (btrim(name) <> ''),
    -- ab = bis ist erlaubt: ein Tag ist ein Intervall.
    CONSTRAINT kostenstelle_bis_nicht_vor_ab CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab)
);

-- -----------------------------------------------------------------------------
-- prozess — eine Ebene (§4.2: Unternehmen 1 : 0..n, Eltern 0..1, Tage)
-- -----------------------------------------------------------------------------
-- Das Elternteil wird beim Anlegen gesetzt und bleibt (kein UPDATE-Recht auf
-- `eltern_id`); der Trigger prüft trotzdem jedes Setzen, auch das einer Rolle mit
-- mehr Rechten.
CREATE TABLE IF NOT EXISTS prozess (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    unternehmen_id  UUID        NOT NULL,
    kennzeichen     TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    eltern_id       UUID,
    gueltig_ab      DATE        NOT NULL,
    gueltig_bis     DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT prozess_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT prozess_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT prozess_kennzeichen_eindeutig UNIQUE (tenant_id, kennzeichen),
    CONSTRAINT prozess_id_tenant_uq UNIQUE (id, tenant_id),
    -- Das Elternteil liegt im selben Kundenbereich (MATCH SIMPLE: ohne Elternteil
    -- wird nichts geprüft).
    CONSTRAINT prozess_eltern_fk FOREIGN KEY (eltern_id, tenant_id)
        REFERENCES prozess (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT prozess_nicht_eigenes_eltern CHECK (eltern_id IS NULL OR eltern_id <> id),
    CONSTRAINT prozess_kennzeichen_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT prozess_name_chk CHECK (btrim(name) <> ''),
    CONSTRAINT prozess_bis_nicht_vor_ab CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab)
);
-- „Welche Unterprozesse hat P-1?“ (eine Ebene, Ende des Elternteils).
CREATE INDEX IF NOT EXISTS idx_prozess_eltern ON prozess (tenant_id, eltern_id) WHERE eltern_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- messstelle_prozess — Messstelle → Prozess je Tag, ohne Anteil (§4.2)
-- -----------------------------------------------------------------------------
-- Ein Intervall wird beendet oder aufgehoben — nie gelöscht, nie umgeschrieben
-- (Muster messstelle_ort). Eine Messstelle darf an einem Tag zu mehreren Prozessen
-- gehören, zu demselben aber nur einmal.
CREATE TABLE IF NOT EXISTS messstelle_prozess (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    messstelle_id   UUID        NOT NULL,
    prozess_id      UUID        NOT NULL,
    gueltig_ab      DATE        NOT NULL,
    gueltig_bis     DATE,
    aufgehoben_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT messstelle_prozess_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_prozess_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_prozess_prozess_fk FOREIGN KEY (prozess_id, tenant_id)
        REFERENCES prozess (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_prozess_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    CONSTRAINT messstelle_prozess_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        prozess_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
-- „Was hängt an diesem Prozess?“ (Ende des Prozesses, die 409-Liste).
CREATE INDEX IF NOT EXISTS idx_messstelle_prozess_prozess
    ON messstelle_prozess (tenant_id, prozess_id, gueltig_ab) WHERE aufgehoben_am IS NULL;

-- -----------------------------------------------------------------------------
-- Prozess: höchstens EINE Ebene.
--
-- Ein Elternteil darf selbst keins haben, und wer ein Elternteil bekommt, darf
-- keine Kinder haben. Das Elternteil wird FOR SHARE gesperrt: ein gleichzeitiges
-- Setzen SEINES Elternteils wartet (die Zeilensperre des UPDATE kollidiert) und
-- sieht danach das neue Kind — und umgekehrt. Eine zweite Ebene ist ein Fehler,
-- kein Sonderfall.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prozess_eine_ebene() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  e RECORD;
BEGIN
  IF NEW.eltern_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.eltern_id IS NOT DISTINCT FROM OLD.eltern_id) THEN
    RETURN NEW;
  END IF;
  SELECT p.kennzeichen, p.eltern_id INTO e
    FROM prozess p WHERE p.id = NEW.eltern_id AND p.tenant_id = NEW.tenant_id FOR SHARE;
  IF FOUND AND e.eltern_id IS NOT NULL THEN
    RAISE EXCEPTION 'Prozess % ist selbst ein Unterprozess — Prozesse haben höchstens eine Ebene', e.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prozess_eine_ebene';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM prozess k
                                   WHERE k.eltern_id = NEW.id AND k.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Prozess % hat Unterprozesse und kann darum kein Unterprozess werden', NEW.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prozess_eine_ebene';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prozess_eine_ebene ON prozess;
CREATE TRIGGER prozess_eine_ebene BEFORE INSERT OR UPDATE OF eltern_id ON prozess
    FOR EACH ROW EXECUTE FUNCTION prozess_eine_ebene();

-- -----------------------------------------------------------------------------
-- Eine Zuordnung gilt nie länger als ihr Ziel — die Seite der ZUORDNUNG.
--
-- TG_ARGV[0] Ziel-Tabelle (`kennzeichen`, `gueltig_ab`, `gueltig_bis`, `tenant_id`),
-- TG_ARGV[1] Verweis-Spalte der Zuordnung, TG_ARGV[2] Constraint-Name der Ablehnung.
-- Gibt es das Ziel nicht (auch: nicht im Kundenbereich), entscheidet der
-- Fremdschlüssel.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_zuordnung_im_ziel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zeile   JSONB := to_jsonb(NEW);
  ziel_id UUID  := (zeile ->> TG_ARGV[1])::uuid;
  ab      DATE  := (zeile ->> 'gueltig_ab')::date;
  bis     DATE  := (zeile ->> 'gueltig_bis')::date;
  z       RECORD;
  gefunden BIGINT;
BEGIN
  IF ziel_id IS NULL OR zeile ->> 'aufgehoben_am' IS NOT NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT kennzeichen, gueltig_ab, gueltig_bis FROM %I WHERE id = $1 AND tenant_id = $2 FOR SHARE',
                 TG_ARGV[0])
    INTO z USING ziel_id, NEW.tenant_id;
  -- ⚠ EXECUTE setzt FOUND nicht — die Zeilenzahl sagt, ob es das Ziel gibt.
  GET DIAGNOSTICS gefunden = ROW_COUNT;
  IF gefunden = 0 THEN
    RETURN NEW;
  END IF;
  IF ab < z.gueltig_ab OR coalesce(bis, 'infinity') > coalesce(z.gueltig_bis, 'infinity') THEN
    RAISE EXCEPTION '% % besteht von % bis % — eine Zuordnung von % bis % gilt länger als ihr Ziel',
      TG_ARGV[0], z.kennzeichen, z.gueltig_ab, coalesce(z.gueltig_bis::text, 'offen'),
      ab, coalesce(bis::text, 'offen')
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_ARGV[2];
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- Welche Zuordnungen eines Ziels lägen außerhalb der Tage [p_ab, p_bis]?
--
-- Die Zuordnungs-Tabellen sind die, an denen uems_zuordnung_im_ziel mit dieser
-- Ziel-Tabelle hängt (pg_trigger, erstes Argument). Läuft als Aufrufer: unter RLS
-- sieht die App-Rolle nur den eigenen Kundenbereich — und nur dort liegen die
-- Zuordnungen eines Ziels (zusammengesetzte Fremdschlüssel).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_zuordnungen_ausserhalb(p_ziel TEXT, p_tenant UUID, p_id UUID, p_ab DATE, p_bis DATE)
RETURNS TABLE (tabelle TEXT, zeile_id UUID, gueltig_ab DATE, gueltig_bis DATE)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT c.relname::text AS rel, a.args[2] AS spalte,
           EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'aufgehoben_am'
                    AND NOT x.attisdropped) AS mit_aufhebung
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      CROSS JOIN LATERAL (SELECT string_to_array(encode(t.tgargs, 'escape'), '\000') AS args) a
     WHERE t.tgfoid = 'uems_zuordnung_im_ziel()'::regprocedure
       AND NOT t.tgisinternal
       AND a.args[1] = p_ziel
     ORDER BY 1, 2
  LOOP
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, z.id, z.gueltig_ab, z.gueltig_bis FROM %I z '
      || 'WHERE z.tenant_id = $1 AND z.%I = $2 %s '
      || 'AND (z.gueltig_ab < $3 OR coalesce(z.gueltig_bis, ''infinity'') > coalesce($4, ''infinity'')) '
      || 'ORDER BY z.gueltig_ab, z.id',
      r.rel, r.rel, r.spalte, CASE WHEN r.mit_aufhebung THEN 'AND z.aufgehoben_am IS NULL' ELSE '' END)
      USING p_tenant, p_id, p_ab, p_bis;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Eine Zuordnung gilt nie länger als ihr Ziel — die Seite des ZIELS.
-- TG_ARGV[0] Constraint-Name der Ablehnung.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_ziel_deckt_zuordnungen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  n BIGINT;
BEGIN
  IF NEW.gueltig_ab IS NOT DISTINCT FROM OLD.gueltig_ab AND NEW.gueltig_bis IS NOT DISTINCT FROM OLD.gueltig_bis THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO n FROM uems_zuordnungen_ausserhalb(TG_TABLE_NAME, NEW.tenant_id, NEW.id,
                                                          NEW.gueltig_ab, NEW.gueltig_bis);
  IF n > 0 THEN
    SELECT * INTO r FROM uems_zuordnungen_ausserhalb(TG_TABLE_NAME, NEW.tenant_id, NEW.id,
                                                     NEW.gueltig_ab, NEW.gueltig_bis) LIMIT 1;
    RAISE EXCEPTION '% % soll von % bis % bestehen — % Zuordnung(en) gelten länger, z. B. % % (% bis %)',
      TG_TABLE_NAME, NEW.kennzeichen, NEW.gueltig_ab, coalesce(NEW.gueltig_bis::text, 'offen'), n,
      r.tabelle, r.zeile_id, r.gueltig_ab, coalesce(r.gueltig_bis::text, 'offen')
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_ARGV[0];
  END IF;
  RETURN NEW;
END $$;

-- Die Zuordnungen von heute …
DROP TRIGGER IF EXISTS messstelle_prozess_im_prozess ON messstelle_prozess;
CREATE TRIGGER messstelle_prozess_im_prozess BEFORE INSERT OR UPDATE ON messstelle_prozess
    FOR EACH ROW EXECUTE FUNCTION uems_zuordnung_im_ziel('prozess', 'prozess_id', 'messstelle_prozess_prozess_besteht');
DROP TRIGGER IF EXISTS prozess_im_eltern ON prozess;
CREATE TRIGGER prozess_im_eltern BEFORE INSERT OR UPDATE ON prozess
    FOR EACH ROW EXECUTE FUNCTION uems_zuordnung_im_ziel('prozess', 'eltern_id', 'prozess_eltern_besteht');
-- … und ihre Ziele. Die Kostenstelle trägt den Trigger schon: ihre erste Zuordnung
-- mit Tagen ist die Verteilung (IP-8), die nur noch ihre Hälfte anhängt.
DROP TRIGGER IF EXISTS prozess_deckt_zuordnungen ON prozess;
CREATE TRIGGER prozess_deckt_zuordnungen BEFORE UPDATE OF gueltig_ab, gueltig_bis ON prozess
    FOR EACH ROW EXECUTE FUNCTION uems_ziel_deckt_zuordnungen('prozess_zuordnung_besteht');
DROP TRIGGER IF EXISTS kostenstelle_deckt_zuordnungen ON kostenstelle;
CREATE TRIGGER kostenstelle_deckt_zuordnungen BEFORE UPDATE OF gueltig_ab, gueltig_bis ON kostenstelle
    FOR EACH ROW EXECUTE FUNCTION uems_ziel_deckt_zuordnungen('kostenstelle_zuordnung_besteht');

-- -----------------------------------------------------------------------------
-- Wartende Stelle 1 und 2 (AP-09 IP-4/IP-5): Prozess und Kostenstelle als
-- Geltungsbereich einer Bezugsgröße. Die Stände von V20260913104500 abgeschrieben
-- und um die zwei Spalten geweitet.
-- -----------------------------------------------------------------------------
ALTER TABLE bezugsgroesse ADD COLUMN IF NOT EXISTS prozess_id UUID;
ALTER TABLE bezugsgroesse ADD COLUMN IF NOT EXISTS kostenstelle_id UUID;
ALTER TABLE bezugsgroesse DROP CONSTRAINT IF EXISTS bezugsgroesse_prozess_fk;
ALTER TABLE bezugsgroesse ADD CONSTRAINT bezugsgroesse_prozess_fk FOREIGN KEY (prozess_id, tenant_id)
    REFERENCES prozess (id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE bezugsgroesse DROP CONSTRAINT IF EXISTS bezugsgroesse_kostenstelle_fk;
ALTER TABLE bezugsgroesse ADD CONSTRAINT bezugsgroesse_kostenstelle_fk FOREIGN KEY (kostenstelle_id, tenant_id)
    REFERENCES kostenstelle (id, tenant_id) ON DELETE RESTRICT;

-- E1: genau EIN Objekt, und es ist das der Art. ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
ALTER TABLE bezugsgroesse DROP CONSTRAINT IF EXISTS bezugsgroesse_geltung_objekt_chk;
ALTER TABLE bezugsgroesse ADD CONSTRAINT bezugsgroesse_geltung_objekt_chk CHECK (coalesce(
    num_nonnulls(unternehmen_id, standort_id, ort_id, prozess_id, kostenstelle_id, messstelle_id) = 1
    AND CASE geltung_art
          WHEN 'unternehmen'  THEN unternehmen_id IS NOT NULL
          WHEN 'standort'     THEN standort_id IS NOT NULL
          WHEN 'gebaeude'     THEN ort_id IS NOT NULL
          WHEN 'bereich'      THEN ort_id IS NOT NULL
          WHEN 'prozess'      THEN prozess_id IS NOT NULL
          WHEN 'kostenstelle' THEN kostenstelle_id IS NOT NULL
          WHEN 'messstelle'   THEN messstelle_id IS NOT NULL
          ELSE false
        END, false));

-- Die Geltungs-Spalten sind SCHLÜSSEL-Spalten (siehe V20260913104500: das Ändern
-- braucht FOR UPDATE und wartet auf einen gleichzeitig entstehenden ersten Wert) —
-- die zwei neuen gehören dazu. Kein Verweis zeigt auf den Schlüssel.
ALTER TABLE bezugsgroesse DROP CONSTRAINT IF EXISTS bezugsgroesse_geltung_uq;
ALTER TABLE bezugsgroesse ADD CONSTRAINT bezugsgroesse_geltung_uq
    UNIQUE (id, tenant_id, geltung_art, unternehmen_id, standort_id, ort_id, messstelle_id, prozess_id, kostenstelle_id);

CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_prozess ON bezugsgroesse (prozess_id)
    WHERE prozess_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_kostenstelle ON bezugsgroesse (kostenstelle_id)
    WHERE kostenstelle_id IS NOT NULL;

-- M1: der Mandant und die Kennung nie; der Geltungsbereich nur, solange die
-- Bezugsgröße keinen Wert hat — jetzt mit Prozess und Kostenstelle.
CREATE OR REPLACE FUNCTION bezugsgroesse_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'Kennung und Mandant der Bezugsgröße % sind nie änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_identitaet_unveraenderlich';
  END IF;
  IF (NEW.geltung_art, NEW.unternehmen_id, NEW.standort_id, NEW.ort_id, NEW.messstelle_id,
      NEW.prozess_id, NEW.kostenstelle_id)
       IS DISTINCT FROM (OLD.geltung_art, OLD.unternehmen_id, OLD.standort_id, OLD.ort_id, OLD.messstelle_id,
                         OLD.prozess_id, OLD.kostenstelle_id)
     AND EXISTS (SELECT 1 FROM bezugsgroesse_wert w
                  WHERE w.bezugsgroesse_id = OLD.id AND w.tenant_id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Der Geltungsbereich der Bezugsgröße % hat Werte und ist nicht mehr änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_geltung_nach_erstem_wert';
  END IF;
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- Wartende Stelle 3 (AP-10 IP-5): das Ziel eines Verteilungs-Terms ist eine
-- Kostenstelle desselben Kundenbereichs. Kein Schreibweg konnte bisher ein Ziel
-- speichern (422 `verteilung_wartet_auf_ip8`) — der Schlüssel wird darum sofort
-- geprüft, nicht NOT VALID.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_term DROP CONSTRAINT IF EXISTS messstelle_formel_term_verteilung_ziel_fk;
ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_verteilung_ziel_fk
    FOREIGN KEY (verteilung_ziel, tenant_id) REFERENCES kostenstelle (id, tenant_id) ON DELETE RESTRICT;
COMMENT ON COLUMN messstelle_formel_term.verteilung_ziel IS
    'Bei eingang_art = verteilung: die Kostenstelle, deren Anteil des TAGES an quell_messstelle_id der Term '
    'liest (AP-10 E11). Fremdschlüssel (verteilung_ziel, tenant_id) → kostenstelle seit AP-10 IP-7; bis zur '
    'Verteilung (IP-8) lehnt die Schnittstelle ab: verteilung_wartet_auf_ip8.';

-- -----------------------------------------------------------------------------
-- Das Protokoll an der Messstelle kennt die Prozess-Zuordnung. Geweitet, indem der
-- AKTUELLE Stand abgeschrieben wird — der von V20260912210000 (formel_geaendert).
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
    'prozesse_zugeordnet'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE kostenstelle ENABLE ROW LEVEL SECURITY;
ALTER TABLE kostenstelle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kostenstelle_tenant_isolation ON kostenstelle;
CREATE POLICY kostenstelle_tenant_isolation ON kostenstelle
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE prozess ENABLE ROW LEVEL SECURITY;
ALTER TABLE prozess FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prozess_tenant_isolation ON prozess;
CREATE POLICY prozess_tenant_isolation ON prozess
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messstelle_prozess ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_prozess FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_prozess_tenant_isolation ON messstelle_prozess;
CREATE POLICY messstelle_prozess_tenant_isolation ON messstelle_prozess
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben. Das REVOKE auf
-- Tabellenebene nimmt auch Spaltenrechte mit; ein erneuter Lauf landet im selben
-- Zustand.
--
-- Beenden statt löschen: kein DELETE für die App-Rolle. Änderbar sind der Name und
-- das Ende eines Objekts; Kennzeichen, Beginn und Elternteil bleiben, wie sie
-- angelegt wurden. (Das UPDATE-Recht auf `name` braucht auch die Sperre FOR SHARE
-- in uems_zuordnung_im_ziel.) Ein Zuordnungs-Intervall wird beendet oder aufgehoben.
-- -----------------------------------------------------------------------------
REVOKE ALL ON kostenstelle, prozess, messstelle_prozess FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT, INSERT ON kostenstelle TO ${appDbUser};
GRANT UPDATE (name, gueltig_bis, updated_at) ON kostenstelle TO ${appDbUser};
GRANT SELECT, INSERT ON prozess TO ${appDbUser};
GRANT UPDATE (name, gueltig_bis, updated_at) ON prozess TO ${appDbUser};
GRANT SELECT, INSERT ON messstelle_prozess TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON messstelle_prozess TO ${appDbUser};

-- Der Geltungsbereich einer Bezugsgröße (bis zum ersten Wert, M1).
GRANT UPDATE (prozess_id, kostenstelle_id) ON bezugsgroesse TO ${appDbUser};

-- Das Offboarding (TenantRepository.offboard) räumt alle drei ab: die Zuordnungen
-- vor der Messstelle und dem Prozess, Unterprozesse vor ihrem Elternteil, beide
-- Objekte nach den Bezugsgrößen und Formel-Termen, die auf sie zeigen.
GRANT SELECT, DELETE ON kostenstelle, prozess, messstelle_prozess TO ${adminDbUser};

COMMENT ON TABLE kostenstelle IS
    'UEMS AP-10 IP-7: Kostenstelle, flach (AP-00 E5), besteht von gueltig_ab bis gueltig_bis (Tage, letzter einschliesslich); beendet, nie geloescht.';
COMMENT ON TABLE prozess IS
    'UEMS AP-10 IP-7: Prozess mit hoechstens einem Elternteil und nur einer Ebene (Trigger prozess_eine_ebene); beendet, nie geloescht.';
COMMENT ON TABLE messstelle_prozess IS
    'UEMS AP-10 IP-7: Messstelle -> Prozess je Tag, ohne Anteil; gilt nie laenger als ihr Prozess (uems_zuordnung_im_ziel).';
COMMENT ON FUNCTION uems_zuordnungen_ausserhalb(TEXT, UUID, UUID, DATE, DATE) IS
    'Die Zuordnungen eines Ziels (jede Tabelle mit dem Trigger uems_zuordnung_im_ziel auf diese Ziel-Tabelle), '
    'die ausserhalb der Tage [p_ab, p_bis] laegen. Grundlage der 409-Liste und des Ziel-Triggers.';
