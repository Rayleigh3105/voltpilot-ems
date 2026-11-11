-- =============================================================================
-- Messkonzepte S1 — die ERZEUGUNGSANLAGE (EA) mit Fassungen, nur Anzeige
-- (Bericht „Mehrere Erzeugungsanlagen an einem Netzanschluss“ §4.1, §4.5, §4.8;
-- Captain-Entscheide F1–F5 vom 11.11.2026; Fachmodell „Erzeugungsanlage“).
--
--   erzeugungsanlage             eine Anlage im Sinn ihrer Förderung: Nummer
--                                („EA 1“), Name, Art, Inbetriebnahme, Einheit im
--                                Marktstammdatenregister (SEE)
--   erzeugungsanlage_fassung     was sich ab einem Tag ändert: Leistung, Einspeiseart,
--                                ein vom Kunden angegebener Satz — nie überschrieben
--   erzeugungsanlage_komponente  welche Komponente der Anlage sie speist (ganz oder
--                                Eingang k), zeitgültig; ohne Komponente erlaubt
--   erzeugungsanlage_aenderung   das Änderungsprotokoll (ein Eintrag je Schreibvorgang)
--
-- WO SIE HÄNGT. Fachlich am Netzanschluss. Im Code trägt sie die ANLAGE (`site_id`):
-- eine Anlage hängt je Tag an genau einem Netzanschluss (anlage_netzanschluss), und
-- die meisten Anlagen haben gar keinen angelegten Netzanschluss — sie sollen ihre EA
-- trotzdem haben. Die Seite des Netzanschlusses liest die EA über die Bindung des Tages.
--
-- ⚠ NUR ANZEIGE. Satz, Fahrplan, Erlöse und alles, was die Box bekommt, lesen weiter
-- `site.einspeiseverguetung_ct_kwh` und das primäre PV-Aggregat (`asset`). Diese
-- Migration ändert keine Bestandszeile; sie legt nur Zeilen in den vier neuen Tabellen an.
--
-- DER BESTAND. Jede Anlage mit einem primären PV-Aggregat bekommt EA 1 aus dessen
-- Inbetriebnahme, Leistung (der PV-Summe der Anlage) und MaStR-Einheit, dazu den
-- eigenen Satz der Anlage. Diese EA 1 „folgt der Anlage“ (`folgt_anlage`): solange
-- sie die einzige ist, zieht jede Änderung an PV-Summe, MaStR-Übernahme oder eigenem
-- Satz als neue Fassung nach (`ErzeugungsanlageBestand`). So bleibt eine einfache
-- Anlage einfach — der Weg SEE-Nummer → Nachschlagen → Übernehmen erzeugt EA 1 — und
-- ihre EA zeigt nie etwas anderes als die Karte „Einspeisevergütung“. Weitere
-- Erzeuger mit kWp werden NICHT still zu EA: das Portal zeigt sie als Vorschlag.
--
-- DIE TAGE (Zeitform von netzanschluss_grenze): eine Fassung gilt ab ihrem Tag bis
-- zum Vortag der nächsten; `gueltig_ab` NULL ist die erste Fassung „von der
-- Inbetriebnahme an“ (kein Tag erhoben, nie „ab heute“). Eine zweite Fassung am
-- selben Tag hebt die erste auf (`aufgehoben_am`), nie überschrieben.
--
-- Unbekannt ist keine Null: fehlende Leistung, Inbetriebnahme oder Einspeiseart
-- sind NULL („nicht erhoben“), nie 0.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- erzeugungsanlage — die Identität
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeugungsanlage (
    id                                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                            UUID        NOT NULL,
    site_id                              UUID        NOT NULL,
    -- „EA 1“, „EA 2“ — je Anlage, einmal vergeben nie neu vergeben (auch nicht nach
    -- dem Aufheben), damit „EA 2“ in alten Notizen dieselbe bleibt.
    nummer                               INTEGER     NOT NULL,
    name                                 TEXT,
    -- Dasselbe Vokabular wie `energietraeger` im Messkonzept-Katalog.
    art                                  TEXT        NOT NULL DEFAULT 'pv',
    -- NULL = nicht erhoben.
    inbetriebnahme                       DATE,
    -- Nur ohne Inbetriebnahme von Belang (§ 51a EEG), wie
    -- site.inbetriebnahme_ab_solarspitzengesetz; mit Datum entscheidet das Datum.
    inbetriebnahme_ab_solarspitzengesetz BOOLEAN,
    registry                             TEXT,
    registry_unit_id                     TEXT,
    registry_fetched_at                  TIMESTAMPTZ,
    -- EA 1 aus dem Bestand: folgt PV-Summe, MaStR-Übernahme und eigenem Satz der
    -- Anlage, solange sie die einzige EA ist.
    folgt_anlage                         BOOLEAN     NOT NULL DEFAULT false,
    -- Versehentlich angelegt: aufgehoben, nie gelöscht.
    aufgehoben_am                        TIMESTAMPTZ,
    created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by                           TEXT,
    updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT erzeugungsanlage_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeugungsanlage_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeugungsanlage_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT erzeugungsanlage_nummer_eindeutig UNIQUE (tenant_id, site_id, nummer),
    CONSTRAINT erzeugungsanlage_nummer_chk CHECK (nummer BETWEEN 1 AND 99),
    CONSTRAINT erzeugungsanlage_name_chk
        CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 80 AND btrim(name) = name AND name <> '')),
    CONSTRAINT erzeugungsanlage_art_chk
        CHECK (art IN ('pv', 'wind', 'wasser', 'biomasse', 'kwk', 'sonstige')),
    CONSTRAINT erzeugungsanlage_registry_chk
        CHECK ((registry IS NULL OR registry = 'mastr')
               AND (registry_unit_id IS NULL OR registry_unit_id ~ '^SEE[0-9]{12}$')),
    -- Mit Datum zählt die Antwort zu § 51a nicht; sie wird dann nicht gespeichert.
    CONSTRAINT erzeugungsanlage_stichtag_chk
        CHECK (inbetriebnahme IS NULL OR inbetriebnahme_ab_solarspitzengesetz IS NULL)
);
-- Höchstens EINE EA einer Anlage folgt der Anlage.
CREATE UNIQUE INDEX IF NOT EXISTS erzeugungsanlage_eine_folgt
    ON erzeugungsanlage (tenant_id, site_id) WHERE folgt_anlage AND aufgehoben_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_erzeugungsanlage_site ON erzeugungsanlage (site_id);

