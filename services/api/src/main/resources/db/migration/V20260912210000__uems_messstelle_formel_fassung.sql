-- =============================================================================
-- UEMS AP-10 IP-3: die FORMEL einer berechneten Messstelle wird TAGESGENAU
-- ZEITGÜLTIG — Formel-Fassungen (Konzept vp-uems-ap10-bilanzen §8 IP-3,
-- Captain-Entscheid E5 = A vom 12.09.2026; Vertrag
-- docs/contracts/v2/messstelle-formel.md §6).
--
-- „PR 688 nachziehen, Teil 1 von 4" (E7 = A: übernehmen und nachziehen, nicht
-- ablösen): messstelle_formel_term (V20260912093000) bleibt, wie sie ist, und
-- bekommt nur den Verweis auf ihre Fassung. Was gestern galt, darf etwas
-- anderes sein als heute, und die Auswertung eines alten Tages sieht die alte
-- Formel — dasselbe Prinzip wie die Kadenz (V20260912160000) und die Herkunft.
--
-- EINE neue mandantengebundene Tabelle und ein additiver Verweis:
--
--   messstelle_formel_fassung   eine Zeile = EINE Fassung der Formel EINER
--                               berechneten Messstelle: Nummer (1, 2, …),
--                               Formel-Typ, gültig ab / bis als TAGE.
--   messstelle_formel_term      + fassung_id — ein Term gehört zu GENAU einer
--                               Fassung; Terme ohne Fassung gibt es danach nicht.
--
-- DIE TAGE (Muster A, wie messstelle_ort/ort_zuordnung/flaeche_gueltigkeit —
-- NICHT die minutengenaue halboffene Form der Bindungen): „gültig ab" ist ein
-- TAG (00:00 in der Zeitzone des Standorts), `gueltig_bis` der LETZTE gültige
-- Tag, einschließlich — NULL = offen; daterange(ab, bis, '[]'). Fassung n + 1
-- beendet Fassung n am VORTAG; nichts wird überschrieben, Fassung n bleibt
-- lesbar. Eine Fassung wird aufgehoben (`aufgehoben_am`), nie editiert, nie
-- gelöscht; eine aufgehobene belegt keinen Tag mehr.
--
-- ⚠ FASSUNG 1 OHNE ERSTEN TAG (`gueltig_ab` NULL = „gilt seit Beginn"): die
-- Terme von PR 688 hatten KEINE Zeit — die Cloud rechnete sie für jeden Tag,
-- auch für Tage VOR dem Anlegen der Messstelle (der Verlauf über 7 und 30 Tage
-- zeigt diese Tage heute). Der Bestand wird darum Fassung 1 ohne ersten Tag:
-- so rechnet nach dieser Migration jeder Tag genau wie davor. Dasselbe gilt für
-- eine Fassung 1, die POST /api/v1/messstellen/berechnet anlegt (die Route
-- bleibt verhaltensgleich). Jede WEITERE Fassung beginnt an ihrem Tag und gilt
-- nie rückwärts; nur Fassung 1 darf ohne ersten Tag sein (CHECK).
--
-- DER FORMEL-TYP: heute nur `gewichtete_summe` (der Typ von PR 688). `rest` und
-- `saldo` (Vertrag §0) kommen mit AP-10 IP-4 — dann wird der CHECK geweitet,
-- indem der AKTUELLE Stand abgeschrieben wird.
--
-- DREI HERKÜNFTE (`herkunft`):
--   * bestand — diese Migration: die heutigen Terme als Fassung 1, von
--               VoltPilot selbst, ohne ersten Tag.
--   * anlage  — beim Anlegen einer berechneten Messstelle (Fassung 1).
--   * eintrag — über POST /api/v1/messstellen/{id}/formel/fassungen.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln des Schreibwegs, sie brauchen den Tag
-- des Eintrags): „eine neue Fassung beginnt nach dem Beginn der jüngsten"
-- (formel_fassung_ueberlappt), „rückwirkend" (Tag vor dem Eintragstag in der
-- Zeitzone des Standorts). Beides urteilt MessstelleFormelRegeln.fassungEintrag.
-- Die Datenbank hält die zeitlose Hälfte: nie zwei Fassungen an einem Tag
-- (Exklusion), bis ≥ ab, Nummer je Messstelle eindeutig, nur verkürzt.
--
-- VERTRÄGLICHKEIT MIT SCHREIBERN OHNE FASSUNG (rollierendes Deployment, Tests):
-- ein Term, der ohne fassung_id eingefügt wird, landet in der EINZIGEN Fassung
-- seiner Messstelle — gibt es noch keine, entsteht Fassung 1 ohne ersten Tag
-- (herkunft `anlage`). Hat die Messstelle schon mehrere Fassungen — oder nur
-- aufgehobene, deren Nummern nie wiederverwendet werden —, ist das nicht mehr
-- eindeutig und wird abgelehnt (messstelle_formel_term_fassung_noetig).
--
-- DIE TERME WERDEN HISTORIE: eine Änderung ist eine neue Fassung, nie ein
-- UPDATE/DELETE an Termen. Die App-Rolle verliert darum UPDATE und DELETE auf
-- messstelle_formel_term (die Terme von PR 688 wurden nie geändert, nur
-- angelegt). Die Reihenfolge ist je FASSUNG eindeutig, nicht mehr je Messstelle.
--
-- DAS PROTOKOLL: eine eingetragene Fassung schreibt in derselben Transaktion
-- GENAU EINEN Eintrag `formel_geaendert` in messstelle_aenderung — der CHECK
-- wird geweitet, indem der AKTUELLE Stand abgeschrieben wird (der von
-- V20260912160000), nie der der Ur-Migration.
--
-- LÖSCHEN: → tenant und → messstelle ON DELETE RESTRICT; das Offboarding
-- (TenantRepository.offboard) räumt Terme und Fassungen ausdrücklich ab, VOR
-- den Messstellen.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS messstelle_formel_fassung (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    -- Die berechnete Messstelle, deren Formel diese Fassung ist.
    messstelle_id   UUID        NOT NULL,
    -- Fassung 1, 2, … — je Messstelle eindeutig, in der Reihenfolge der Tage.
    nummer          INTEGER     NOT NULL,
    formel_typ      TEXT        NOT NULL DEFAULT 'gewichtete_summe',
    -- NULL = gilt seit Beginn (nur Fassung 1, siehe Kopf).
    gueltig_ab      DATE,
    -- Der LETZTE gültige Tag, einschließlich; NULL = bis auf Weiteres.
    gueltig_bis     DATE,
    aufgehoben_am   TIMESTAMPTZ,
    herkunft        TEXT        NOT NULL,
    -- gueltig_ab vor dem Eintragstag in der Zeitzone des Standorts
    -- (MessstelleFormelRegeln.fassungEintrag).
    rueckwirkend    BOOLEAN     NOT NULL DEFAULT false,
    begruendung     TEXT,
    -- Der Urheber im Akteur-Vokabular von AP-03 (wie messstelle_aenderung, über
    -- uems/ProtokollAkteur); actor_sub NULL = VoltPilot selbst.
    actor_sub       TEXT,
    actor_name      TEXT        NOT NULL,
    actor_rolle     TEXT,
    actor_art       TEXT        NOT NULL,
    eingetragen_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_formel_fassung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Der Mandant reist in JEDEM Verweis mit (ein Fremdschlüssel prüft ohne RLS).
    CONSTRAINT messstelle_formel_fassung_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    -- Ziel des Term-Verweises: Fassung UND Messstelle UND Mandant zusammen, damit
    -- ein Term nie in der Fassung einer anderen Messstelle landet.
    CONSTRAINT messstelle_formel_fassung_id_messstelle_uq UNIQUE (id, messstelle_id, tenant_id),
    CONSTRAINT messstelle_formel_fassung_nummer_uq UNIQUE (tenant_id, messstelle_id, nummer),
    CONSTRAINT messstelle_formel_fassung_nummer_chk CHECK (nummer >= 1),
    CONSTRAINT messstelle_formel_fassung_typ_chk CHECK (formel_typ IN ('gewichtete_summe')),
    CONSTRAINT messstelle_formel_fassung_herkunft_chk CHECK (herkunft IN ('bestand', 'anlage', 'eintrag')),
    -- Nur Fassung 1 darf ohne ersten Tag sein. ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
    CONSTRAINT messstelle_formel_fassung_ab_chk CHECK (coalesce(gueltig_ab IS NOT NULL OR nummer = 1, false)),
    -- Bestand und Anlage sind immer Fassung 1; der Bestand schreibt VoltPilot selbst.
    CONSTRAINT messstelle_formel_fassung_herkunft_nummer_chk CHECK (coalesce(herkunft = 'eintrag' OR nummer = 1, false)),
    CONSTRAINT messstelle_formel_fassung_bestand_chk CHECK (coalesce(
        herkunft <> 'bestand'
        OR (gueltig_ab IS NULL AND actor_sub IS NULL AND actor_art = 'voltpilot' AND NOT rueckwirkend
            AND begruendung IS NULL),
        false)),
    -- ab = bis ist erlaubt: ein Tag ist ein Intervall.
    CONSTRAINT messstelle_formel_fassung_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_ab IS NULL OR gueltig_bis >= gueltig_ab),
    -- „rückwirkend" braucht einen ersten Tag.
    CONSTRAINT messstelle_formel_fassung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gueltig_ab IS NOT NULL),
    CONSTRAINT messstelle_formel_fassung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messstelle_formel_fassung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messstelle_formel_fassung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT messstelle_formel_fassung_begruendung_chk CHECK (begruendung IS NULL
        OR (char_length(begruendung) BETWEEN 1 AND 500 AND btrim(begruendung) <> '')),
    -- Je Messstelle genau EINE Fassung je Tag. '[]', weil `bis` der letzte Tag
    -- IST; ein NULL-Beginn ist unbeschränkt nach vorn; eine aufgehobene Fassung
    -- belegt keinen Tag; tenant_id vorn, weil der Constraint VOR dem
    -- Fremdschlüssel und ohne RLS prüft (V20260911100000).
    CONSTRAINT messstelle_formel_fassung_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);

