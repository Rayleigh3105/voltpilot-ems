-- =============================================================================
-- UEMS AP-10 IP-6 — der NETZANSCHLUSS als eigenes Objekt am Standort und seine
-- zeitgültige Bindung an eine Anlage (Konzept vp-uems-ap10-bilanzen §4.2 Modell,
-- §5.1 Bedienablauf, §6 Auswirkungen, §8 IP-6; Entscheid E8 = A vom 12.09.2026;
-- AP-00 E6/E10; Vertrag docs/contracts/v2/netzanschluss.md).
--
--   netzanschluss                  Kennzeichen, Name, Marktlokation, Netzbetreiber,
--                                  Anschlussleistung (kVA), vereinbarte Leistung
--                                  (kW), Messung — am STANDORT; besteht von
--                                  `gueltig_ab` bis `gueltig_bis` (Tage)
--   netzanschluss_kennzeichen      JEDES Kennzeichen, das ein Anschluss je trug
--   netzanschluss_kennzeichen_seq  der Zähler der automatischen Kennzeichen NA-0001
--   anlage_netzanschluss           welche Anlage an welchem Tag an welchem Anschluss
--                                  hängt — 1 : 1 JE TAG
--   netzanschluss_aenderung        das Änderungsprotokoll (ein Eintrag je Schreibvorgang)
--
-- ⚠ EINE ANLAGE HÄNGT AN JEDEM TAG AN GENAU EINEM ANSCHLUSS (E8). Zwei Exklusionen,
-- nicht eine: je Anlage (anlage_netzanschluss_eine_je_anlage) UND je Anschluss
-- (anlage_netzanschluss_eine_je_anschluss). Eine zweite Bindung derselben Anlage am
-- selben Tag ist kein Nachtrag, sondern ein Widerspruch — an einem Tag fließt der
-- Strom durch einen Anschluss. Ein Wechsel beendet die laufende Bindung am VORTAG
-- (NetzanschlussRegeln.bindung); nichts wird überschrieben.
--
-- DIE TAGE (dieselbe Zeitform wie ort_zuordnung/messstelle_prozess — keine dritte):
-- `gueltig_ab` ist ein Tag, `gueltig_bis` der LETZTE gültige Tag einschließlich,
-- NULL = offen; die Überlappung prüft daterange(ab, bis, '[]'). Am Anschluss darf
-- `gueltig_ab` fehlen: das Referenzunternehmen nennt keinen ersten Tag (die
-- Bindungen beginnen am 12.03.2024, lange vor dem Anlegen — Vektoren
-- `_abweichungen` „Anlegetag der Objekte“); NULL heißt dann „kein erster Tag
-- erhoben“, nie „ab heute“.
--
-- EINE BINDUNG GILT NIE LÄNGER ALS IHR ANSCHLUSS — mit dem Trigger-Paar aus
-- V20260913160000 (uems_zuordnung_im_ziel an der Bindung, uems_ziel_deckt_zuordnungen
-- am Anschluss). Die Funktionen werden AUFGERUFEN, nicht abgeschrieben.
--
-- ⚠ KENNZEICHEN WERDEN NIE WEITERGEGEBEN (AP-00 E10, Muster messstelle_kennzeichen):
-- ein Trigger schreibt JEDE Vergabe und Umbenennung nach netzanschluss_kennzeichen;
-- deren Primärschlüssel verbietet die Weitergabe — auch nach dem Beenden.
--
-- DIE ANLAGE DARF GEHEN, IHRE BINDUNG BLEIBT (Muster anlage_standort, W5,
-- V20260911290000): kein Fremdschlüssel auf `site` — ein RESTRICT ließe
-- „Anlage löschen“ (SiteController) mit 500 enden, eine Kaskade löschte die Historie.
-- Die EINFÜGE-Hälfte hält ein Trigger (23503, Constraint anlage_netzanschluss_site_fk);
-- der Löschweg beendet die Bindung heute (NetzanschlussService.beimLoeschen).
--
-- ⚠ NICHT IN DIESEM PAKET (W9): die Preis- und Grenzspalten der Anlage
-- (`site.max_feed_in_kw`, `site_supply_price` …) bleiben, wo sie sind; ihr Umzug ist
-- das Folgepaket „Netzanschluss-Preisblatt“. `site` bekommt KEINE Spalte
-- `netzanschluss_id` — die Bindung ist die Tabelle (E8).
--
-- ⚠ REIN ADDITIV: keine bestehende Tabelle, Spalte, Policy oder Funktion ändert sich;
-- es kommen fünf leere Tabellen dazu.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS);
-- `tenant_id` steht vorn in jedem Unique- und Exklusions-Schlüssel.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- netzanschluss — das Objekt am Standort (§4.2: Standort 1 : 0..n, Tage)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS netzanschluss (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID          NOT NULL,
    standort_id     UUID          NOT NULL,
    -- Das HEUTIGE Kennzeichen; jedes je getragene steht in netzanschluss_kennzeichen.
    kennzeichen     TEXT          NOT NULL,
    name            TEXT          NOT NULL,
    -- Marktlokation: elf Ziffern (Vertrag `regeln.malo_muster`); NULL = nicht erhoben,
    -- nie „0“.
    malo            TEXT,
    netzbetreiber   TEXT,
    anschluss_kva   NUMERIC(12, 3),
    vereinbart_kw   NUMERIC(12, 3),
    messung         TEXT          NOT NULL,
    gueltig_ab      DATE,
    gueltig_bis     DATE,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT netzanschluss_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_kennzeichen_eindeutig UNIQUE (tenant_id, kennzeichen),
    -- Ziel der zusammengesetzten Verweise (der Mandant reist mit).
    CONSTRAINT netzanschluss_id_tenant_uq UNIQUE (id, tenant_id),
    -- Dieselbe Form wie messstelle_kennzeichen_format (AP-00 E10).
    CONSTRAINT netzanschluss_kennzeichen_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT netzanschluss_name_chk CHECK (btrim(name) <> ''),
    CONSTRAINT netzanschluss_malo_form CHECK (malo IS NULL OR malo ~ '^[0-9]{11}$'),
    -- Geschlossenes Vokabular `vokabulare.messung`: ein Wort außerhalb wird verworfen.
    CONSTRAINT netzanschluss_messung_chk CHECK (messung IN ('RLM', 'SLP')),
    CONSTRAINT netzanschluss_anschluss_kva_chk CHECK (anschluss_kva IS NULL OR anschluss_kva > 0),
    CONSTRAINT netzanschluss_vereinbart_kw_chk CHECK (vereinbart_kw IS NULL OR vereinbart_kw > 0),
    -- ab = bis ist erlaubt: ein Tag ist ein Intervall.
    CONSTRAINT netzanschluss_bis_nicht_vor_ab
        CHECK (gueltig_ab IS NULL OR gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab)
);
-- „Welche Anschlüsse hat Werk Ahrenberg?“
CREATE INDEX IF NOT EXISTS idx_netzanschluss_standort ON netzanschluss (tenant_id, standort_id, kennzeichen);

