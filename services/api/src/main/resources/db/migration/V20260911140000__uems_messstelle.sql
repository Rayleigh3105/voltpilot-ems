-- =============================================================================
-- UEMS AP-04 IP-2: die MESSSTELLE als Tabelle (Konzept vp-uems-ap04-messstellen
-- §6.2/§8, Captain-Entscheide E1/E7/E8/E9 vom 10.09.2026). Massgeblich ist der
-- Vertrag docs/contracts/v2/messstelle.md + messstelle.schema.json mit dem
-- Java-Zwilling uems/MessstelleRegeln - jede Regel hier sagt DASSELBE wie dort;
-- MessstelleMigrationTest spielt die Kennzeichen-Faelle der Vektor-Datei gegen
-- die Datenbank.
--
-- Fuenf mandantengebundene Tabellen, rein additiv (keine bestehende Tabelle,
-- kein Vertrag und keine Box wird beruehrt):
--
--   messstelle                  Kennzeichen, Name, Art, Medium, die EINE
--                               Hauptgroesse (E1), Zustand, Notiz
--   messstelle_groesse          die 0..n Nebengroessen je Messstelle (E1)
--   messstelle_kennzeichen      JEDES Kennzeichen, das eine Messstelle je trug
--   messstelle_kennzeichen_seq  der Kennzeichen-Zaehler je Mandant (E7)
--   messstelle_aenderung        das Aenderungsprotokoll, append-only
--
-- ⚠ KENNZEICHEN WERDEN NIE WEITERGEGEBEN (E7, Regel 9, Vertrag §3 +
-- Widerspruch 7). Belegt ist, was eine Messstelle traegt, ein ARCHIVIERTES
-- Kennzeichen UND das FRUEHERE einer umbenannten - ein Bericht aus der Zeit vor
-- der Umbenennung nennt es. `UNIQUE (tenant_id, kennzeichen)` auf messstelle
-- allein sieht nur das HEUTIGE Kennzeichen. Deshalb schreibt ein Trigger jede
-- Vergabe und jede Umbenennung nach messstelle_kennzeichen, deren
-- Primaerschluessel (tenant_id, kennzeichen) die Weitergabe verbietet - egal
-- ueber welchen Weg geschrieben wird. Die App-Rolle kann dort NUR lesen: eine
-- Belegung entsteht ausschliesslich aus einem wirklich getragenen Kennzeichen.
-- Die Messstelle selbst darf zu ihrem frueheren Kennzeichen zurueck.
--
-- ⚠ DER ZUSTAND WIRD NICHT ALS STUFE GESPEICHERT. Entwurf/eingerichtet/aktiv
-- leitet MessstelleRegeln.lebenszyklus aus der Vollstaendigkeit ab (der Ort
-- kommt erst mit IP-7) - eine gespeicherte Stufe liefe ihr hinterher.
-- Gespeichert werden genau die zwei Eingaenge, die der Kunde setzt:
-- `angehalten_ab` (Eingang `angehalten`) und `archiviert_am` (Eingang
-- `archiviert`; der Zeitpunkt, zu dem IP-13 die Quellen beendet).
--
-- LOESCHEN (Plan-Regel „nichts mit Historie wird geloescht", dieselbe Linie wie
-- V20260911100000): jeder Fremdschluessel ist ON DELETE RESTRICT, nie Kaskade,
-- und die App-Rolle hat auf keiner dieser Tabellen DELETE - eine Messstelle
-- wird archiviert. Die Folgen, bewusst:
--   * Das Offboarding eines Kundenbereichs (TenantRepository.offboard) raeumt
--     die vier Stammdaten-Tabellen AUSDRUECKLICH ab, Kinder zuerst, bevor es den
--     Mandanten loescht (ueber die Admin-Rolle, die DELETE behaelt).
--   * `messstelle_aenderung` ist append-only und traegt deshalb GAR KEINEN
--     Fremdschluessel (Muster component_change_event / ort_aenderung): ein
--     Protokoll ueberlebt das Objekt, von dem es erzaehlt.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT. Ein Fremdschluessel-Test umgeht RLS;
-- ein Verweis nur ueber messstelle_id liesse eine Zeile von Mandant A auf die
-- Messstelle von Mandant B zeigen. Deshalb verweisen Nebengroesse und Belegung
-- ueber (messstelle_id, tenant_id).
--
-- Nicht dieses Paket: Quellenbindung (IP-13), Orte/Stellung/Prozesse/
-- Kostenstellen (IP-7), Formel (AP-10), Endpunkte (IP-3).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Der Groessen-Katalog (Vertrag §2) als EINE Pruefung fuer Haupt- und
-- Nebengroessen. Geschlossen: Groesse, Medium, Einheit, Richtung und Wertart
-- stehen nur ZUSAMMEN im Katalog. Zeile fuer Zeile dieselbe Tabelle wie
-- MessstelleRegeln.GROESSEN_KATALOG; MessstelleMigrationTest prueft das ueber
-- das volle Kreuzprodukt der Vokabulare.
-- ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messstelle_groesse_im_katalog(
    p_medium TEXT, p_groesse TEXT, p_richtung TEXT, p_einheit TEXT, p_wertart TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(CASE p_groesse
    WHEN 'Wirkenergie' THEN p_medium = 'Strom' AND p_einheit = 'kWh'
         AND p_richtung IN ('Bezug', 'Abgabe', 'Erzeugung', 'Laden', 'Entladen', 'Laden / Entladen')
         AND p_wertart IN ('Zählerstand', 'Intervallmenge')
    WHEN 'Wirkleistung' THEN p_medium = 'Strom' AND p_einheit = 'kW'
         AND p_richtung IN ('Bezug', 'Abgabe', 'Erzeugung', 'Laden', 'Entladen', 'richtungslos')
         AND p_wertart = 'Momentanwert'
    WHEN 'Blindenergie' THEN p_medium = 'Strom' AND p_einheit = 'kvarh'
         AND p_richtung IN ('Bezug', 'Abgabe')
         AND p_wertart IN ('Zählerstand', 'Intervallmenge')
    WHEN 'Scheinleistung' THEN p_medium = 'Strom' AND p_einheit = 'kVA'
         AND p_richtung = 'richtungslos' AND p_wertart = 'Momentanwert'
    WHEN 'Ladestand' THEN p_medium = 'Strom' AND p_einheit = '%'
         AND p_richtung = 'richtungslos' AND p_wertart = 'Momentanwert'
    WHEN 'Volumen' THEN p_medium = 'Gas' AND p_einheit = 'm³'
         AND p_richtung = 'Bezug'
         AND p_wertart IN ('Zählerstand', 'Intervallmenge')
    ELSE false
  END, false)
$$;

-- -----------------------------------------------------------------------------
-- messstelle
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messstelle (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    -- Das HEUTIGE Kennzeichen; jedes je getragene steht in messstelle_kennzeichen.
    -- Pflicht: das Anlegen vergibt es (Vertrag §3), auch einem Entwurf.
    kennzeichen     TEXT        NOT NULL,
    -- NULL = der Name fehlt noch: ein Entwurf (Vertrag §4, Fall
    -- neue-messstelle-ohne-name-und-ort). MessstelleRegeln zaehlt einen leeren
    -- Namen als fehlend - damit „fehlt" EINE Darstellung hat, ist er NULL.
    name            TEXT,
    art             TEXT        NOT NULL,
    -- Das VOLLE geschlossene Vokabular des Schemas. Dass der Dialog im ersten
    -- Umfang nur „Strom" anbietet (AP-00 E11), ist eine Regel der Flaeche.
    medium          TEXT        NOT NULL,
    -- Die HAUPTGROESSE (E1): identitaetsstiftend, nie aenderbar - eine andere
    -- Groesse ist eine andere Messstelle. Pflicht ab dem Anlegen: der einzige
    -- gespeicherte Entwurf des Vertrags hat sie schon gewaehlt; `fehlt:
    -- hauptgroesse` bleibt ein Urteil ueber den ungespeicherten Dialog.
    groesse         TEXT        NOT NULL,
    richtung        TEXT        NOT NULL,
    einheit         TEXT        NOT NULL,
    wertart         TEXT        NOT NULL,
    notiz           TEXT,
    -- Die zwei Zustands-Eingaenge (siehe Kopf). NULL = nicht angehalten /
    -- nicht archiviert.
    angehalten_ab   TIMESTAMPTZ,
    archiviert_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_kennzeichen_eindeutig UNIQUE (tenant_id, kennzeichen),
    -- Ziele der zusammengesetzten Verweise (der Mandant reist mit, siehe Kopf).
    CONSTRAINT messstelle_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT messstelle_id_tenant_medium_uq UNIQUE (id, tenant_id, medium),
    -- Vertrag §3: 2-16 Zeichen aus A-Z, 0-9, „-", „.", „/". Nichts wird
    -- umgewandelt - „ms-01" ist ein Formfehler, nie still „MS-01".
    CONSTRAINT messstelle_kennzeichen_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT messstelle_name_chk CHECK (name IS NULL OR btrim(name) <> ''),
    CONSTRAINT messstelle_art_chk CHECK (art IN ('gemessen', 'berechnet')),
    CONSTRAINT messstelle_medium_chk
        CHECK (medium IN ('Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft')),
    CONSTRAINT messstelle_hauptgroesse_katalog
        CHECK (messstelle_groesse_im_katalog(medium, groesse, richtung, einheit, wertart))
);

-- -----------------------------------------------------------------------------
-- messstelle_groesse: die Nebengroessen (E1). Jede ist eine eigene Groesse
-- desselben Messortes mit eigener fuehrender Quelle (IP-13), nie Eingang einer
-- Bilanz. Innerhalb einer Messstelle ist eine Groesse durch (groesse, richtung)
-- bestimmt - so identifiziert MessstelleRegeln.Bindung die Groesse, an der eine
-- Quelle haengt. Deshalb gibt es jede (groesse, richtung) je Messstelle nur
-- EINMAL, und nie dieselbe wie die Hauptgroesse (sonst gaebe es zwei fuehrende
-- Quellen fuer „dieselbe" Groesse).
-- ⚠ tenant_id VORN im Unique-Schluessel: er prueft VOR dem Fremdschluessel und
-- OHNE RLS - ohne tenant_id verriete die Ablehnung einem fremden Mandanten die
-- Nebengroessen einer Messstelle, die er nicht sehen darf (die Falle aus
-- V20260911100000).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messstelle_groesse (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    messstelle_id   UUID        NOT NULL,
    -- Das Medium der Messstelle, damit der Katalog greift; der Verweis unten
    -- haelt es gleich (das Medium einer Messstelle ist nie aenderbar).
    medium          TEXT        NOT NULL,
    groesse         TEXT        NOT NULL,
    richtung        TEXT        NOT NULL,
    einheit         TEXT        NOT NULL,
    wertart         TEXT        NOT NULL,
    -- Vertrag: aktiv | archiviert. NULL = aktiv.
    archiviert_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_groesse_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id, medium)
        REFERENCES messstelle (id, tenant_id, medium) ON DELETE RESTRICT,
    CONSTRAINT messstelle_groesse_eindeutig UNIQUE (tenant_id, messstelle_id, groesse, richtung),
    CONSTRAINT messstelle_groesse_katalog
        CHECK (messstelle_groesse_im_katalog(medium, groesse, richtung, einheit, wertart))
);

-- -----------------------------------------------------------------------------
-- messstelle_kennzeichen: die BELEGUNG (siehe Kopf). Eine Zeile je Kennzeichen,
-- das eine Messstelle je trug; sie wird nie geaendert und nur vom Offboarding
-- geloescht.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messstelle_kennzeichen (
    tenant_id       UUID        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen     TEXT        NOT NULL,
    messstelle_id   UUID        NOT NULL,
    belegt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_kennzeichen_belegt PRIMARY KEY (tenant_id, kennzeichen),
    CONSTRAINT messstelle_kennzeichen_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_kennzeichen_belegt_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$')
);
CREATE INDEX IF NOT EXISTS idx_messstelle_kennzeichen_messstelle
    ON messstelle_kennzeichen (messstelle_id);

-- -----------------------------------------------------------------------------
-- messstelle_kennzeichen_seq: der Zaehler der automatischen Kennzeichen
-- „MS-0001", „MS-0002" ... je Mandant (E7). Eine TABELLE, keine Sequenz: eine
-- Sequenz ist mandantenuebergreifend und verbraucht bei jedem Rollback eine
-- Nummer. Die Vergabe sperrt die Zeile (SELECT ... FOR UPDATE) - zwei
-- gleichzeitige Vergaben bekommen zwei verschiedene Nummern
-- (MessstelleRepository.anlegen). Der Zaehler rueckt nur VOR, und nur wenn ein
-- automatisches Kennzeichen gespeichert wird.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messstelle_kennzeichen_seq (
    tenant_id       UUID        PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
    zaehler         INTEGER     NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_kennzeichen_seq_zaehler_chk CHECK (zaehler >= 0)
);

-- -----------------------------------------------------------------------------
-- messstelle_aenderung: das Aenderungsprotokoll (AP-04 §4.1 „jede Aenderung:
-- Zeit · Was (alt → neu) · gilt ab · Wer · rueckwirkend; Eintraege werden nie
-- geaendert oder geloescht"), gebaut wie ort_aenderung (V20260911100000).
--
-- `art`: angelegt · bearbeitet (Kennzeichen, Name, Notiz - alt/neu tragen NUR
-- die geaenderten Felder) · angehalten · fortgesetzt · archiviert ·
-- nebengroesse_hinzugefuegt · nebengroesse_archiviert. IP-7/IP-13 weiten den
-- CHECK, indem sie DIESEN Stand abschreiben.
--
-- `gilt_ab` auf die Minute (E2) - Quellen und Zeitpunkte der Messstelle sind
-- minutengenau, Zuordnungen (IP-7) stehen als Mitternacht des Tages.
-- `rueckwirkend` rechnet der Schreiber mit MessstelleRegeln.
--
-- Der Urheber im Akteur-Vokabular von AP-03 (actor_sub, actor_name,
-- actor_rolle, actor_art). `actor_sub` NULL = VoltPilot selbst (dann ist
-- actor_art 'voltpilot'); `actor_name` sagt es immer. `actor_rolle` ist die
-- Rollen-KENNUNG des Rechte-Vertrags (docs/contracts/v2/rechte-matrix.json,
-- RechteAbleitung.Rolle), nie das Kundenwort; NULL, wenn keine Rolle wirkt.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messstelle_aenderung (
    id              BIGSERIAL   PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    messstelle_id   UUID        NOT NULL,
    art             TEXT        NOT NULL,
    alt             JSONB,
    neu             JSONB,
    gilt_ab         TIMESTAMPTZ NOT NULL,
    rueckwirkend    BOOLEAN     NOT NULL,
    grund           TEXT,
    actor_sub       TEXT,
    actor_name      TEXT        NOT NULL,
    actor_rolle     TEXT,
    actor_art       TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
        'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
        'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert')),
    CONSTRAINT messstelle_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messstelle_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messstelle_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    -- „rueckwirkend" ist ein Urteil ueber die Vergangenheit: es steht nie an
    -- einer Aenderung, die erst ab einem spaeteren Zeitpunkt gilt.
    CONSTRAINT messstelle_aenderung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gilt_ab < created_at)
);
CREATE INDEX IF NOT EXISTS idx_messstelle_aenderung_messstelle
    ON messstelle_aenderung (messstelle_id, created_at DESC, id DESC);
