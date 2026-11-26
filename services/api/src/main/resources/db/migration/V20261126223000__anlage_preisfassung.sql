-- =============================================================================
-- V20261126223000 - PREISE AB EINEM TAG: Tarif, Preisblatt und Einspeise-
-- vergütung einer Anlage als zeitgültige FASSUNGEN (vp-tarif-ab-tag; Bau-
-- Voraussetzung von Standort-Konzept E1 = B, Bericht vp-standort-konzept §7
-- E1 Punkt 6).
-- -----------------------------------------------------------------------------
-- Bisher waren `site.tarif_art`/`tarif_param_ct_kwh`, das Preisblatt
-- `site_supply_price` und `site.einspeiseverguetung_ct_kwh` (mit
-- `inbetriebnahme_ab_solarspitzengesetz`) je EIN Wert ohne Gültigkeit, und die
-- Erlöse bewerteten JEDE Viertelstunde mit dem heutigen Wert: wer den Tarif
-- wechselte (oder umzog), rechnete die Erlöse aller vergangenen Monate um.
--
--   anlage_preisfassung   je Anlage die Fassungen der drei Preisteile; eine
--                         Fassung gilt ab ihrem Tag (00:00 Europe/Berlin) bis
--                         zum Vortag der nächsten. `gueltig_ab` NULL = „von
--                         Anfang an“ (die Gründungsfassung jeder Anlage).
--   anlage_preiszeitraum  dieselben Fassungen als halboffene Zeiträume
--                         [von, bis) in timestamptz - die Form, mit der jede
--                         Viertelstunde ihre Fassung findet.
--
-- ⚠ DIE SPALTEN AN `site` UND `site_supply_price` BLEIBEN DIE HEUTIGE FASSUNG.
-- Jeder bisherige Leser des HEUTIGEN Stands (Optimierer, Box-Preis, Einstellungen,
-- Diagnose) bleibt unverändert; nur wer vergangene Energie bewertet, liest den
-- Zeitraum. Die Fassungen schreibt NUR die Datenbank selbst: jede Änderung der
-- Preisspalten an `site` und jede Änderung an `site_supply_price` zeichnet ein
-- Trigger auf. Kein Schreibweg kann die Historie vergessen, und der heutige Stand
-- ist immer die jüngste Fassung (jede Änderung gilt „ab einem Tag bis heute“, nie
-- erst in der Zukunft).
--
-- AB WANN: der Tag kommt aus der Transaktion, `set_config('app.preis_gueltig_ab',
-- '<YYYY-MM-DD>' | 'beginn', true)`; ohne Angabe gilt HEUTE (Europe/Berlin) - eine
-- Änderung ohne Tag schreibt also nie die Vergangenheit um. Ein Tag nach heute
-- wird abgelehnt (22023). Eine Änderung „ab Tag T“ ersetzt den geänderten Teil in
-- der Fassung, die an T gilt, UND in jeder späteren (die alten Zeilen werden
-- aufgehoben, nie überschrieben); die anderen beiden Teile bleiben je Tag, wie
-- sie waren.
--
-- WARUM AN DER ANLAGE UND NICHT AM NETZANSCHLUSS (docs/fachmodell/glossar.md
-- „Netzanschluss“): der Netzanschluss ist ein optionales UEMS-Objekt am Standort
-- (V20260913235000, „fünf leere Tabellen“); eine Anlage ohne ihn - jede
-- Privatanlage - hätte keinen Tarif. Den Umzug der Preisspalten an den Anschluss
-- hält das Fachmodell ausdrücklich für das eigene Paket „Netzanschluss-Preisblatt“
-- zurück (AP-10 W9, auswirkungen.md); das Grenzblatt (V20260921120000) hat dafür
-- die Form vorgegeben: eine optionale zeitgültige Fassung am Anschluss ÜBER dem
-- Wert der Anlage. Diese Tabelle ist der Wert der Anlage in derselben Zeitform
-- (Tag, Ende am Vortag der nächsten, `aufgehoben_am` statt Überschreiben).
--
-- BESTAND: jede Anlage bekommt genau eine Gründungsfassung „von Anfang an“ mit
-- ihren heutigen Werten - keine historische Zahl ändert sich (Beweis: Vorher/
-- Nachher-Vergleich der Erlöse auf dem Dev-Seed, PR vp-tarif-ab-tag). Eine
-- Anlage OHNE Preisblatt-Zeile bleibt ohne (`preisblatt` = false, alle Spalten
-- NULL): der Unterschied „keine Zeile“ (Legacy-Bezugsmodell) gegen „Zeile mit
-- leeren Komponenten“ bleibt Byte für Byte erhalten.
--
-- Der Mandant reist mit (Fremdschlüssel über (site_id, tenant_id)); RLS mit
-- FORCE, Rechte eng. Die Gründungsfassungen werden VOR dem FORCE geschrieben
-- (Muster V20260911210000).
-- =============================================================================

