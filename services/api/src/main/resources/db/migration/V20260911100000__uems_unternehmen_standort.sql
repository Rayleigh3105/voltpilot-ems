-- UEMS AP-02 IP-2a: die ersten UEMS-Tabellen — Unternehmen, Standort, die
-- zeitgültige Anlagen-Zuordnung und das Änderungsprotokoll der Ortsstruktur.
--
-- Die Prosa-Wahrheit ist das Konzept vp-uems-ap02-ortsstruktur (§4.1 Felder,
-- §4.2 Zustände, §4.3 Gültigkeit, §4.5 Invarianten, §6.2 Datenhaltung; Captain-
-- Entscheide vom 10.09.2026). Die Gültigkeitsmechanik ist VERTRAG:
-- docs/contracts/v2/ortsbaum-vectors.json (AP-02 IP-1) mit den Zwillingen
-- OrtsbaumAbleitung.java / uemsOrtsbaum.ts. Diese Migration sagt dasselbe als
-- Constraint; UemsStandortMigrationTest spielt die Überlappungs-Fälle der
-- Vektor-Datei gegen die Datenbank.
--
-- ⚠ REIN ADDITIV. `tenant` und `site` bleiben zeichengleich — keine Spalte,
-- kein Index, keine Policy, kein Datensatz. Kein Topic, keine Freigabe, kein
-- Betriebsmodell wird berührt (§6.3, Regel 9). Die Anlage hängt NICHT per
-- Spalte `site.standort_id` am Standort, sondern über `anlage_standort`: nur
-- so trägt ein Umzug Historie (§6.2).
--
-- BACKFILL (AP-00 E2, AP-02 §6.3): je Mandant GENAU EIN Unternehmen, Name aus
-- dem Kundenbereich, Zeitzone Europe/Berlin, dazu sein Protokolleintrag
-- „angelegt". MEHR NICHT: Standorte und Anlagen-Zuordnungen der Bestandskunden
-- legt erst die Bestandsübernahme an (IP-9) — bis dahin ist jede Anlage „noch
-- nicht zugeordnet". Ein erneuter Lauf legt nichts doppelt an.
--
-- LÖSCHEN (Plan-Regel „nichts mit Historie wird gelöscht"): jeder Fremd-
-- schlüssel auf tenant/site/unternehmen/standort ist ON DELETE RESTRICT, nie
-- Kaskade. Standorte werden archiviert, Zuordnungen beendet oder aufgehoben.
-- Die Folgen, bewusst:
--   * Das Offboarding eines Kundenbereichs (TenantRepository.offboard) räumt
--     die drei Stammdaten-Tabellen AUSDRÜCKLICH ab, bevor es den Mandanten
--     löscht — der einzige Weg, auf dem ein Unternehmen endet (§4.1).
--   * Eine Anlage mit Standort-Zuordnung lässt sich nicht löschen, solange die
--     Zuordnung steht. Heute gibt es keine (erst IP-9 legt sie an); den
--     Grabstein beim Anlagen-Löschen (W5) entscheidet IP-9/AP-14 — bis dahin
--     verweigert die Datenbank, statt die Historie still mitzunehmen.
--   * `ort_aenderung` ist append-only und trägt deshalb GAR KEINEN Fremd-
--     schlüssel (Muster component_change_event, V20260843000000): ein
--     Protokoll überlebt das Objekt, von dem es erzählt.

-- Das Überlappungsverbot braucht `=` auf uuid in einem GiST-Index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Die Nutzung (AP-02 E4) — EIN Vokabular, das auch `ort` (IP-2b) benutzt
-- -----------------------------------------------------------------------------
-- Geschlossen, Mehrfachauswahl, die ERSTE Auswahl ist die Hauptnutzung: die
-- Reihenfolge des Arrays ist eine Aussage, eine Wiederholung ist keine. Code =
-- Kundenwort in Kleinbuchstaben, ä→ae, ö→oe, ü→ue, ß→ss („Büro" → buero).
-- NULL = keine Angabe; ein leeres Array gibt es nicht (EINE Darstellung für
-- „nichts gewählt").
-- ⚠ coalesce(…, false) hier und in den PLZ-Regeln: ein CHECK nimmt NULL an, und
-- array_ndims('{}') bzw. `land = 'DE'` bei fehlendem Land SIND NULL.
CREATE OR REPLACE FUNCTION uems_nutzung_gueltig(nutzung TEXT[]) RETURNS BOOLEAN
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT nutzung IS NULL OR coalesce(
        cardinality(nutzung) >= 1
        AND array_ndims(nutzung) = 1
        AND nutzung <@ ARRAY['produktion', 'montage', 'lager', 'logistik', 'buero',
                             'technik', 'aussenflaeche', 'werkstatt', 'labor',
                             'verkauf', 'sozialraeume', 'sonstiges']::TEXT[]
        AND cardinality(nutzung) = (SELECT count(DISTINCT n) FROM unnest(nutzung) AS n),
        false)
$$;

-- -----------------------------------------------------------------------------
-- unternehmen — der rechtliche Rahmen des Kundenbereichs (AP-02 §4.1 U)
-- -----------------------------------------------------------------------------
-- Genau eines je Kundenbereich (UNIQUE tenant_id). Für Konzerne (1 : n) ist das
-- Modell vorbereitet: ein späteres Paket löst diesen Schlüssel bewusst.
-- Kein Zustand: ein Unternehmen ist immer aktiv, es endet nur mit dem
-- Offboarding des Kundenbereichs (§4.2).
CREATE TABLE IF NOT EXISTS unternehmen (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL,
    name         TEXT        NOT NULL,
    kurzname     TEXT,
    -- Die Vorgabe, die jeder neue Standort als Vorbelegung erbt (Regel 11).
    zeitzone     TEXT        NOT NULL DEFAULT 'Europe/Berlin',
    -- Der Sitz: nur Anzeige und Berichtskopf (AP-12).
    sitz_strasse TEXT,
    sitz_plz     TEXT,
    sitz_ort     TEXT,
    sitz_land    TEXT,
    rechtsform   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = automatisch angelegt (dieser Backfill), keine Person.
    created_by   TEXT,
    CONSTRAINT unternehmen_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT uq_unternehmen_je_kundenbereich UNIQUE (tenant_id),
    -- Das Ziel der zusammengesetzten Fremdschlüssel: ein Standort kann nur an
    -- einem Unternehmen SEINES Mandanten hängen (ein FK prüft ohne RLS).
    CONSTRAINT uq_unternehmen_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT unternehmen_name_chk
        CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> ''),
    CONSTRAINT unternehmen_kurzname_chk
        CHECK (kurzname IS NULL OR (char_length(kurzname) BETWEEN 1 AND 24
                                    AND btrim(kurzname) <> '')),
    CONSTRAINT unternehmen_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT unternehmen_sitz_land_chk
        CHECK (sitz_land IS NULL OR sitz_land IN ('DE', 'AT', 'CH')),
    -- PLZ-Format je Land (§4.1): DE fünf Ziffern, AT und CH vier. Eine PLZ
    -- ohne Land lässt sich nicht prüfen und wird deshalb abgelehnt.
    CONSTRAINT unternehmen_sitz_plz_chk
        CHECK (sitz_plz IS NULL OR coalesce(
                   (sitz_land = 'DE' AND sitz_plz ~ '^[0-9]{5}$')
                   OR (sitz_land IN ('AT', 'CH') AND sitz_plz ~ '^[0-9]{4}$'),
                   false)),
    CONSTRAINT unternehmen_rechtsform_chk
        CHECK (rechtsform IS NULL OR char_length(rechtsform) BETWEEN 1 AND 40)
);

-- -----------------------------------------------------------------------------
-- standort — ein räumlich abgegrenzter Ort des Unternehmens (AP-02 §4.1 ST)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standort (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL,
    unternehmen_id   UUID        NOT NULL,
    name             TEXT        NOT NULL,
    -- ST-1, ST-2 … automatisch vergeben (IP-4), änderbar, für immer eindeutig
    -- je Kundenbereich — auch ein archivierter Standort behält seines.
    kurzzeichen      TEXT        NOT NULL,
    -- Die Adresse darf bei automatisch angelegten Standorten fehlen (E10);
    -- dann ist der Standort ein Entwurf („es fehlt: Adresse").
    strasse          TEXT,
    plz              TEXT,
    ort              TEXT,
    land             TEXT,
    -- Pflicht, vorbelegt aus dem Unternehmen; Gebäude, Bereiche und Anlagen
    -- erben sie ohne eigenes Feld (Regel 11). Die Tages- und Monatsgrenzen der
    -- Auswertung bleiben bis AP-07/AP-08 fest Europe/Berlin (A16).
    zeitzone         TEXT        NOT NULL,
    nutzung          TEXT[],
    notiz            TEXT,
    -- Die Lage auf der Karte — derselbe Typ wie site.latitude/longitude, weil
    -- sie beim Zuordnen eine Anlage OHNE eigenen Pin vorbelegt (W4).
    lage_breitengrad NUMERIC(9, 6),
    lage_laengengrad NUMERIC(9, 6),
    zustand          TEXT        NOT NULL,
    archiviert_am    TIMESTAMPTZ,
    archiviert_von   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       TEXT,
    CONSTRAINT standort_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT standort_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT uq_standort_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT standort_name_chk
        CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> ''),
    CONSTRAINT standort_kurzzeichen_chk
        CHECK (char_length(kurzzeichen) BETWEEN 1 AND 24
               AND kurzzeichen = btrim(kurzzeichen)),
    CONSTRAINT standort_land_chk
        CHECK (land IS NULL OR land IN ('DE', 'AT', 'CH')),
    CONSTRAINT standort_plz_chk
        CHECK (plz IS NULL OR coalesce(
                   (land = 'DE' AND plz ~ '^[0-9]{5}$')
                   OR (land IN ('AT', 'CH') AND plz ~ '^[0-9]{4}$'),
                   false)),
    CONSTRAINT standort_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT standort_nutzung_chk CHECK (uems_nutzung_gueltig(nutzung)),
    CONSTRAINT standort_notiz_chk
        CHECK (notiz IS NULL OR char_length(notiz) BETWEEN 1 AND 500),
    CONSTRAINT standort_lage_chk
        CHECK ((lage_breitengrad IS NULL) = (lage_laengengrad IS NULL)
               AND (lage_breitengrad IS NULL OR lage_breitengrad BETWEEN -90 AND 90)
               AND (lage_laengengrad IS NULL OR lage_laengengrad BETWEEN -180 AND 180)),
    -- AP-00 E8 / AP-02 §4.2: kein „angehalten" am Objekt — angehalten wird die
    -- Funktion je Standort (AP-01), nicht der Ort.
    CONSTRAINT standort_zustand_chk
        CHECK (zustand IN ('entwurf', 'eingerichtet', 'aktiv', 'archiviert')),
    -- „archiviert" und der Archiv-Zeitpunkt sind EINE Tatsache, nie zwei.
    CONSTRAINT standort_archiv_chk
        CHECK ((zustand = 'archiviert') = (archiviert_am IS NOT NULL)
               AND (archiviert_von IS NULL OR archiviert_am IS NOT NULL))
);

-- Kurzzeichen: für immer eindeutig je Kundenbereich (E8), ohne Groß-/Klein-
-- schreibung — „st-1" und „ST-1" wären in einem Export dieselbe Zeile.
CREATE UNIQUE INDEX IF NOT EXISTS uq_standort_kurzzeichen
    ON standort (tenant_id, lower(kurzzeichen));
-- Name: eindeutig je Unternehmen unter den NICHT archivierten Standorten, ohne
-- Groß-/Kleinschreibung und Randleerzeichen (§4.1). Ein archivierter Standort
-- gibt seinen Namen frei und behält ihn selbst. tenant_id vorn aus demselben
-- Grund wie beim Überlappungsverbot unten: ein Index prüft vor dem Fremd-
-- schlüssel und ohne RLS und darf keinem fremden Mandanten einen Namen verraten.
CREATE UNIQUE INDEX IF NOT EXISTS uq_standort_name_nicht_archiviert
    ON standort (tenant_id, unternehmen_id, lower(btrim(name)))
    WHERE archiviert_am IS NULL;

-- -----------------------------------------------------------------------------
-- anlage_standort — die zeitgültige Zuordnung Anlage → Standort (§4.3)
-- -----------------------------------------------------------------------------
-- „gültig ab" ist ein TAG (00:00 in der Zeitzone des Standorts, E9); `gueltig_bis`
-- ist der LETZTE gültige Tag, einschließlich — NULL = offen. Ein neues „gültig
-- ab" beendet das laufende Intervall am VORTAG; eine Korrektur hebt ein
-- Intervall auf (`aufgehoben_am`) und lässt es lesbar. Eine Zeile wird nie
-- gelöscht und nie umgeschrieben: die App-Rolle darf nur `gueltig_bis` und
-- `aufgehoben_am` ändern (Rechte unten).
CREATE TABLE IF NOT EXISTS anlage_standort (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL,
    site_id       UUID        NOT NULL,
    standort_id   UUID        NOT NULL,
    gueltig_ab    DATE        NOT NULL,
    gueltig_bis   DATE,
    aufgehoben_am TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT,
    CONSTRAINT anlage_standort_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Zusammengesetzt über uq_site_id_tenant_identity (V20260844000000): die
    -- Anlage gehört demselben Mandanten wie die Zuordnung.
    CONSTRAINT anlage_standort_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT anlage_standort_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    -- Vektor-Fall `bis-vor-ab`; ab = bis ist erlaubt (`ein-tag-ist-ein-intervall`).
    CONSTRAINT anlage_standort_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Regel 2: je Anlage genau EIN Standort je Tag. '[]', weil `bis` der
    -- letzte Tag IST (Vektor-Fall `bis-ist-der-letzte-tag-darum-ueberlappt-das`);
    -- ein aufgehobenes Intervall belegt keinen Tag mehr (`aufgehobene-zaehlen-nicht`).
    -- tenant_id im Schlüssel: der Constraint prüft VOR dem Fremdschlüssel und
    -- ohne RLS — ohne sie nennte die Ablehnung einem fremden Mandanten die
    -- Intervalle einer Anlage, die er gar nicht sehen darf. Für gültige Zeilen
    -- ändert das nichts: die Anlage legt den Mandanten fest (anlage_standort_site_fk).
    CONSTRAINT anlage_standort_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        site_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_anlage_standort_standort
    ON anlage_standort (standort_id, gueltig_ab);

-- -----------------------------------------------------------------------------
-- ort_aenderung — das Änderungsprotokoll der Ortsstruktur (§4.4, Regel 14)
-- -----------------------------------------------------------------------------
-- Jede Änderung schreibt genau EINEN Eintrag: Objekt, was, alt → neu, gilt ab,
-- rückwirkend, wer, wann. Einträge werden nie geändert oder gelöscht (Trigger
-- unten). `objekt_id` zeigt je nach `objekt_art` auf unternehmen, standort,
-- ort (IP-2b) oder site — bewusst ohne Fremdschlüssel (Kopf).
--
-- `art` (abgeleitet aus §4.2/§4.4; die Vorgänge des Vertrags heißen
-- verschieben → verschoben, korrektur → korrigiert):
--   angelegt · bearbeitet (einfache Felder, alt/neu tragen NUR die geänderten)
--   · verschoben (auch „Anlage zugeordnet") · korrigiert (das ersetzte
--   Intervall ist aufgehoben) · flaeche_geaendert · archiviert ·
--   wiederhergestellt · geloescht (Löschen ohne Historie, E1).
-- Ein späteres Paket, das eine Art braucht, weitet den CHECK, indem es DIESEN
-- Stand abschreibt.
--
-- `rueckwirkend`: „gilt ab" liegt vor dem Eintragstag in der Zeitzone des
-- Standorts (E2) — der Schreiber rechnet es mit OrtsbaumAbleitung.
-- `akteur_sub` NULL = VoltPilot selbst; `akteur_name` sagt es immer
-- („VoltPilot (Bestandsübernahme)" für automatische Einträge).
CREATE TABLE IF NOT EXISTS ort_aenderung (
    id           BIGSERIAL   PRIMARY KEY,
    tenant_id    UUID        NOT NULL,
    objekt_art   TEXT        NOT NULL,
    objekt_id    UUID        NOT NULL,
    art          TEXT        NOT NULL,
    alt          JSONB,
    neu          JSONB,
    gilt_ab      DATE        NOT NULL,
    rueckwirkend BOOLEAN     NOT NULL,
    akteur_sub   TEXT,
    akteur_name  TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ort_aenderung_objekt_art_chk
        CHECK (objekt_art IN ('unternehmen', 'standort', 'gebaeude', 'bereich', 'anlage')),
    CONSTRAINT ort_aenderung_art_chk
        CHECK (art IN ('angelegt', 'bearbeitet', 'verschoben', 'korrigiert',
                       'flaeche_geaendert', 'archiviert', 'wiederhergestellt',
                       'geloescht')),
    CONSTRAINT ort_aenderung_akteur_chk
        CHECK (btrim(akteur_name) <> '' AND (akteur_sub IS NULL OR akteur_sub <> ''))
);

CREATE INDEX IF NOT EXISTS idx_ort_aenderung_objekt
    ON ort_aenderung (objekt_art, objekt_id, created_at DESC);
-- „Änderungen, die den Zeitraum betreffen" (§4.4): nach „gilt ab".
CREATE INDEX IF NOT EXISTS idx_ort_aenderung_gilt_ab
    ON ort_aenderung (tenant_id, gilt_ab);

-- Append-only an der Datenbankgrenze, nicht nur per Konvention — dieselbe
-- Funktion wie component_change_event (V20260843000000).
DROP TRIGGER IF EXISTS ort_aenderung_append_only ON ort_aenderung;
CREATE TRIGGER ort_aenderung_append_only BEFORE UPDATE OR DELETE ON ort_aenderung
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel; A14: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE unternehmen ENABLE ROW LEVEL SECURITY;
ALTER TABLE unternehmen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unternehmen_tenant_isolation ON unternehmen;
CREATE POLICY unternehmen_tenant_isolation ON unternehmen
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE standort ENABLE ROW LEVEL SECURITY;
ALTER TABLE standort FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS standort_tenant_isolation ON standort;
CREATE POLICY standort_tenant_isolation ON standort
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE anlage_standort ENABLE ROW LEVEL SECURITY;
ALTER TABLE anlage_standort FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anlage_standort_tenant_isolation ON anlage_standort;
CREATE POLICY anlage_standort_tenant_isolation ON anlage_standort
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ort_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE ort_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ort_aenderung_tenant_isolation ON ort_aenderung;
CREATE POLICY ort_aenderung_tenant_isolation ON ort_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben darf.
-- Die BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie).
--
-- Das Unternehmen legt der Kunde nicht an und löscht es nicht (§4.1).
GRANT SELECT, UPDATE ON unternehmen TO ${appDbUser};
REVOKE INSERT, DELETE ON unternehmen FROM ${appDbUser};
-- Ein Standort wird archiviert, nie gelöscht.
GRANT SELECT, INSERT, UPDATE ON standort TO ${appDbUser};
REVOKE DELETE ON standort FROM ${appDbUser};
-- Ein Intervall wird beendet oder aufgehoben — nie gelöscht, nie umgeschrieben.
-- (Das REVOKE auf Tabellenebene nimmt auch Spaltenrechte mit; das GRANT danach
-- setzt genau die zwei wieder — ein erneuter Lauf landet im selben Zustand.)
GRANT SELECT, INSERT ON anlage_standort TO ${appDbUser};
REVOKE UPDATE, DELETE ON anlage_standort FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON anlage_standort TO ${appDbUser};
-- Das Protokoll: lesen und anhängen.
GRANT SELECT, INSERT ON ort_aenderung TO ${appDbUser};
REVOKE UPDATE, DELETE ON ort_aenderung FROM ${appDbUser};
-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Grant (die rollout_event-Falle):
-- ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen nicht — für beide Rollen,
-- weil auch ein Admin-Weg (die Bestandsübernahme, IP-9) protokolliert.
GRANT USAGE, SELECT ON SEQUENCE ort_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE ort_aenderung_id_seq TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- Backfill: je Mandant genau ein Unternehmen (idempotent)
-- -----------------------------------------------------------------------------
-- Name = Name des Kundenbereichs, auf die Namensregel gebracht (Randleerzeichen
-- weg, höchstens 120 Zeichen). Ein leerer Kundenbereichs-Name ist über die API
-- unmöglich (@NotBlank); stünde doch einer in der Tabelle, bekäme er das
-- Kundenwort „Unternehmen" statt die Migration scheitern zu lassen — der Kunde
-- benennt es im Portal um (IP-4). ON CONFLICT: ein erneuter Lauf legt kein
-- zweites an und überschreibt keinen inzwischen geänderten Namen.
INSERT INTO unternehmen (tenant_id, name, zeitzone)
SELECT t.id,
       COALESCE(NULLIF(btrim(left(btrim(t.name), 120)), ''), 'Unternehmen'),
       'Europe/Berlin'
FROM tenant t
ON CONFLICT (tenant_id) DO NOTHING;

-- Und sein Protokolleintrag — genau einer je Unternehmen, auch nach einem
-- erneuten Lauf. „gilt ab" ist der Tag des Anlegens in der Zeitzone des
-- Unternehmens; nichts daran ist rückwirkend.
INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, neu,
                           gilt_ab, rueckwirkend, akteur_sub, akteur_name)
SELECT u.tenant_id, 'unternehmen', u.id, 'angelegt', NULL,
       jsonb_build_object('name', u.name, 'zeitzone', u.zeitzone),
       (u.created_at AT TIME ZONE u.zeitzone)::date, false, NULL,
       'VoltPilot (Bestandsübernahme)'
FROM unternehmen u
WHERE NOT EXISTS (
    SELECT 1 FROM ort_aenderung a
    WHERE a.objekt_art = 'unternehmen' AND a.objekt_id = u.id AND a.art = 'angelegt');