-- -----------------------------------------------------------------------------
-- erzeugungsanlage_fassung — was sich ab einem Tag ändert
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeugungsanlage_fassung (
    id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID          NOT NULL,
    erzeugungsanlage_id    UUID          NOT NULL,
    -- NULL = die erste Fassung, von der Inbetriebnahme an.
    gueltig_ab             DATE,
    leistung_kwp           NUMERIC(12, 3),
    -- voll | ueberschuss; NULL = nicht erhoben.
    einspeiseart           TEXT,
    -- Der vom Kunden angegebene Satz dieser EA (ct/kWh, 0 bis 100); NULL = keiner,
    -- dann gilt die Herleitung aus dem EEG-Satzplan. 0 ist eine Angabe.
    satz_angegeben_ct_kwh  NUMERIC(8, 3),
    -- Woher die Fassung kommt: bestand (folgt der Anlage) · mastr (bestätigte
    -- Registerwerte) · angegeben (von einer Person eingetragen).
    herkunft               TEXT          NOT NULL,
    aufgehoben_am          TIMESTAMPTZ,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by             TEXT,
    CONSTRAINT erzeugungsanlage_fassung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeugungsanlage_fassung_ea_fk FOREIGN KEY (erzeugungsanlage_id, tenant_id)
        REFERENCES erzeugungsanlage (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeugungsanlage_fassung_leistung_chk CHECK (leistung_kwp IS NULL OR leistung_kwp > 0),
    CONSTRAINT erzeugungsanlage_fassung_einspeiseart_chk
        CHECK (einspeiseart IS NULL OR einspeiseart IN ('voll', 'ueberschuss')),
    CONSTRAINT erzeugungsanlage_fassung_satz_chk
        CHECK (satz_angegeben_ct_kwh IS NULL OR satz_angegeben_ct_kwh BETWEEN 0 AND 100),
    CONSTRAINT erzeugungsanlage_fassung_herkunft_chk CHECK (herkunft IN ('bestand', 'mastr', 'angegeben'))
);
-- Je EA und Tag höchstens EINE wirksame Fassung (die erste zählt als ein Tag).
CREATE UNIQUE INDEX IF NOT EXISTS erzeugungsanlage_fassung_eine_je_tag
    ON erzeugungsanlage_fassung (tenant_id, erzeugungsanlage_id, COALESCE(gueltig_ab, '-infinity'::date))
    WHERE aufgehoben_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_erzeugungsanlage_fassung_ea ON erzeugungsanlage_fassung (erzeugungsanlage_id);

-- -----------------------------------------------------------------------------
-- erzeugungsanlage_komponente — wer sie speist
-- -----------------------------------------------------------------------------
-- Eine Komponente (measurement_point) kann zwei EA über zwei Eingänge speisen, eine EA
-- mehrere Komponenten haben. Löscht jemand die Komponente, geht ihr Verweis mit.
CREATE TABLE IF NOT EXISTS erzeugungsanlage_komponente (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL,
    erzeugungsanlage_id    UUID        NOT NULL,
    komponente_id          UUID        NOT NULL,
    -- NULL = die ganze Komponente; k = ihr Eingang k (z. B. MPP-Eingang eines Wechselrichters).
    eingang                INTEGER,
    gueltig_ab             DATE        NOT NULL,
    gueltig_bis            DATE,
    aufgehoben_am          TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by             TEXT,
    CONSTRAINT erzeugungsanlage_komponente_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeugungsanlage_komponente_ea_fk FOREIGN KEY (erzeugungsanlage_id, tenant_id)
        REFERENCES erzeugungsanlage (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeugungsanlage_komponente_komponente_fk FOREIGN KEY (komponente_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT erzeugungsanlage_komponente_eingang_chk CHECK (eingang IS NULL OR eingang BETWEEN 1 AND 20),
    CONSTRAINT erzeugungsanlage_komponente_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Dieselbe Komponente (und derselbe Eingang) hängt an einem Tag höchstens EINMAL an
    -- einer EA; ob sie zugleich eine andere EA speist, prüft der Dienst.
    CONSTRAINT erzeugungsanlage_komponente_einmal EXCLUDE USING gist (
        tenant_id WITH =,
        erzeugungsanlage_id WITH =,
        komponente_id WITH =,
        (COALESCE(eingang, 0)) WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_erzeugungsanlage_komponente_ea ON erzeugungsanlage_komponente (erzeugungsanlage_id);
CREATE INDEX IF NOT EXISTS idx_erzeugungsanlage_komponente_komponente ON erzeugungsanlage_komponente (komponente_id);

-- -----------------------------------------------------------------------------
-- erzeugungsanlage_aenderung — das Protokoll (Akteur-Vokabular AP-03 wie
-- netzanschluss_aenderung). Kein Verweis auf die EA: ein Protokoll überlebt sein
-- Objekt; nur das Offboarding räumt es ab.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erzeugungsanlage_aenderung (
    id                   BIGSERIAL   PRIMARY KEY,
    tenant_id            UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    erzeugungsanlage_id  UUID        NOT NULL,
    -- angelegt · bearbeitet · fassung · komponente · aufgehoben · bestand (die Anlage
    -- hat sich geändert, die EA ist gefolgt)
    art                  TEXT        NOT NULL,
    alt                  JSONB,
    neu                  JSONB,
    actor_sub            TEXT,
    actor_name           TEXT        NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT erzeugungsanlage_aenderung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT erzeugungsanlage_aenderung_art_chk
        CHECK (art IN ('angelegt', 'bearbeitet', 'fassung', 'komponente', 'aufgehoben', 'bestand'))
);
CREATE INDEX IF NOT EXISTS idx_erzeugungsanlage_aenderung_ea ON erzeugungsanlage_aenderung (erzeugungsanlage_id);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (fremd ist 404, ohne app.tenant_id 0 Zeilen) und der Standortzaun
-- -----------------------------------------------------------------------------
ALTER TABLE erzeugungsanlage ENABLE ROW LEVEL SECURITY;
ALTER TABLE erzeugungsanlage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erzeugungsanlage_tenant_isolation ON erzeugungsanlage;
CREATE POLICY erzeugungsanlage_tenant_isolation ON erzeugungsanlage
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS erzeugungsanlage_site_scope ON erzeugungsanlage;
CREATE POLICY erzeugungsanlage_site_scope ON erzeugungsanlage AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

ALTER TABLE erzeugungsanlage_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE erzeugungsanlage_fassung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erzeugungsanlage_fassung_tenant_isolation ON erzeugungsanlage_fassung;
CREATE POLICY erzeugungsanlage_fassung_tenant_isolation ON erzeugungsanlage_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE erzeugungsanlage_komponente ENABLE ROW LEVEL SECURITY;
ALTER TABLE erzeugungsanlage_komponente FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erzeugungsanlage_komponente_tenant_isolation ON erzeugungsanlage_komponente;
CREATE POLICY erzeugungsanlage_komponente_tenant_isolation ON erzeugungsanlage_komponente
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE erzeugungsanlage_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE erzeugungsanlage_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erzeugungsanlage_aenderung_tenant_isolation ON erzeugungsanlage_aenderung;
CREATE POLICY erzeugungsanlage_aenderung_tenant_isolation ON erzeugungsanlage_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS erzeugungsanlage_aenderung_site_scope ON erzeugungsanlage_aenderung;
CREATE POLICY erzeugungsanlage_aenderung_site_scope ON erzeugungsanlage_aenderung AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

-- -----------------------------------------------------------------------------
-- Rechte. ALTER DEFAULT PRIVILEGES gibt beiden Rollen alles — hier wird ALLES genommen
-- und eng neu gegeben. Nichts wird gelöscht: eine EA und eine Fassung werden
-- aufgehoben, ein Verweis beendet oder aufgehoben; das Offboarding räumt ab.
-- -----------------------------------------------------------------------------
REVOKE ALL ON erzeugungsanlage, erzeugungsanlage_fassung, erzeugungsanlage_komponente,
    erzeugungsanlage_aenderung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON erzeugungsanlage TO ${appDbUser};
GRANT UPDATE (name, art, inbetriebnahme, inbetriebnahme_ab_solarspitzengesetz, registry, registry_unit_id,
              registry_fetched_at, folgt_anlage, aufgehoben_am, updated_at) ON erzeugungsanlage TO ${appDbUser};
GRANT SELECT, INSERT ON erzeugungsanlage_fassung TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON erzeugungsanlage_fassung TO ${appDbUser};
GRANT SELECT, INSERT ON erzeugungsanlage_komponente TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON erzeugungsanlage_komponente TO ${appDbUser};
GRANT SELECT, INSERT ON erzeugungsanlage_aenderung TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE erzeugungsanlage_aenderung_id_seq TO ${appDbUser};
GRANT SELECT, DELETE ON erzeugungsanlage, erzeugungsanlage_fassung, erzeugungsanlage_komponente,
    erzeugungsanlage_aenderung TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- Der Bestand: EA 1 aus dem primären PV-Aggregat (idempotent)
-- -----------------------------------------------------------------------------
-- Nur Anlagen, deren PV-Aggregat überhaupt etwas trägt (Leistung, Inbetriebnahme oder
-- MaStR-Einheit); ein leeres Aggregat bekommt EA 1 mit der ersten Angabe
-- (ErzeugungsanlageBestand). Eine Register-Angabe, die nicht die Form einer SEE-Nummer
-- hat, wird nicht übernommen (die EA bleibt dann ohne Einheit) — die Migration
-- scheitert nie an einer Bestandszeile.
INSERT INTO erzeugungsanlage (tenant_id, site_id, nummer, art, inbetriebnahme,
                              inbetriebnahme_ab_solarspitzengesetz, registry, registry_unit_id,
                              registry_fetched_at, folgt_anlage, created_by)
SELECT a.tenant_id, a.site_id, 1, 'pv', a.commissioned_on,
       CASE WHEN a.commissioned_on IS NULL THEN s.inbetriebnahme_ab_solarspitzengesetz END,
       CASE WHEN a.registry = 'mastr' AND a.registry_unit_id ~ '^SEE[0-9]{12}$' THEN 'mastr' END,
       CASE WHEN a.registry = 'mastr' AND a.registry_unit_id ~ '^SEE[0-9]{12}$' THEN a.registry_unit_id END,
       CASE WHEN a.registry = 'mastr' AND a.registry_unit_id ~ '^SEE[0-9]{12}$' THEN a.registry_fetched_at END,
       true, 'Bestandsübernahme'
FROM asset a
JOIN site s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
WHERE a.type = 'pv' AND a.is_primary
  AND (a.pv_capacity_kwp > 0 OR a.commissioned_on IS NOT NULL OR a.registry_unit_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM erzeugungsanlage e WHERE e.site_id = a.site_id);

-- Ihre erste Fassung: von der Inbetriebnahme an, mit der PV-Summe der Anlage und
-- deren eigenem Satz — dieselben Werte, mit denen die Karte „Einspeisevergütung“ heute
-- rechnet.
INSERT INTO erzeugungsanlage_fassung (tenant_id, erzeugungsanlage_id, gueltig_ab, leistung_kwp,
                                      einspeiseart, satz_angegeben_ct_kwh, herkunft, created_by)
SELECT e.tenant_id, e.id, NULL,
       CASE WHEN a.pv_capacity_kwp > 0 THEN a.pv_capacity_kwp END,
       NULL,
       CASE WHEN s.einspeiseverguetung_ct_kwh BETWEEN 0 AND 100 THEN s.einspeiseverguetung_ct_kwh END,
       'bestand', 'Bestandsübernahme'
FROM erzeugungsanlage e
JOIN asset a ON a.site_id = e.site_id AND a.tenant_id = e.tenant_id AND a.type = 'pv' AND a.is_primary
JOIN site s ON s.id = e.site_id AND s.tenant_id = e.tenant_id
WHERE e.folgt_anlage AND e.nummer = 1
  AND NOT EXISTS (SELECT 1 FROM erzeugungsanlage_fassung f WHERE f.erzeugungsanlage_id = e.id);

-- Und je EA 1 genau ein Protokolleintrag „angelegt“.
INSERT INTO erzeugungsanlage_aenderung (tenant_id, site_id, erzeugungsanlage_id, art, alt, neu,
                                        actor_sub, actor_name, actor_rolle, actor_art)
SELECT e.tenant_id, e.site_id, e.id, 'angelegt', NULL,
       jsonb_build_object('nummer', e.nummer, 'inbetriebnahme', e.inbetriebnahme,
                          'registry_unit_id', e.registry_unit_id, 'folgt_anlage', true),
       NULL, 'Bestandsübernahme', 'voltpilot_betrieb', 'voltpilot'
FROM erzeugungsanlage e
WHERE e.created_by = 'Bestandsübernahme'
  AND NOT EXISTS (SELECT 1 FROM erzeugungsanlage_aenderung x WHERE x.erzeugungsanlage_id = e.id);

COMMENT ON TABLE erzeugungsanlage IS
    'Messkonzepte S1: Erzeugungsanlage (EA) im Sinn ihrer Förderung, an der Anlage (fachlich am Netzanschluss); nur Anzeige - Satz, Fahrplan und Erlöse lesen weiter site/asset.';
COMMENT ON TABLE erzeugungsanlage_fassung IS
    'Messkonzepte S1: Leistung, Einspeiseart und angegebener Satz einer EA ab einem Tag (NULL = von der Inbetriebnahme an); aufheben statt ändern.';
COMMENT ON TABLE erzeugungsanlage_komponente IS
    'Messkonzepte S1: welche Komponente (ganz oder Eingang k) eine EA speist, zeitgültig.';
COMMENT ON TABLE erzeugungsanlage_aenderung IS
    'Messkonzepte S1: Änderungsprotokoll der Erzeugungsanlagen (append-only).';