CREATE TABLE IF NOT EXISTS anlage_preisfassung (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID          NOT NULL,
    site_id             UUID          NOT NULL,
    -- NULL = von Anfang an (die Gründungsfassung); sonst 00:00 Europe/Berlin.
    gueltig_ab          DATE,
    -- Teil „Tarif“ (site.tarif_art / tarif_param_ct_kwh):
    tarif_art           TEXT          NOT NULL,
    tarif_param_ct_kwh  NUMERIC(8, 3),
    -- Teil „Preisblatt“ (site_supply_price): `preisblatt` = es gab eine Zeile.
    preisblatt                   BOOLEAN       NOT NULL DEFAULT FALSE,
    netzentgelt_arbeitspreis_ct  NUMERIC(6, 3),
    stromsteuer_ct               NUMERIC(6, 3),
    konzessionsabgabe_ct         NUMERIC(6, 3),
    umlagen_ct                   NUMERIC(6, 3),
    vertriebsaufschlag_ct        NUMERIC(6, 3),
    ust_pct                      NUMERIC(5, 2),
    komponenten_stand            DATE,
    -- Teil „Einspeisevergütung“ (site.einspeiseverguetung_ct_kwh mit § 51a-Antwort):
    einspeiseverguetung_ct_kwh            NUMERIC(8, 3),
    inbetriebnahme_ab_solarspitzengesetz  BOOLEAN,
    aufgehoben_am       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT anlage_preisfassung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE CASCADE,
    -- Die Fassungen gehen mit ihrer Anlage (wie site_supply_price): ihre Erlöse gehen mit.
    CONSTRAINT anlage_preisfassung_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    -- Dieselben Invarianten wie an site / site_supply_price.
    CONSTRAINT anlage_preisfassung_tarif_art_chk CHECK (tarif_art IN ('dynamisch', 'fest', 'ohne')),
    CONSTRAINT anlage_preisfassung_tarif_param_chk
        CHECK (tarif_param_ct_kwh IS NULL OR tarif_param_ct_kwh >= 0),
    CONSTRAINT anlage_preisfassung_verguetung_chk
        CHECK (einspeiseverguetung_ct_kwh IS NULL OR einspeiseverguetung_ct_kwh >= 0),
    CONSTRAINT anlage_preisfassung_ust_chk CHECK (ust_pct IS NULL OR (ust_pct >= 0 AND ust_pct <= 100)),
    -- Ohne Preisblatt-Zeile gibt es keine Preisblatt-Werte (das LEFT JOIN von früher).
    CONSTRAINT anlage_preisfassung_ohne_preisblatt_leer CHECK (preisblatt OR (
        netzentgelt_arbeitspreis_ct IS NULL AND stromsteuer_ct IS NULL AND konzessionsabgabe_ct IS NULL
        AND umlagen_ct IS NULL AND vertriebsaufschlag_ct IS NULL AND ust_pct IS NULL
        AND komponenten_stand IS NULL)),
    CONSTRAINT anlage_preisfassung_preisblatt_ust CHECK (NOT preisblatt OR ust_pct IS NOT NULL)
);
-- Je Anlage und Tag höchstens EINE wirksame Fassung (die Gründungsfassung zählt als -infinity).
CREATE UNIQUE INDEX IF NOT EXISTS anlage_preisfassung_eine_je_tag
    ON anlage_preisfassung (tenant_id, site_id, COALESCE(gueltig_ab, '-infinity'::date))
    WHERE aufgehoben_am IS NULL;