-- Die Fassungen einer Messstelle in ihrer Reihenfolge — der Leseweg „welche
-- Formel galt an dem Tag?".
CREATE INDEX IF NOT EXISTS idx_messstelle_formel_fassung_messstelle
    ON messstelle_formel_fassung (messstelle_id, nummer);

-- -----------------------------------------------------------------------------
-- Die Trigger der Fassung
-- -----------------------------------------------------------------------------

-- Eine Fassung hängt nur an einer BERECHNETEN Messstelle (wie ihre Terme).
CREATE OR REPLACE FUNCTION messstelle_formel_fassung_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
          SELECT 1 FROM messstelle m
           WHERE m.id = NEW.messstelle_id AND m.tenant_id = NEW.tenant_id
             AND m.art = 'berechnet') THEN
        RAISE EXCEPTION 'Eine Formel-Fassung haengt nur an einer berechneten Messstelle (%)', NEW.messstelle_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_fassung_nur_berechnet';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS messstelle_formel_fassung_pruefen ON messstelle_formel_fassung;
CREATE TRIGGER messstelle_formel_fassung_pruefen BEFORE INSERT ON messstelle_formel_fassung
    FOR EACH ROW EXECUTE FUNCTION messstelle_formel_fassung_pruefen();

-- Eine Fassung wird nur VERKÜRZT (die nächste beendet sie) oder EINMAL
-- aufgehoben — nie verlängert, nie umgeschrieben, auch nicht von einer Rolle mit
-- vollem UPDATE-Recht. Dieselbe Regel wie die Kadenz-Fassungen (V20260912160000).
CREATE OR REPLACE FUNCTION messstelle_formel_fassung_nur_verkuerzen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.tenant_id, NEW.messstelle_id, NEW.nummer, NEW.formel_typ, NEW.gueltig_ab, NEW.herkunft,
        NEW.rueckwirkend, NEW.begruendung, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle, NEW.actor_art,
        NEW.eingetragen_am)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.messstelle_id, OLD.nummer, OLD.formel_typ, OLD.gueltig_ab, OLD.herkunft,
        OLD.rueckwirkend, OLD.begruendung, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle, OLD.actor_art,
        OLD.eingetragen_am) THEN
        RAISE EXCEPTION 'Eine Formel-Fassung wird nie umgeschrieben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_fassung_unveraenderlich';
    END IF;
    IF NEW.gueltig_bis IS DISTINCT FROM OLD.gueltig_bis
       AND (NEW.gueltig_bis IS NULL OR (OLD.gueltig_bis IS NOT NULL AND NEW.gueltig_bis > OLD.gueltig_bis)) THEN
        RAISE EXCEPTION 'Eine Formel-Fassung wird nur verkuerzt, nie verlaengert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_fassung_nur_verkuerzen';
    END IF;
    IF OLD.aufgehoben_am IS NOT NULL AND NEW.aufgehoben_am IS DISTINCT FROM OLD.aufgehoben_am THEN
        RAISE EXCEPTION 'Eine aufgehobene Formel-Fassung bleibt aufgehoben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_fassung_aufgehoben';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS messstelle_formel_fassung_nur_verkuerzen ON messstelle_formel_fassung;