-- „Aenderungen, die den Zeitraum betreffen": nach „gilt ab".
CREATE INDEX IF NOT EXISTS idx_messstelle_aenderung_gilt_ab
    ON messstelle_aenderung (tenant_id, gilt_ab);

-- Append-only an der Datenbankgrenze, nicht nur per Konvention - dieselbe
-- Funktion wie component_change_event (V20260843000000) und ort_aenderung.
DROP TRIGGER IF EXISTS messstelle_aenderung_append_only ON messstelle_aenderung;
CREATE TRIGGER messstelle_aenderung_append_only BEFORE UPDATE OR DELETE ON messstelle_aenderung
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Die uebrigen Trigger
-- -----------------------------------------------------------------------------

-- Art, Medium und Hauptgroesse sind nie aenderbar (Vertrag §1); der Mandant
-- ohnehin nicht.
CREATE OR REPLACE FUNCTION messstelle_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.art <> OLD.art OR NEW.medium <> OLD.medium
     OR NEW.groesse <> OLD.groesse OR NEW.richtung <> OLD.richtung
     OR NEW.einheit <> OLD.einheit OR NEW.wertart <> OLD.wertart THEN
    RAISE EXCEPTION 'Art, Medium und Hauptgroesse der Messstelle % sind nie aenderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_identitaet_unveraenderlich';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messstelle_identitaet_bleibt ON messstelle;