-- Der Leseweg (je Anlage die Fassungen in Tagesfolge) und zugleich die Kindseite des
-- Fremdschlüssels auf site (site_id, tenant_id): ohne ihn scannte die RI-Prüfung des Löschzugs voll.
CREATE INDEX IF NOT EXISTS idx_anlage_preisfassung_site
    ON anlage_preisfassung (site_id, tenant_id, gueltig_ab);
-- Der Mandant vorn (Löschzug: Fremdschlüssel auf tenant, Katalog-Tabellen tragen einen tenant_id-Index).
CREATE INDEX IF NOT EXISTS idx_anlage_preisfassung_tenant ON anlage_preisfassung (tenant_id);

-- -----------------------------------------------------------------------------
-- Der Tag einer Änderung aus der Transaktion (siehe Kopf). NULL = von Anfang an.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anlage_preisfassung_ab() RETURNS DATE
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    roh   TEXT := NULLIF(btrim(current_setting('app.preis_gueltig_ab', true)), '');
    heute DATE := (now() AT TIME ZONE 'Europe/Berlin')::date;
    tag   DATE;
BEGIN
    IF roh IS NULL THEN
        RETURN heute;
    END IF;
    IF roh = 'beginn' THEN
        RETURN NULL;
    END IF;
    BEGIN
        tag := roh::date;
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Ungültiger Tag für eine Preisfassung: %', roh
            USING ERRCODE = 'invalid_parameter_value', CONSTRAINT = 'anlage_preisfassung_tag';
    END;
    IF NOT isfinite(tag) OR tag > heute THEN
        RAISE EXCEPTION 'Eine Preisfassung gilt ab heute oder einem Tag davor, nicht ab %', tag
            USING ERRCODE = 'invalid_parameter_value', CONSTRAINT = 'anlage_preisfassung_tag';
    END IF;
    RETURN tag;
END $$;

-- -----------------------------------------------------------------------------
-- Einen Teil ('tarif' | 'preisblatt' | 'verguetung') ab einem Tag auf den heutigen
-- Stand von site / site_supply_price setzen (siehe Kopf). SECURITY INVOKER: unter
-- RLS sieht und schreibt die App-Rolle nur ihren Mandanten.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anlage_preisfassung_setzen(p_site UUID, p_teil TEXT, p_ab DATE)
    RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    ab_k     DATE := COALESCE(p_ab, '-infinity'::date);
    s        RECORD;
    sp       RECORD;
    hat_sp   BOOLEAN;
    f        anlage_preisfassung%ROWTYPE;
    basis    anlage_preisfassung%ROWTYPE;
    am_tag   BOOLEAN := FALSE;