CREATE TRIGGER messstelle_formel_fassung_nur_verkuerzen BEFORE UPDATE ON messstelle_formel_fassung
    FOR EACH ROW EXECUTE FUNCTION messstelle_formel_fassung_nur_verkuerzen();

-- -----------------------------------------------------------------------------
-- Der Term bekommt seine Fassung
-- -----------------------------------------------------------------------------

ALTER TABLE messstelle_formel_term ADD COLUMN IF NOT EXISTS fassung_id UUID;

-- Die Reihenfolge ist je FASSUNG eindeutig (Fassung 2 zählt wieder ab 0).
ALTER TABLE messstelle_formel_term DROP CONSTRAINT IF EXISTS messstelle_formel_term_position_uq;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'messstelle_formel_term'::regclass
                      AND conname = 'messstelle_formel_term_fassung_position_uq') THEN
        ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_fassung_position_uq
            UNIQUE (tenant_id, fassung_id, position);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'messstelle_formel_term'::regclass
                      AND conname = 'messstelle_formel_term_fassung_fk') THEN
        ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_fassung_fk
            FOREIGN KEY (fassung_id, messstelle_id, tenant_id)
            REFERENCES messstelle_formel_fassung (id, messstelle_id, tenant_id) ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messstelle_formel_term_fassung
    ON messstelle_formel_term (fassung_id, position);