CREATE TRIGGER messstelle_identitaet_bleibt BEFORE UPDATE ON messstelle
    FOR EACH ROW EXECUTE FUNCTION messstelle_identitaet_bleibt();

-- Jede Vergabe und jede Umbenennung belegt das Kennzeichen (siehe Kopf).
-- SECURITY DEFINER, weil die App-Rolle auf messstelle_kennzeichen nur lesen
-- darf; der Mandant ist NEW.tenant_id, den das WITH CHECK von messstelle
-- bereits geprueft hat. Traegt oder trug eine ANDERE Messstelle das
-- Kennzeichen, scheitert das INSERT am Primaerschluessel
-- messstelle_kennzeichen_belegt (23505) - nie eine stille Weitergabe.
CREATE OR REPLACE FUNCTION messstelle_kennzeichen_belegen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kennzeichen = OLD.kennzeichen THEN
    RETURN NULL;
  END IF;
  -- Die Messstelle darf zu ihrem EIGENEN frueheren Kennzeichen zurueck.
  PERFORM 1 FROM public.messstelle_kennzeichen
    WHERE tenant_id = NEW.tenant_id AND kennzeichen = NEW.kennzeichen
      AND messstelle_id = NEW.id;
  IF NOT FOUND THEN
    INSERT INTO public.messstelle_kennzeichen (tenant_id, kennzeichen, messstelle_id)
    VALUES (NEW.tenant_id, NEW.kennzeichen, NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION messstelle_kennzeichen_belegen() FROM PUBLIC;
DROP TRIGGER IF EXISTS messstelle_kennzeichen_belegen ON messstelle;
CREATE TRIGGER messstelle_kennzeichen_belegen AFTER INSERT OR UPDATE OF kennzeichen ON messstelle
    FOR EACH ROW EXECUTE FUNCTION messstelle_kennzeichen_belegen();

-- Eine Nebengroesse behaelt ihre Groesse (sonst zeigten ihre Quellen still auf
-- eine andere) und ist nie die Hauptgroesse ihrer Messstelle.
CREATE OR REPLACE FUNCTION messstelle_groesse_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.messstelle_id <> OLD.messstelle_id OR NEW.medium <> OLD.medium
       OR NEW.groesse <> OLD.groesse OR NEW.richtung <> OLD.richtung
       OR NEW.einheit <> OLD.einheit OR NEW.wertart <> OLD.wertart) THEN
    RAISE EXCEPTION 'Die Groesse einer Nebengroesse ist nie aenderbar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_groesse_unveraenderlich';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
       SELECT 1 FROM messstelle m
        WHERE m.id = NEW.messstelle_id
          AND m.groesse = NEW.groesse AND m.richtung = NEW.richtung) THEN
    RAISE EXCEPTION '% · % ist die Hauptgroesse dieser Messstelle', NEW.groesse, NEW.richtung
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'messstelle_groesse_nicht_hauptgroesse';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messstelle_groesse_pruefen ON messstelle_groesse;
CREATE TRIGGER messstelle_groesse_pruefen BEFORE INSERT OR UPDATE ON messstelle_groesse
    FOR EACH ROW EXECUTE FUNCTION messstelle_groesse_pruefen();