BEGIN
    IF p_teil NOT IN ('tarif', 'preisblatt', 'verguetung') THEN
        RAISE EXCEPTION 'Unbekannter Preisteil %', p_teil USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Die Anlage (gesperrt: zwei Änderungen derselben Anlage laufen nacheinander).
    -- Fehlt sie, wird sie gerade gelöscht (Kaskade von site_supply_price): nichts aufzeichnen.
    SELECT id, tenant_id, tarif_art, tarif_param_ct_kwh, einspeiseverguetung_ct_kwh,
           inbetriebnahme_ab_solarspitzengesetz
      INTO s FROM site WHERE id = p_site FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT netzentgelt_arbeitspreis_ct, stromsteuer_ct, konzessionsabgabe_ct, umlagen_ct,
           vertriebsaufschlag_ct, ust_pct, komponenten_stand
      INTO sp FROM site_supply_price WHERE site_id = p_site;
    hat_sp := FOUND;

    -- Die Fassung, die am Tag gilt (die Gründungsfassung gilt immer).
    SELECT * INTO basis FROM anlage_preisfassung
     WHERE site_id = p_site AND aufgehoben_am IS NULL
       AND COALESCE(gueltig_ab, '-infinity'::date) <= ab_k
     ORDER BY COALESCE(gueltig_ab, '-infinity'::date) DESC LIMIT 1;
    IF NOT FOUND THEN
        -- Keine Fassung (nur denkbar, wenn der Gründungs-Trigger umgangen wurde): der
        -- heutige Stand wird die Gründungsfassung, ab_k bekommt ihn ebenso.
        INSERT INTO anlage_preisfassung (tenant_id, site_id, gueltig_ab, tarif_art, tarif_param_ct_kwh,
               preisblatt, netzentgelt_arbeitspreis_ct, stromsteuer_ct, konzessionsabgabe_ct, umlagen_ct,
               vertriebsaufschlag_ct, ust_pct, komponenten_stand, einspeiseverguetung_ct_kwh,
               inbetriebnahme_ab_solarspitzengesetz)
        VALUES (s.tenant_id, p_site, NULL, s.tarif_art, s.tarif_param_ct_kwh,
               hat_sp, sp.netzentgelt_arbeitspreis_ct, sp.stromsteuer_ct, sp.konzessionsabgabe_ct,
               sp.umlagen_ct, sp.vertriebsaufschlag_ct, sp.ust_pct, sp.komponenten_stand,
               s.einspeiseverguetung_ct_kwh, s.inbetriebnahme_ab_solarspitzengesetz);
        RETURN;
    END IF;

    -- Jede Fassung ab dem Tag: aufheben und mit dem neuen Teil neu schreiben.
    FOR f IN SELECT * FROM anlage_preisfassung
              WHERE site_id = p_site AND aufgehoben_am IS NULL
                AND COALESCE(gueltig_ab, '-infinity'::date) >= ab_k
              ORDER BY COALESCE(gueltig_ab, '-infinity'::date)
    LOOP
        IF COALESCE(f.gueltig_ab, '-infinity'::date) = ab_k THEN
            am_tag := TRUE;
        END IF;
        UPDATE anlage_preisfassung SET aufgehoben_am = clock_timestamp() WHERE id = f.id;
        f.id := gen_random_uuid();
        f.aufgehoben_am := NULL;
        f.created_at := now();
        IF p_teil = 'tarif' THEN
            f.tarif_art := s.tarif_art;
            f.tarif_param_ct_kwh := s.tarif_param_ct_kwh;
        ELSIF p_teil = 'verguetung' THEN
            f.einspeiseverguetung_ct_kwh := s.einspeiseverguetung_ct_kwh;
            f.inbetriebnahme_ab_solarspitzengesetz := s.inbetriebnahme_ab_solarspitzengesetz;
        ELSE
            f.preisblatt := hat_sp;
            f.netzentgelt_arbeitspreis_ct := sp.netzentgelt_arbeitspreis_ct;
            f.stromsteuer_ct := sp.stromsteuer_ct;
            f.konzessionsabgabe_ct := sp.konzessionsabgabe_ct;
            f.umlagen_ct := sp.umlagen_ct;
            f.vertriebsaufschlag_ct := sp.vertriebsaufschlag_ct;
            f.ust_pct := sp.ust_pct;
            f.komponenten_stand := sp.komponenten_stand;
        END IF;
        INSERT INTO anlage_preisfassung SELECT f.*;
    END LOOP;

    -- Am Tag selbst gab es noch keine Fassung: die geltende mit dem neuen Teil ab dem Tag.
    IF NOT am_tag THEN
        basis.id := gen_random_uuid();
        basis.gueltig_ab := p_ab;
        basis.aufgehoben_am := NULL;
        basis.created_at := now();
        IF p_teil = 'tarif' THEN
            basis.tarif_art := s.tarif_art;
            basis.tarif_param_ct_kwh := s.tarif_param_ct_kwh;
        ELSIF p_teil = 'verguetung' THEN
            basis.einspeiseverguetung_ct_kwh := s.einspeiseverguetung_ct_kwh;
            basis.inbetriebnahme_ab_solarspitzengesetz := s.inbetriebnahme_ab_solarspitzengesetz;
        ELSE
            basis.preisblatt := hat_sp;
            basis.netzentgelt_arbeitspreis_ct := sp.netzentgelt_arbeitspreis_ct;
            basis.stromsteuer_ct := sp.stromsteuer_ct;
            basis.konzessionsabgabe_ct := sp.konzessionsabgabe_ct;
            basis.umlagen_ct := sp.umlagen_ct;
            basis.vertriebsaufschlag_ct := sp.vertriebsaufschlag_ct;
            basis.ust_pct := sp.ust_pct;
            basis.komponenten_stand := sp.komponenten_stand;
        END IF;
        INSERT INTO anlage_preisfassung SELECT basis.*;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Die Trigger: eine neue Anlage bekommt ihre Gründungsfassung, jede Änderung eines
