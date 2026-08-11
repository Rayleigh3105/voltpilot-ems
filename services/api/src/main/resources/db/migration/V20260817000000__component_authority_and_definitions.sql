-- =============================================================================
-- V20260817000000 - Einheitsmodell Stufe 1: „Ein Anlege-Weg im Portal".
-- ADDITIV: zwei nullbare/vorbelegte Spalten + eine neue Tabelle. Keine
-- bestehende Anlage aendert dadurch ihr Verhalten - siehe die Datenmigration
-- unten, die genau das sicherstellt.
-- -----------------------------------------------------------------------------
-- WOFÜR (Scout data/vp-komponenten-einheit-h2, Teil 4 + Teil 7, Stufe 1):
--
-- Ab dieser Stufe legt der Kunde seine Geraete im PORTAL an - inklusive des
-- Wechselrichters - und die Box LEITET ihre lokalen Dateien
-- (Wechselrichter-Auswahl, sources.json) aus dem Registry-Push ab, statt sie auf
-- :8484 entstehen zu lassen. Drei Dinge fehlen dafuer im Schema:
--
--   1. WER besitzt die Geraete-Konfiguration einer Anlage (§7.2 Punkt 4).
--   2. WELCHE Fassung einer Komponenten-Definition gilt gerade.
--   3. Die VORHERIGEN Fassungen, damit „Zurueck zur letzten Fassung" ein Klick
--      ist und nicht ein Support-Fall (§4.2 Punkt 4, Risiko 2).
--
-- ⚠ DIE EINE ZEILE, AN DER DIE BETRIEBSSICHERHEIT HAENGT: die Spalte
-- site.component_authority hat den DEFAULT 'portal', aber die Datenmigration
-- setzt JEDE HEUTE EXISTIERENDE Anlage auf 'box'. Damit gilt genau die
-- Captain-Vorgabe „NEUE Anlagen sind portal-verwaltet; Bestandsanlagen bleiben
-- in dieser Stufe unangetastet box-verwaltet" - ohne eine Liste, die jemand
-- pflegen muesste, und ohne dass ein Deploy irgendeiner laufenden Anlage die
-- Autoritaet entzieht. Die Uebernahme des Bestands ist Stufe 2.
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260815000000) - eine kleinere Version waere fuer Flyway „out of order"
-- und wuerde auf einer langlebigen DB nie angewandt.
-- =============================================================================

-- --- 1. Der Autoritaets-Zustand JE ANLAGE (nie je Geraet, §7.2 Punkt 4) ------
--
-- 'box'    - die Box ist die Wahrheit; :8484 bearbeitet weiter, der Push aendert
--            an ihrer Geraete-Konfiguration NICHTS.
-- 'portal' - das Portal ist das Soll; die Box wendet an und meldet die
--            angewandte Revision zurueck.
--
-- Es gibt bewusst KEINEN dritten Wert und keinen NULL-Zustand: „nie gemischt"
-- ist die Regel, und ein unbestimmter Zustand waere genau die Grauzone, aus der
-- zwei Schreiber entstehen.
ALTER TABLE site
    ADD COLUMN IF NOT EXISTS component_authority TEXT NOT NULL DEFAULT 'portal';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_component_authority_chk') THEN
        ALTER TABLE site ADD CONSTRAINT site_component_authority_chk
            CHECK (component_authority IN ('box', 'portal'));
    END IF;
END $$;

-- Die Datenmigration, die den Bestand schuetzt (siehe Kopf). Sie laeuft EINMAL
-- und trifft ausschliesslich Zeilen, die es beim Deploy schon gab: eine Anlage,
-- die nach dieser Migration entsteht, bekommt den Spalten-DEFAULT 'portal'.
UPDATE site SET component_authority = 'box' WHERE component_authority = 'portal';

-- --- 2. Die geltende Fassung einer Komponenten-Definition --------------------
--
-- Zaehlt ab 1 und steigt bei JEDER Aenderung der Anbindung. Sie ist zugleich
-- das, was die Oberflaeche als „Fassung 3" zeigt - dieselbe Zahl, die in
-- component_definition steht, damit es nur EINE Zaehlung gibt.
ALTER TABLE measurement_point
    ADD COLUMN IF NOT EXISTS definition_version INTEGER NOT NULL DEFAULT 1;