-- Der Zaehler rueckt nur vor: eine uebersprungene Nummer wird nie mehr vergeben.
CREATE OR REPLACE FUNCTION messstelle_kennzeichen_seq_rueckt_vor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.zaehler < OLD.zaehler THEN
    RAISE EXCEPTION 'Der Kennzeichen-Zaehler rueckt nur vor (% auf %)', OLD.zaehler, NEW.zaehler
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_kennzeichen_seq_rueckt_nur_vor';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messstelle_kennzeichen_seq_rueckt_vor ON messstelle_kennzeichen_seq;
CREATE TRIGGER messstelle_kennzeichen_seq_rueckt_vor BEFORE UPDATE ON messstelle_kennzeichen_seq
    FOR EACH ROW EXECUTE FUNCTION messstelle_kennzeichen_seq_rueckt_vor();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_tenant_isolation ON messstelle;
CREATE POLICY messstelle_tenant_isolation ON messstelle
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messstelle_groesse ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_groesse FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_groesse_tenant_isolation ON messstelle_groesse;
CREATE POLICY messstelle_groesse_tenant_isolation ON messstelle_groesse
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messstelle_kennzeichen ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_kennzeichen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_kennzeichen_tenant_isolation ON messstelle_kennzeichen;
CREATE POLICY messstelle_kennzeichen_tenant_isolation ON messstelle_kennzeichen
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messstelle_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_kennzeichen_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_kennzeichen_seq_tenant_isolation ON messstelle_kennzeichen_seq;
CREATE POLICY messstelle_kennzeichen_seq_tenant_isolation ON messstelle_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messstelle_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_aenderung_tenant_isolation ON messstelle_aenderung;
CREATE POLICY messstelle_aenderung_tenant_isolation ON messstelle_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/
-- DELETE auf jede neue Tabelle - hier wird bewusst weggenommen, was es nicht
-- geben darf. Die BYPASSRLS-Rolle voltpilot_admin behaelt V4s ALTER DEFAULT
-- PRIVILEGES auf den vier Stammdaten-Tabellen (das Offboarding loescht ueber
-- sie); das Protokoll schuetzt zusaetzlich sein Trigger.
-- -----------------------------------------------------------------------------
-- Eine Messstelle und eine Nebengroesse werden archiviert, nie geloescht; der
-- Zaehler rueckt vor, er verschwindet nicht.
GRANT SELECT, INSERT, UPDATE ON messstelle, messstelle_groesse, messstelle_kennzeichen_seq
    TO ${appDbUser};