-- Ein Schreiber ohne Fassung (siehe Kopf): der Term landet in der EINZIGEN
-- Fassung seiner Messstelle; gibt es keine, entsteht Fassung 1 ohne ersten Tag.
-- Heißt nach messstelle_formel_term_pruefen, damit dessen Urteil
-- („nur berechnet") zuerst fällt — Postgres ruft BEFORE-Trigger in
-- Namensreihenfolge. Läuft als Aufrufer: NEW.tenant_id hat das WITH CHECK der
-- Policy schon geprüft.
CREATE OR REPLACE FUNCTION messstelle_formel_term_zu_fassung() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    anzahl INTEGER;
    alle   INTEGER;
BEGIN
    IF NEW.fassung_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT count(*) FILTER (WHERE f.aufgehoben_am IS NULL), count(*) INTO anzahl, alle
      FROM messstelle_formel_fassung f
     WHERE f.tenant_id = NEW.tenant_id AND f.messstelle_id = NEW.messstelle_id;
    IF anzahl > 1 OR (anzahl = 0 AND alle > 0) THEN
        RAISE EXCEPTION 'Die Messstelle % hat mehrere Formel-Fassungen - ein Term nennt seine Fassung', NEW.messstelle_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_term_fassung_noetig';
    ELSIF anzahl = 1 THEN
        SELECT f.id INTO NEW.fassung_id FROM messstelle_formel_fassung f
         WHERE f.tenant_id = NEW.tenant_id AND f.messstelle_id = NEW.messstelle_id
           AND f.aufgehoben_am IS NULL;
    ELSE
        INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, gueltig_ab,
                                               herkunft, rueckwirkend, actor_name, actor_art)
        VALUES (NEW.tenant_id, NEW.messstelle_id, 1, 'gewichtete_summe', NULL, 'anlage', false,
                'VoltPilot', 'voltpilot')
        RETURNING id INTO NEW.fassung_id;
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS messstelle_formel_term_zu_fassung ON messstelle_formel_term;
CREATE TRIGGER messstelle_formel_term_zu_fassung BEFORE INSERT ON messstelle_formel_term
    FOR EACH ROW EXECUTE FUNCTION messstelle_formel_term_zu_fassung();