-- Preisteils wird ab dem Tag der Transaktion aufgezeichnet.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anlage_preisfassung_gruenden() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO anlage_preisfassung (tenant_id, site_id, gueltig_ab, tarif_art, tarif_param_ct_kwh,
           einspeiseverguetung_ct_kwh, inbetriebnahme_ab_solarspitzengesetz)
    VALUES (NEW.tenant_id, NEW.id, NULL, NEW.tarif_art, NEW.tarif_param_ct_kwh,
           NEW.einspeiseverguetung_ct_kwh, NEW.inbetriebnahme_ab_solarspitzengesetz);
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION anlage_preisfassung_site_aufzeichnen() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    ab DATE;
BEGIN
    IF NEW.tarif_art IS DISTINCT FROM OLD.tarif_art
            OR NEW.tarif_param_ct_kwh IS DISTINCT FROM OLD.tarif_param_ct_kwh THEN
        ab := anlage_preisfassung_ab();
        PERFORM anlage_preisfassung_setzen(NEW.id, 'tarif', ab);
    END IF;
    IF NEW.einspeiseverguetung_ct_kwh IS DISTINCT FROM OLD.einspeiseverguetung_ct_kwh
            OR NEW.inbetriebnahme_ab_solarspitzengesetz IS DISTINCT FROM OLD.inbetriebnahme_ab_solarspitzengesetz THEN
        ab := anlage_preisfassung_ab();
        PERFORM anlage_preisfassung_setzen(NEW.id, 'verguetung', ab);
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION anlage_preisfassung_preisblatt_aufzeichnen() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE'
            AND NEW.netzentgelt_arbeitspreis_ct IS NOT DISTINCT FROM OLD.netzentgelt_arbeitspreis_ct
            AND NEW.stromsteuer_ct IS NOT DISTINCT FROM OLD.stromsteuer_ct
            AND NEW.konzessionsabgabe_ct IS NOT DISTINCT FROM OLD.konzessionsabgabe_ct
            AND NEW.umlagen_ct IS NOT DISTINCT FROM OLD.umlagen_ct
            AND NEW.vertriebsaufschlag_ct IS NOT DISTINCT FROM OLD.vertriebsaufschlag_ct
            AND NEW.ust_pct IS NOT DISTINCT FROM OLD.ust_pct
            AND NEW.komponenten_stand IS NOT DISTINCT FROM OLD.komponenten_stand
            AND NEW.site_id = OLD.site_id THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        PERFORM anlage_preisfassung_setzen(OLD.site_id, 'preisblatt', anlage_preisfassung_ab());
    ELSE
        PERFORM anlage_preisfassung_setzen(NEW.site_id, 'preisblatt', anlage_preisfassung_ab());
    END IF;
    RETURN NULL;
END $$;

-- Die Gründungsfassungen des Bestands: die heutigen Werte gelten von Anfang an.
INSERT INTO anlage_preisfassung (tenant_id, site_id, gueltig_ab, tarif_art, tarif_param_ct_kwh,
       preisblatt, netzentgelt_arbeitspreis_ct, stromsteuer_ct, konzessionsabgabe_ct, umlagen_ct,
       vertriebsaufschlag_ct, ust_pct, komponenten_stand, einspeiseverguetung_ct_kwh,
       inbetriebnahme_ab_solarspitzengesetz)
SELECT s.tenant_id, s.id, NULL, s.tarif_art, s.tarif_param_ct_kwh,
       ssp.site_id IS NOT NULL, ssp.netzentgelt_arbeitspreis_ct, ssp.stromsteuer_ct,
       ssp.konzessionsabgabe_ct, ssp.umlagen_ct, ssp.vertriebsaufschlag_ct, ssp.ust_pct,
       ssp.komponenten_stand, s.einspeiseverguetung_ct_kwh, s.inbetriebnahme_ab_solarspitzengesetz
  FROM site s
  LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id
 WHERE NOT EXISTS (SELECT 1 FROM anlage_preisfassung f WHERE f.site_id = s.id);