REVOKE DELETE ON messstelle, messstelle_groesse, messstelle_kennzeichen_seq FROM ${appDbUser};
-- Die Belegung schreibt nur der Trigger (siehe Kopf).
GRANT SELECT ON messstelle_kennzeichen TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON messstelle_kennzeichen FROM ${appDbUser};
-- Das Protokoll: lesen und anhaengen - auch ueber die Admin-Rolle (die
-- Bestandsuebernahme, IP-16, protokolliert).
GRANT SELECT, INSERT ON messstelle_aenderung TO ${appDbUser};
REVOKE UPDATE, DELETE ON messstelle_aenderung FROM ${appDbUser}, ${adminDbUser};
-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Grant (die rollout_event-Falle):
-- ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen nicht.
GRANT USAGE, SELECT ON SEQUENCE messstelle_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE messstelle_aenderung_id_seq TO ${adminDbUser};

COMMENT ON TABLE messstelle IS
    'UEMS-Messstelle (AP-04 IP-2): fachliche Identitaet einer Messung mit Kennzeichen, '
    'Hauptgroesse und den Zustands-Eingaengen angehalten/archiviert; Vertrag '
    'docs/contracts/v2/messstelle.md.';
COMMENT ON TABLE messstelle_groesse IS
    'Nebengroessen einer Messstelle (AP-04 E1): je (groesse, richtung) einmal, nie die Hauptgroesse.';
COMMENT ON TABLE messstelle_kennzeichen IS
    'Jedes Kennzeichen, das eine Messstelle je trug; der Primaerschluessel verbietet die '
    'Weitergabe an eine andere (AP-04 E7, Regel 9). Nur per Trigger beschrieben.';
COMMENT ON TABLE messstelle_kennzeichen_seq IS
    'Zaehler der automatischen Kennzeichen MS-0001 ... je Mandant (AP-04 E7); rueckt nur vor.';
COMMENT ON TABLE messstelle_aenderung IS
    'Append-only Aenderungsprotokoll der Messstelle mit Urheber (actor_*, AP-03) und gilt ab.';