-- -----------------------------------------------------------------------------
-- netzanschluss_kennzeichen — die BELEGUNG (siehe Kopf). Eine Zeile je Kennzeichen,
-- das ein Anschluss je trug; nie geändert, nur vom Offboarding gelöscht.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS netzanschluss_kennzeichen (
    tenant_id         UUID        NOT NULL,
    kennzeichen       TEXT        NOT NULL,
    netzanschluss_id  UUID        NOT NULL,
    belegt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT netzanschluss_kennzeichen_belegt PRIMARY KEY (tenant_id, kennzeichen),
    CONSTRAINT netzanschluss_kennzeichen_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_kennzeichen_netzanschluss_fk FOREIGN KEY (netzanschluss_id, tenant_id)
        REFERENCES netzanschluss (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_kennzeichen_belegt_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$')
);
CREATE INDEX IF NOT EXISTS idx_netzanschluss_kennzeichen_netzanschluss
    ON netzanschluss_kennzeichen (netzanschluss_id);

-- -----------------------------------------------------------------------------
-- netzanschluss_kennzeichen_seq — der Zähler „NA-0001“, „NA-0002“ … je Mandant.
-- Eine TABELLE, keine Sequenz (Muster messstelle_kennzeichen_seq): eine Sequenz ist
-- mandantenübergreifend und verbraucht bei jedem Rollback eine Nummer. Der Zähler
-- rückt nur VOR, und nur wenn ein automatisches Kennzeichen gespeichert wird.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS netzanschluss_kennzeichen_seq (
    tenant_id   UUID        PRIMARY KEY,
    zaehler     INTEGER     NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT netzanschluss_kennzeichen_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_kennzeichen_seq_zaehler_chk CHECK (zaehler >= 0)
);

-- -----------------------------------------------------------------------------
-- anlage_netzanschluss — Anlage ↔ Netzanschluss je Tag (§4.2: 1 : 1 je Tag)
-- -----------------------------------------------------------------------------
-- Ein Intervall wird beendet oder aufgehoben — nie gelöscht, nie umgeschrieben.
CREATE TABLE IF NOT EXISTS anlage_netzanschluss (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID        NOT NULL,
    -- Kein Fremdschlüssel (siehe Kopf, W5) — der Trigger anlage_netzanschluss_anlage_da
    -- prüft beim Eintragen.
    site_id           UUID        NOT NULL,
    netzanschluss_id  UUID        NOT NULL,
    gueltig_ab        DATE        NOT NULL,
    gueltig_bis       DATE,
    aufgehoben_am     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by        TEXT,
    CONSTRAINT anlage_netzanschluss_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT anlage_netzanschluss_netzanschluss_fk FOREIGN KEY (netzanschluss_id, tenant_id)
        REFERENCES netzanschluss (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT anlage_netzanschluss_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Exklusion 1: an einem Tag hängt eine Anlage an höchstens EINEM Anschluss.
    CONSTRAINT anlage_netzanschluss_eine_je_anlage EXCLUDE USING gist (
        tenant_id WITH =,
        site_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL),
    -- Exklusion 2: an einem Tag hängt ein Anschluss an höchstens EINER Anlage.
    CONSTRAINT anlage_netzanschluss_eine_je_anschluss EXCLUDE USING gist (
        tenant_id WITH =,
        netzanschluss_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);

-- -----------------------------------------------------------------------------
-- netzanschluss_aenderung — das Änderungsprotokoll (Muster bezugsgroesse_aenderung,
-- Urheber `actor_*`). `art`: angelegt · bearbeitet (alt/neu tragen NUR die
-- geänderten Felder) · gebunden (alt = die am Vortag beendete Bindung der Anlage,
-- neu = die neue) · anlage_entfernt (die Anlage wurde gelöscht, die Bindung endet).
-- Kein Verweis auf den Anschluss (ein Protokoll überlebt sein Objekt), aber auf den
-- Mandanten: nur das Offboarding räumt es ab.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS netzanschluss_aenderung (
    id                BIGSERIAL   PRIMARY KEY,
    tenant_id         UUID        NOT NULL,
    netzanschluss_id  UUID        NOT NULL,
    art               TEXT        NOT NULL,
    alt               JSONB,
    neu               JSONB,
    gilt_ab           TIMESTAMPTZ NOT NULL,
    rueckwirkend      BOOLEAN     NOT NULL,
    grund             TEXT,
    actor_sub         TEXT,
    actor_name        TEXT        NOT NULL,
    actor_rolle       TEXT,
    actor_art         TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT netzanschluss_aenderung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_aenderung_art_chk
        CHECK (art IN ('angelegt', 'bearbeitet', 'gebunden', 'anlage_entfernt')),
    CONSTRAINT netzanschluss_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT netzanschluss_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT netzanschluss_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT netzanschluss_aenderung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gilt_ab < created_at)
);
CREATE INDEX IF NOT EXISTS idx_netzanschluss_aenderung_netzanschluss
    ON netzanschluss_aenderung (netzanschluss_id, created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- Die Trigger
-- -----------------------------------------------------------------------------

-- Jede Vergabe und jede Umbenennung belegt das Kennzeichen (Muster
-- messstelle_kennzeichen_belegen). SECURITY DEFINER, weil die App-Rolle die Belegung
-- nur lesen darf; der Mandant ist NEW.tenant_id, den das WITH CHECK von netzanschluss
-- bereits geprüft hat. Trägt oder trug ein ANDERER Anschluss das Kennzeichen,
-- scheitert das INSERT am Primärschlüssel netzanschluss_kennzeichen_belegt (23505).
CREATE OR REPLACE FUNCTION netzanschluss_kennzeichen_belegen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kennzeichen = OLD.kennzeichen THEN
    RETURN NULL;
  END IF;
  -- Der Anschluss darf zu seinem EIGENEN früheren Kennzeichen zurück.
  PERFORM 1 FROM public.netzanschluss_kennzeichen
    WHERE tenant_id = NEW.tenant_id AND kennzeichen = NEW.kennzeichen
      AND netzanschluss_id = NEW.id;
  IF NOT FOUND THEN
    INSERT INTO public.netzanschluss_kennzeichen (tenant_id, kennzeichen, netzanschluss_id)
    VALUES (NEW.tenant_id, NEW.kennzeichen, NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION netzanschluss_kennzeichen_belegen() FROM PUBLIC;
DROP TRIGGER IF EXISTS netzanschluss_kennzeichen_belegen ON netzanschluss;
CREATE TRIGGER netzanschluss_kennzeichen_belegen AFTER INSERT OR UPDATE OF kennzeichen ON netzanschluss
    FOR EACH ROW EXECUTE FUNCTION netzanschluss_kennzeichen_belegen();

-- Der Standort eines Anschlusses bleibt (kein UPDATE-Recht auf standort_id; der Trigger
-- hält es auch für eine Rolle mit mehr Rechten): ein Anschluss zieht nicht um.
CREATE OR REPLACE FUNCTION netzanschluss_standort_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.standort_id <> OLD.standort_id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'Der Netzanschluss % bleibt an seinem Standort', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'netzanschluss_standort_bleibt';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS netzanschluss_standort_bleibt ON netzanschluss;
CREATE TRIGGER netzanschluss_standort_bleibt BEFORE UPDATE ON netzanschluss
    FOR EACH ROW EXECUTE FUNCTION netzanschluss_standort_bleibt();

-- Der Zähler rückt nur vor: eine übersprungene Nummer wird nie mehr vergeben.
CREATE OR REPLACE FUNCTION netzanschluss_kennzeichen_seq_rueckt_vor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.zaehler < OLD.zaehler THEN
    RAISE EXCEPTION 'Der Kennzeichen-Zähler rückt nur vor (% auf %)', OLD.zaehler, NEW.zaehler
      USING ERRCODE = 'check_violation', CONSTRAINT = 'netzanschluss_kennzeichen_seq_rueckt_nur_vor';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS netzanschluss_kennzeichen_seq_rueckt_vor ON netzanschluss_kennzeichen_seq;
CREATE TRIGGER netzanschluss_kennzeichen_seq_rueckt_vor BEFORE UPDATE ON netzanschluss_kennzeichen_seq
    FOR EACH ROW EXECUTE FUNCTION netzanschluss_kennzeichen_seq_rueckt_vor();

-- Die Einfüge-Hälfte des fehlenden Fremdschlüssels auf `site` (Muster
-- uems_anlage_standort_anlage_pruefen): eine neue Bindung nennt eine Anlage DESSELBEN
-- Mandanten, die es gibt — mit der Ablehnung eines Fremdschlüssels (23503), damit sie
-- einem fremden Mandanten nichts verrät. FOR KEY SHARE hält die Anlage bis zum Ende der
-- Transaktion. SECURITY INVOKER: unter RLS sieht die App-Rolle nur ihre Anlagen.
CREATE OR REPLACE FUNCTION uems_anlage_netzanschluss_anlage_pruefen() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1 FROM site WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'anlage_netzanschluss_site_fk',
            MESSAGE = 'insert or update on table "anlage_netzanschluss" violates foreign key '
                || 'constraint "anlage_netzanschluss_site_fk"',
            DETAIL = 'Die Anlage gibt es in diesem Kundenbereich nicht.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS anlage_netzanschluss_anlage_da ON anlage_netzanschluss;
CREATE TRIGGER anlage_netzanschluss_anlage_da
    BEFORE INSERT OR UPDATE OF site_id, tenant_id ON anlage_netzanschluss
    FOR EACH ROW EXECUTE FUNCTION uems_anlage_netzanschluss_anlage_pruefen();

-- Eine Bindung gilt nie länger als ihr Anschluss — beide Seiten mit den Funktionen aus
-- V20260913160000 (aufgerufen, nicht abgeschrieben). Ein Anschluss ohne ersten Tag
-- begrenzt nur nach hinten.
DROP TRIGGER IF EXISTS anlage_netzanschluss_im_netzanschluss ON anlage_netzanschluss;
CREATE TRIGGER anlage_netzanschluss_im_netzanschluss BEFORE INSERT OR UPDATE ON anlage_netzanschluss
    FOR EACH ROW EXECUTE FUNCTION uems_zuordnung_im_ziel('netzanschluss', 'netzanschluss_id',
                                                         'anlage_netzanschluss_netzanschluss_besteht');
DROP TRIGGER IF EXISTS netzanschluss_deckt_bindungen ON netzanschluss;
CREATE TRIGGER netzanschluss_deckt_bindungen BEFORE UPDATE OF gueltig_ab, gueltig_bis ON netzanschluss
    FOR EACH ROW EXECUTE FUNCTION uems_ziel_deckt_zuordnungen('netzanschluss_bindung_besteht');

-- Belegung und Protokoll: nie geändert. DELETE bleibt dem Offboarding (Rechte).
DROP TRIGGER IF EXISTS netzanschluss_kennzeichen_append_only ON netzanschluss_kennzeichen;
CREATE TRIGGER netzanschluss_kennzeichen_append_only BEFORE UPDATE ON netzanschluss_kennzeichen
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS netzanschluss_aenderung_append_only ON netzanschluss_aenderung;
CREATE TRIGGER netzanschluss_aenderung_append_only BEFORE UPDATE ON netzanschluss_aenderung
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE netzanschluss ENABLE ROW LEVEL SECURITY;
ALTER TABLE netzanschluss FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netzanschluss_tenant_isolation ON netzanschluss;
CREATE POLICY netzanschluss_tenant_isolation ON netzanschluss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE netzanschluss_kennzeichen ENABLE ROW LEVEL SECURITY;
ALTER TABLE netzanschluss_kennzeichen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netzanschluss_kennzeichen_tenant_isolation ON netzanschluss_kennzeichen;
CREATE POLICY netzanschluss_kennzeichen_tenant_isolation ON netzanschluss_kennzeichen
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE netzanschluss_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE netzanschluss_kennzeichen_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netzanschluss_kennzeichen_seq_tenant_isolation ON netzanschluss_kennzeichen_seq;
CREATE POLICY netzanschluss_kennzeichen_seq_tenant_isolation ON netzanschluss_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE anlage_netzanschluss ENABLE ROW LEVEL SECURITY;
ALTER TABLE anlage_netzanschluss FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anlage_netzanschluss_tenant_isolation ON anlage_netzanschluss;
CREATE POLICY anlage_netzanschluss_tenant_isolation ON anlage_netzanschluss
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE netzanschluss_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE netzanschluss_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netzanschluss_aenderung_tenant_isolation ON netzanschluss_aenderung;
CREATE POLICY netzanschluss_aenderung_tenant_isolation ON netzanschluss_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben. Das REVOKE auf
-- Tabellenebene nimmt auch Spaltenrechte mit; ein erneuter Lauf landet im selben
-- Zustand.
--
-- Beenden statt löschen: kein DELETE für die App-Rolle. Am Anschluss änderbar sind die
-- Stammdaten, Kennzeichen (die Belegung bleibt) und die Tage — nie Standort, Mandant
-- oder Anlagezeit. Eine Bindung wird beendet oder aufgehoben, nie umgehängt.
-- -----------------------------------------------------------------------------
REVOKE ALL ON netzanschluss, netzanschluss_kennzeichen, netzanschluss_kennzeichen_seq,
    anlage_netzanschluss, netzanschluss_aenderung FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT, INSERT ON netzanschluss TO ${appDbUser};
GRANT UPDATE (kennzeichen, name, malo, netzbetreiber, anschluss_kva, vereinbart_kw, messung,
              gueltig_ab, gueltig_bis, updated_at)
    ON netzanschluss TO ${appDbUser};
-- Die Belegung schreibt nur der Trigger.
GRANT SELECT ON netzanschluss_kennzeichen TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE ON netzanschluss_kennzeichen_seq TO ${appDbUser};
GRANT SELECT, INSERT ON anlage_netzanschluss TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON anlage_netzanschluss TO ${appDbUser};
-- Das Protokoll: lesen und anhängen.
GRANT SELECT, INSERT ON netzanschluss_aenderung TO ${appDbUser};

-- Das Offboarding (TenantRepository.offboard) räumt alle fünf ab, Kinder zuerst.
GRANT SELECT, DELETE ON netzanschluss, netzanschluss_kennzeichen, netzanschluss_kennzeichen_seq,
    anlage_netzanschluss, netzanschluss_aenderung TO ${adminDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Recht (die rollout_event-Falle):
-- ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen nicht.
GRANT USAGE, SELECT ON SEQUENCE netzanschluss_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE netzanschluss_aenderung_id_seq TO ${adminDbUser};

COMMENT ON TABLE netzanschluss IS
    'UEMS AP-10 IP-6: Netzanschluss als eigenes Objekt am Standort (E8); Preis- und Grenzspalten bleiben an der Anlage (W9).';
COMMENT ON TABLE netzanschluss_kennzeichen IS
    'UEMS AP-10 IP-6: jedes Kennzeichen, das ein Netzanschluss je trug; nie weitergegeben (AP-00 E10). Nur per Trigger beschrieben.';
COMMENT ON TABLE netzanschluss_kennzeichen_seq IS
    'UEMS AP-10 IP-6: Zaehler der automatischen Kennzeichen NA-0001 ... je Mandant; rueckt nur vor.';
COMMENT ON TABLE anlage_netzanschluss IS
    'UEMS AP-10 IP-6: Anlage -> Netzanschluss je Tag, 1 : 1 (Exklusion je Anlage UND je Anschluss); gilt nie laenger als ihr Anschluss.';
COMMENT ON TABLE netzanschluss_aenderung IS
    'UEMS AP-10 IP-6: append-only Aenderungsprotokoll des Netzanschlusses mit Urheber (actor_*).';