-- -----------------------------------------------------------------------------
-- Das Protokoll an der Messstelle kennt die neue Art. Geweitet, indem der
-- AKTUELLE Stand abgeschrieben wird — der von V20260912160000 (kadenz_geaendert).
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
    'formel_geaendert'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_formel_fassung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_formel_fassung_tenant_isolation ON messstelle_formel_fassung;
CREATE POLICY messstelle_formel_fassung_tenant_isolation ON messstelle_formel_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben
-- darf. Die BYPASSRLS-Rolle voltpilot_admin behält V4s Rechte (das Offboarding
-- löscht über sie). Kein BIGSERIAL, darum kein Sequenz-Grant. Das REVOKE auf
-- Tabellenebene nimmt auch Spaltenrechte mit; das GRANT danach setzt genau die
-- genannten wieder.
GRANT SELECT, INSERT ON messstelle_formel_fassung TO ${appDbUser};
REVOKE UPDATE, DELETE ON messstelle_formel_fassung FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON messstelle_formel_fassung TO ${appDbUser};

-- Die Terme sind ab hier Historie ihrer Fassung: anlegen ja, ändern/löschen nie.
REVOKE UPDATE, DELETE ON messstelle_formel_term FROM ${appDbUser};
GRANT SELECT, INSERT ON messstelle_formel_term TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- Der Bestand: die heutigen Terme sind Fassung 1 — ohne ersten Tag
-- -----------------------------------------------------------------------------
-- Je berechneter Messstelle mit Termen ohne Fassung genau EINE Fassung 1; ihre
-- Terme zeigen danach auf sie. Kein Term, keine Spalte außer fassung_id und
-- keine Messstelle ändert sich. Wiederholbar: sie legt nur an, wo es für die
-- Messstelle noch keine Fassung gibt, und füllt nur leere Verweise. Kein
-- Protokoll: der Bestand ändert nichts, er schreibt auf, was schon gilt. Kein
-- Schreibweg der App ruft sie — nur die Migration (ohne RLS) als Eigner.
CREATE OR REPLACE FUNCTION uems_formel_fassung_bestand() RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    angelegt INTEGER := 0;
BEGIN
    INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, formel_typ, gueltig_ab,
                                           herkunft, rueckwirkend, actor_name, actor_art)
    SELECT DISTINCT t.tenant_id, t.messstelle_id, 1, 'gewichtete_summe', NULL::date, 'bestand', false,
           'VoltPilot', 'voltpilot'
      FROM messstelle_formel_term t
     WHERE t.fassung_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM messstelle_formel_fassung f
                        WHERE f.tenant_id = t.tenant_id AND f.messstelle_id = t.messstelle_id);
    GET DIAGNOSTICS angelegt = ROW_COUNT;

    UPDATE messstelle_formel_term t
       SET fassung_id = f.id
      FROM messstelle_formel_fassung f
     WHERE t.fassung_id IS NULL
       AND f.tenant_id = t.tenant_id AND f.messstelle_id = t.messstelle_id AND f.nummer = 1;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_formel_fassung_bestand() FROM PUBLIC;

SELECT uems_formel_fassung_bestand();

-- Terme ohne Fassung gibt es danach nicht.
ALTER TABLE messstelle_formel_term ALTER COLUMN fassung_id SET NOT NULL;

COMMENT ON TABLE messstelle_formel_fassung IS
    'Fassung der Formel EINER berechneten Messstelle (UEMS AP-10 IP-3, E5): tagesgenau '
    'daterange(gueltig_ab, gueltig_bis, ''[]''), Fassung n + 1 beendet n am Vortag; gueltig_ab NULL = '
    'gilt seit Beginn (nur Fassung 1, Bestand von PR 688). Vertrag docs/contracts/v2/messstelle-formel.md §6.';
COMMENT ON COLUMN messstelle_formel_term.fassung_id IS
    'Die Formel-Fassung, zu der der Term gehört (V20260912210000); Terme sind Historie ihrer Fassung.';