-- --- 3. Die Fassungs-Historie ------------------------------------------------
--
-- Append-only: eine Zeile je gespeicherter Fassung. Der Rollback SCHREIBT eine
-- neue Fassung mit dem alten Inhalt, er loescht nie eine - „was lief letzte
-- Woche" muss auch nach dem Zurueckdrehen beantwortbar bleiben (das
-- Flow-Versions-Muster).
--
-- Mandanten-eigene Daten -> RLS + FORCE wie measurement_point/flow_definition.
CREATE TABLE IF NOT EXISTS component_definition (
    entity_id        UUID NOT NULL REFERENCES measurement_point(id) ON DELETE CASCADE,
    version          INTEGER NOT NULL CHECK (version >= 1),

    tenant_id        UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id          UUID NOT NULL REFERENCES site(id) ON DELETE CASCADE,

    -- Die Anbindung, wie sie in dieser Fassung galt. connection_json ist die
    -- Transport-Wahrheit (IP/Port/Serial/Unit-ID ...), gespeichert als jsonb -
    -- anders als bei einem SIGNIERTEN Dokument (edge_release.manifest) gibt es
    -- hier nichts, dessen Bytes eine Signatur tragen, und die Normalisierung
    -- von jsonb ist genau das, was einen Vergleich zweier Fassungen sauber
    -- macht.
    role             TEXT,
    label            TEXT,
    brand            TEXT,
    model            TEXT,
    family           TEXT,
    communication    TEXT,
    connection_json  JSONB,

    -- Woher die Definition stammt (das source_kind-Vokabular aus Stufe 0a) und
    -- welche Vorlage in welcher Fassung sie erzeugt hat. Ein SCHNAPPSCHUSS, kein
    -- Fremdschluessel: eine zurueckgezogene Vorlage darf die Historie einer
    -- Komponente weder loeschen noch ihr Loeschen blockieren (dieselbe Regel wie
    -- rollout_device.device_ref).
    source_kind      TEXT,
    template_ref     TEXT,
    template_version INTEGER,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Das JWT-Subject des Speichernden - die Papier-Spur, warum eine Anlage
    -- ploetzlich anders liest.
    created_by       TEXT,
    -- Ein kurzer deutscher Satz, was diese Fassung war ("Erstanlage",
    -- "Verbindung geaendert", "Zurueck auf Fassung 2").
    note             TEXT,

    PRIMARY KEY (entity_id, version)
);

CREATE INDEX IF NOT EXISTS idx_component_definition_site
    ON component_definition (site_id, entity_id, version DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON component_definition TO ${appDbUser};

ALTER TABLE component_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS component_definition_isolation ON component_definition;
CREATE POLICY component_definition_isolation ON component_definition
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- --- 4. Das IST des Appliers, wie die Box es meldet -------------------------
--
-- Eine Zeile je Gerät, bei jedem Herzschlag ERSETZT (das
-- device_control_status/device_edge_version-Muster). Sie beantwortet die eine
-- Frage, die das Portal sonst nicht ehrlich beantworten kann: „läuft mein
-- gespeichertes Soll wirklich auf der Box?".
--
-- ⚠ applied_revision und refused_revision sind ABSICHTLICH zwei Spalten. Was
-- läuft, ist die zuletzt ANGEWANDTE Fassung - auch dann, wenn danach eine
-- neuere abgelehnt wurde. Sie in eine Spalte zu falten hieße, sich zwischen
-- „eine abgelehnte Fassung als live behaupten" und „den Grund verlieren"
-- entscheiden zu müssen; beides ist falsch.
--
-- Mandanten-eigene Betriebsdaten -> RLS + FORCE wie device_control_status.
CREATE TABLE IF NOT EXISTS device_component_apply (
    device_id        UUID        PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
    tenant_id        UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id          UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,

    -- Was die BOX über sich sagt: 'portal' = sie leitet ihre lokalen Dateien
    -- aus dem Push ab. Eine Box, die den Block gar nicht sendet, bekommt keine
    -- Zeile - „unbekannt", nie „box" behauptet.
    authority        TEXT        NOT NULL,

    applied_revision TEXT,
    applied_at       TIMESTAMPTZ,
    refused_revision TEXT,
    refused_reason   TEXT,

    reported_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_component_apply TO ${appDbUser};

ALTER TABLE device_component_apply ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_component_apply FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_component_apply_isolation ON device_component_apply;
CREATE POLICY device_component_apply_isolation ON device_component_apply
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