DROP TRIGGER IF EXISTS anlage_preisfassung_gruenden ON site;
CREATE TRIGGER anlage_preisfassung_gruenden AFTER INSERT ON site
    FOR EACH ROW EXECUTE FUNCTION anlage_preisfassung_gruenden();
DROP TRIGGER IF EXISTS anlage_preisfassung_site_aufzeichnen ON site;
CREATE TRIGGER anlage_preisfassung_site_aufzeichnen
    AFTER UPDATE OF tarif_art, tarif_param_ct_kwh, einspeiseverguetung_ct_kwh,
                    inbetriebnahme_ab_solarspitzengesetz ON site
    FOR EACH ROW EXECUTE FUNCTION anlage_preisfassung_site_aufzeichnen();
DROP TRIGGER IF EXISTS anlage_preisfassung_preisblatt_aufzeichnen ON site_supply_price;
CREATE TRIGGER anlage_preisfassung_preisblatt_aufzeichnen
    AFTER INSERT OR UPDATE OR DELETE ON site_supply_price
    FOR EACH ROW EXECUTE FUNCTION anlage_preisfassung_preisblatt_aufzeichnen();

-- -----------------------------------------------------------------------------
-- Der Leseweg: die wirksamen Fassungen als halboffene Zeiträume [von, bis).
-- security_invoker: die RLS der Tabelle gilt für den Aufrufer, nie für den Eigentümer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW anlage_preiszeitraum WITH (security_invoker = true) AS
SELECT f.site_id,
       f.tenant_id,
       f.gueltig_ab,
       CASE WHEN f.gueltig_ab IS NULL THEN '-infinity'::timestamptz
            ELSE f.gueltig_ab::timestamp AT TIME ZONE 'Europe/Berlin' END AS von,
       COALESCE(lead(f.gueltig_ab::timestamp AT TIME ZONE 'Europe/Berlin') OVER w,
                'infinity'::timestamptz) AS bis,
       f.tarif_art,
       f.tarif_param_ct_kwh,
       f.preisblatt,
       f.netzentgelt_arbeitspreis_ct,
       f.stromsteuer_ct,
       f.konzessionsabgabe_ct,
       f.umlagen_ct,
       f.vertriebsaufschlag_ct,
       f.ust_pct,
       f.komponenten_stand,
       f.einspeiseverguetung_ct_kwh,
       f.inbetriebnahme_ab_solarspitzengesetz
  FROM anlage_preisfassung f
 WHERE f.aufgehoben_am IS NULL
WINDOW w AS (PARTITION BY f.site_id ORDER BY f.gueltig_ab NULLS FIRST);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE anlage_preisfassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE anlage_preisfassung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anlage_preisfassung_tenant_isolation ON anlage_preisfassung;
CREATE POLICY anlage_preisfassung_tenant_isolation ON anlage_preisfassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. ALTER DEFAULT PRIVILEGES gibt beiden Rollen alles - hier wird ALLES
-- genommen und eng neu gegeben: die Trigger laufen mit den Rechten des Schreibers
-- und brauchen Einfügen und Aufheben; geändert oder gelöscht wird eine Fassung nie
-- (sie geht nur mit ihrer Anlage).
-- -----------------------------------------------------------------------------
REVOKE ALL ON anlage_preisfassung, anlage_preiszeitraum FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON anlage_preisfassung TO ${appDbUser}, ${adminDbUser};
GRANT UPDATE (aufgehoben_am) ON anlage_preisfassung TO ${appDbUser}, ${adminDbUser};
GRANT DELETE ON anlage_preisfassung TO ${adminDbUser};
GRANT SELECT ON anlage_preiszeitraum TO ${appDbUser}, ${adminDbUser};

COMMENT ON TABLE anlage_preisfassung IS
    'vp-tarif-ab-tag: Tarif, Preisblatt und Einspeiseverguetung einer Anlage als Fassungen ab einem Tag (Europe/Berlin); nur per Trigger geschrieben; site/site_supply_price tragen die heutige Fassung.';
COMMENT ON VIEW anlage_preiszeitraum IS
    'vp-tarif-ab-tag: die wirksamen Preisfassungen als halboffene Zeitraeume [von, bis); jede bewertete Viertelstunde liest die Fassung ihres Zeitpunkts.';
