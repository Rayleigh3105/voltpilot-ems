-- UEMS AP-06 IP-2: die Datenquelle als Objekt, ihre zeitgültige Zuständigkeit je
-- Box und die führende Box an der Anlage.
--
-- Die Regeln sind VERTRAG: docs/contracts/v2/data-source-assignment.md (AP-06
-- IP-1) mit den Zwillingen DatenquelleRegeln.java / uemsDatenquelle.ts und den
-- Fällen in data-source-vectors.json. Diese Migration sagt dasselbe als
-- Constraint; UemsDatenquelleMigrationTest spielt die Familie `zeitraeume` und
-- die Fälle der Familie `antrag`, deren Grund die Datenbank trägt, gegen sie.
--
-- ⚠ ZEITPUNKTE, NICHT TAGE. Anders als anlage_standort (V20260911100000:
-- daterange … '[]', `gueltig_bis` = letzter Tag EINSCHLIESSLICH) ist eine
-- Zuständigkeit HALBOFFEN auf die Minute: tstzrange(effective_from,
-- effective_to, '[)') — `effective_to` gehört nicht mehr dazu, NULL = offen.
-- Ende alt = Beginn neu berührt sich, ohne sich zu überschneiden (Vertrag §4).
--
-- ⚠ REIN ADDITIV. `site` bekommt `lead_device_id`, `measurement_point` bekommt
-- `data_source_id` — beide nullable, je mit ihrem Fremdschlüssel und sonst
-- NICHTS (kein Index, keine Policy, kein Backfill). Bestehende Zeilen behalten
-- NULL: Quellen und Zuständigkeiten der Bestandskunden schreibt erst die
-- Vorschlagsliste (IP-4), die führende Box erst IP-5. `gatewayDevice`,
-- Registry-Push, Mess-Plan und Herzschlag lesen keine der neuen Spalten.
--
-- LÖSCHEN (Plan-Regel „nichts mit Historie wird gelöscht"):
--   * data_source → tenant/site: ON DELETE RESTRICT, nie Kaskade. Eine Quelle
--     wird archiviert (`archiviert_am`), nie gelöscht; das Offboarding räumt
--     die drei neuen Tabellen AUSDRÜCKLICH ab (TenantRepository.offboard). Eine
--     Anlage, an der eine Quelle hängt, lässt sich nicht löschen — dieselbe
--     Folge wie bei anlage_standort; heute gibt es keine Quelle.
--   * measurement_point.data_source_id → data_source: ON DELETE RESTRICT.
--   * site.lead_device_id → device: ON DELETE SET NULL, und NUR diese Spalte
--     (PG 15+: `SET NULL (spalte)`, sonst träfe es auch tenant_id). Das heutige
--     Unclaim LÖSCHT die Gerätezeile (AP-04 W3; erst AP-07 E8 ersetzt das durch
--     „ausgebaut"). Es muss weiter funktionieren, und eine Anlage ohne
--     gespeicherte führende Box ist ein benannter Zustand des Vertrags (§8:
--     Speicher-Box → einzige Box → keine Wahl), kein Fehler.
--   * data_source_assignment.device_id: BEWUSST OHNE Fremdschlüssel. Eine
--     Zuständigkeit ist Historie — sie sagt, welche Box einen Wert gelesen hat
--     (Vertrag §3 Nr. 4, die Herkunft je Wert). RESTRICT bräche das heutige
--     Unclaim, sobald eine Box eine Zuständigkeit trägt; CASCADE löschte mit
--     der Box die Aussage, wer gelesen hat; SET NULL tilgte genau diese Aussage
--     still und schüfe einen Zeitraum ohne Box, den der Vertrag nicht kennt.
--     Deshalb prüft ein Trigger beim EINTRAGEN, dass die Box existiert und
--     demselben Mandanten gehört (die App-Rolle sieht unter RLS nur ihre
--     eigenen Boxen); danach überlebt der Zeitraum seine Box, wie
--     ort_aenderung/component_change_event ihr Objekt. Ersetzt AP-07 das
--     Löschen durch „ausgebaut", bekommt die Spalte ihren echten
--     Fremdschlüssel ON DELETE RESTRICT. Einen noch OFFENEN Zeitraum einer
--     entfernten Box beendet der Schreibweg; das Entfernen einer noch
--     zuständigen Box lehnt erst IP-19 ab (Vertrag §12).

-- Die Ausschluss-Bedingungen brauchen `=` auf uuid/text in einem GiST-Index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Die Geräte hinter einer Quelle (Vertrag §2 `geraete_ids`)
-- -----------------------------------------------------------------------------
-- Geräte-IDs (Unit-ID, Steckplatz …) aufsteigend und ohne Wiederholung — EINE
-- Darstellung derselben Menge; leer ist erlaubt (eine OCPP-Station verbindet
-- sich selbst; ein Entwurf hat noch keine Geräte). Eine eigene Funktion, weil
-- ein CHECK keine Unterabfrage enthalten darf.
-- ⚠ coalesce(…, false): ein CHECK nimmt NULL an, und ein Vergleich mit einem
-- NULL-Element ist NULL.
CREATE OR REPLACE FUNCTION uems_geraete_ids_gueltig(ids INTEGER[]) RETURNS BOOLEAN
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT ids IS NOT NULL AND coalesce(
        cardinality(ids) = 0
        OR (array_ndims(ids) = 1
            AND array_position(ids, NULL) IS NULL
            AND ids = ARRAY(SELECT DISTINCT i FROM unnest(ids) AS i ORDER BY i)
            AND (SELECT min(i) FROM unnest(ids) AS i) >= 0),
        false)
$$;

-- -----------------------------------------------------------------------------
-- data_source — der Erfassungsweg, den eine Box erreicht (Vertrag §2, E1)
-- -----------------------------------------------------------------------------
-- Die Identität ist das Kennzeichen, nie Adresse, Port oder Geräte-ID (§3 Nr. 1).
-- Lebenszyklus, Beobachtung und Rückmeldung sind KEINE Spalten: „eingerichtet"
-- folgt aus der Prüfung (IP-3), „angehalten" aus einer Lücke der Zuständigkeit,
-- „liefert Daten" aus dem Herzschlag (IP-14). Gespeichert ist nur, was der
-- Kunde tut: archivieren.
CREATE TABLE IF NOT EXISTS data_source (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL,
    -- Die Anlage, in der die Geräte verdrahtet sind — sie darf von der Heimat
    -- der lesenden Box abweichen (§1, AP-06 §4.4 Nr. 2).
    site_id        UUID        NOT NULL,
    -- DQ-1, DQ-2 … automatisch je Kundenbereich (uems_datenquelle_kennzeichen);
    -- änderbar nach der Form der Messstellen (AP-06 §4.2 → AP-04 E7).
    kennzeichen    TEXT        NOT NULL,
    -- Das Kundenwort („WAGO-Steuerung Halle 2"). NULL = noch keins: eine Quelle
    -- aus der Vorschlagsliste (IP-4) trägt zunächst nur ihr Kennzeichen.
    name           TEXT,
    protokoll      TEXT        NOT NULL,
    -- Host:Port · Themenfilter · URL · Stations-Kennung — so, wie der Endpunkt
    -- sie normalisiert hat (§3 Nr. 5); ein Parameter, nie die Identität.
    adresse        TEXT        NOT NULL,
    geraete_ids    INTEGER[]   NOT NULL DEFAULT '{}',
    -- Die dokumentierte Netzlage (Bogen D1/D2); NULL = noch nicht eingetragen.
    netz           TEXT,
    -- Verträgt das Gerät einen zweiten Leser? Vorgabe NEIN (§2, §6).
    mehrere_leser  BOOLEAN     NOT NULL DEFAULT false,
    steuerquelle   BOOLEAN     NOT NULL DEFAULT false,
    -- Der Lesetakt (AP-06 §4.2), die Kadenz des Zustandsvertrags: höchstens ein
    -- Tag, weil die Toleranz „liefert Daten" dort endet (uems-zustand-vectors).
    kadenz_s       INTEGER     NOT NULL,
    archiviert_am  TIMESTAMPTZ,
    archiviert_von TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT,
    CONSTRAINT data_source_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Zusammengesetzt über uq_site_id_tenant_identity (V20260844000000): die
    -- Anlage gehört demselben Mandanten wie die Quelle.
    CONSTRAINT data_source_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE RESTRICT,
    -- Die Ziele der zusammengesetzten Fremdschlüssel von measurement_point und
    -- data_source_assignment.
    CONSTRAINT uq_data_source_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT uq_data_source_weg UNIQUE (id, tenant_id, protokoll, adresse),
    CONSTRAINT data_source_kennzeichen_chk
        CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT data_source_name_chk
        CHECK (name IS NULL OR (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> '')),
    -- Geschlossen (§2); ein neues Protokoll kommt nur über den Katalog — ein
    -- späteres Paket weitet den CHECK, indem es DIESEN Stand abschreibt.
    CONSTRAINT data_source_protokoll_chk
        CHECK (protokoll IN ('modbus_tcp', 'sunspec_modbus', 'mqtt', 'http', 'ocpp')),
    -- Ohne Randleerzeichen: sonst wären „ 192.168.10.31:502" und
    -- „192.168.10.31:502" zwei Wege an derselben Box.
    CONSTRAINT data_source_adresse_chk CHECK (adresse <> '' AND adresse = btrim(adresse)),
    CONSTRAINT data_source_geraete_ids_chk CHECK (uems_geraete_ids_gueltig(geraete_ids)),
    CONSTRAINT data_source_netz_chk CHECK (netz IS NULL OR btrim(netz) <> ''),
    CONSTRAINT data_source_kadenz_chk CHECK (kadenz_s BETWEEN 1 AND 86400),
    CONSTRAINT data_source_archiv_chk
        CHECK (archiviert_von IS NULL OR archiviert_am IS NOT NULL)
);

-- Kennzeichen: eindeutig je Kundenbereich, archivierte eingeschlossen. Die Form
-- erlaubt nur Großbuchstaben — „dq-1" ist ein Formfehler, kein zweites DQ-1.
-- tenant_id vorn: ein Index prüft ohne RLS und darf keinem fremden Mandanten
-- verraten, welche Kennzeichen es bei einem anderen gibt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_data_source_kennzeichen
    ON data_source (tenant_id, kennzeichen);
CREATE INDEX IF NOT EXISTS idx_data_source_site ON data_source (site_id);

-- -----------------------------------------------------------------------------
-- Der Kennzeichen-Zähler je Kundenbereich — eine Tabelle, nie ein BIGSERIAL
-- -----------------------------------------------------------------------------
-- Eine Sequenz zählte über alle Mandanten und verlöre Nummern bei jedem
-- Rollback. Hier gilt: `naechste_nummer` ist die nächste Nummer, die der
-- Kundenbereich vergibt (fehlt die Zeile: 1) — derselbe Begriff wie
-- `naechste_nummer` der Vorschlagsliste in data-source-vectors.json. Der Zähler
-- rückt nur mit einem gespeicherten Kennzeichen vor (dieselbe Transaktion) und
-- nie zurück: eine übersprungene Nummer wird nie wieder vergeben.
CREATE TABLE IF NOT EXISTS data_source_kennzeichen_seq (
    tenant_id       UUID    PRIMARY KEY,
    naechste_nummer INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT data_source_kennzeichen_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT data_source_kennzeichen_seq_nummer_chk CHECK (naechste_nummer >= 1)
);

-- Das nächste freie Kennzeichen DQ-n des Kundenbereichs — und der Zähler rückt
-- dahinter. Die Zeile des Mandanten wird gesperrt (oder angelegt): parallele
-- Vergaben warten aufeinander, statt dieselbe Nummer zu ziehen. Eine Nummer,
-- deren Kennzeichen schon eine Quelle trägt (von Hand vergeben), wird
-- übersprungen. Läuft als Aufrufer: unter RLS kann die App-Rolle nur für ihren
-- eigenen Mandanten vergeben (die Policy des Zählers lehnt einen fremden ab).
CREATE OR REPLACE FUNCTION uems_datenquelle_kennzeichen(p_tenant UUID) RETURNS TEXT
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    n INTEGER;
BEGIN
    INSERT INTO data_source_kennzeichen_seq AS z (tenant_id, naechste_nummer)
    VALUES (p_tenant, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET naechste_nummer = z.naechste_nummer
    RETURNING z.naechste_nummer INTO n;
    WHILE EXISTS (SELECT 1 FROM data_source d
                  WHERE d.tenant_id = p_tenant AND d.kennzeichen = 'DQ-' || n) LOOP
        n := n + 1;
    END LOOP;
    UPDATE data_source_kennzeichen_seq SET naechste_nummer = n + 1 WHERE tenant_id = p_tenant;
    RETURN 'DQ-' || n;
END
$$;

-- -----------------------------------------------------------------------------
-- data_source_assignment — welche Box die Quelle wann liest (Vertrag §4, E2)
-- -----------------------------------------------------------------------------
-- Halboffen auf die Minute, je Quelle und Zeitpunkt höchstens EINE Box, Lücken
-- erlaubt („angehalten"). Ein Wechsel beendet den laufenden Zeitraum
-- (`effective_to = t`) und beginnt einen neuen ab `t` — die Datenbank beendet
-- nichts von selbst, sie lehnt nur ab, was sich überschneidet. Eine Zeile wird
-- nie gelöscht und nie umgeschrieben: die App-Rolle darf nur `effective_to`
-- ändern (Rechte unten). „Nie rückwirkend" (§4) und die übrigen Gründe des
-- Antrags (§5) prüft der Schreibweg mit DatenquelleRegeln (IP-3) — ein
-- Zeitpunkt „jetzt" gehört in keinen Constraint. Die Vorschlagsliste der
-- Bestands-Übernahme (IP-4) ist der eine Weg, der ab Reihenbeginn einträgt.
--
-- Eindeutigkeit je Box (§3 Nr. 2): an einer Box liest zu jedem Zeitpunkt nur
-- EINE Quelle je Protokoll + Adresse. Protokoll und Adresse stehen an der
-- Quelle, die Box am Zeitraum — ein Exklusions-Constraint sieht aber nur EINE
-- Zeile. Deshalb trägt jeder Zeitraum eine Kopie von Protokoll und Adresse, die
-- der zusammengesetzte Fremdschlüssel gleich hält (ON UPDATE CASCADE): wer die
-- Adresse einer Quelle ändert, ändert sie in allen ihren Zeiträumen, und die
-- Datenbank prüft die Eindeutigkeit dabei neu. Weil der Vertrag die Adresse
-- ohne Zeit an der Quelle führt (§3 Nr. 5), gilt eine geänderte Adresse für
-- die ganze Geschichte der Quelle.
CREATE TABLE IF NOT EXISTS data_source_assignment (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL,
    data_source_id UUID        NOT NULL,
    -- Die lesende Box — ohne Fremdschlüssel, siehe Kopf; der Trigger
    -- data_source_assignment_box_pruefen prüft sie beim Eintragen.
    device_id      UUID        NOT NULL,
    protokoll      TEXT        NOT NULL,
    adresse        TEXT        NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT,
    CONSTRAINT data_source_assignment_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT data_source_assignment_quelle_fk
        FOREIGN KEY (data_source_id, tenant_id, protokoll, adresse)
        REFERENCES data_source (id, tenant_id, protokoll, adresse)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    -- Grund `keine_volle_minute`: abgelehnt, nie gerundet. In UTC gerechnet —
    -- date_trunc auf timestamptz hinge an der Zeitzone der Sitzung.
    CONSTRAINT data_source_assignment_volle_minute
        CHECK (date_trunc('minute', effective_from AT TIME ZONE 'UTC')
                   = effective_from AT TIME ZONE 'UTC'
               AND (effective_to IS NULL
                    OR date_trunc('minute', effective_to AT TIME ZONE 'UTC')
                           = effective_to AT TIME ZONE 'UTC')),
    -- Grund `leerer_zeitraum`: ein Zeitraum dauert mindestens eine Minute.
    CONSTRAINT data_source_assignment_nicht_leer
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    -- Grund `ueberschneidung`: je Quelle und Zeitpunkt höchstens eine Box — auch
    -- nicht um eine Minute (Vektor-Fall zeitraeume-ueberschneidung-um-eine-
    -- minute-abgelehnt). tenant_id vorn: der Constraint prüft VOR dem Fremd-
    -- schlüssel und ohne RLS und darf einem fremden Mandanten keine Zeiträume
    -- verraten (dieselbe Lehre wie anlage_standort_keine_ueberlappung).
    CONSTRAINT data_source_assignment_eine_box_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        data_source_id WITH =,
        tstzrange(effective_from, effective_to, '[)') WITH &&
    ),
    -- Grund `adresse_an_box_vergeben`: an einer Box je Zeitpunkt nur EINE Quelle
    -- je Protokoll + Adresse. Dieselbe Adresse an einer ANDEREN Box ist erlaubt
    -- (A4); ob das ein Doppel-Lesen ist (§6), entscheidet der Schreibweg.
    CONSTRAINT data_source_assignment_ein_weg_je_box EXCLUDE USING gist (
        tenant_id WITH =,
        device_id WITH =,
        protokoll WITH =,
        adresse WITH =,
        tstzrange(effective_from, effective_to, '[)') WITH &&
    )
);

-- „Welche Quellen liest Box X?" — der Push je Box (IP-6) und das Entfernen einer
-- Box (IP-19) fragen so.
CREATE INDEX IF NOT EXISTS idx_data_source_assignment_box
    ON data_source_assignment (device_id, effective_from);

-- Die Box muss es geben, und sie gehört demselben Mandanten. Unter RLS sieht die
-- App-Rolle nur ihre eigenen Boxen — eine fremde ist hier „nicht vorhanden",
-- ohne dass die Ablehnung etwas über sie verrät. Gemeldet wie ein
-- Fremdschlüssel (23503), damit der Schreibweg nur EINE Art Ablehnung kennt.
-- ⚠ Nur, wenn sich Box oder Mandant WIRKLICH ändern: die Kaskade einer neuen
-- Adresse (ON UPDATE CASCADE oben) setzt tenant_id mit — fragte der Trigger
-- dann nach der Box, ließe sich die Adresse einer Quelle nicht mehr ändern,
-- sobald eine Box ihrer Geschichte entfernt ist.
CREATE OR REPLACE FUNCTION uems_zustaendigkeit_box_pruefen() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.device_id = OLD.device_id
            AND NEW.tenant_id = OLD.tenant_id THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM device d
                   WHERE d.id = NEW.device_id AND d.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'Box % gibt es in diesem Kundenbereich nicht', NEW.device_id
            USING ERRCODE = 'foreign_key_violation',
                  CONSTRAINT = 'data_source_assignment_box_fk',
                  TABLE = 'data_source_assignment';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS data_source_assignment_box_pruefen ON data_source_assignment;
CREATE TRIGGER data_source_assignment_box_pruefen
    BEFORE INSERT OR UPDATE OF device_id, tenant_id ON data_source_assignment
    FOR EACH ROW EXECUTE FUNCTION uems_zustaendigkeit_box_pruefen();

-- -----------------------------------------------------------------------------
-- Die zwei Verweise an bestehenden Tabellen — je EINE nullable Spalte
-- -----------------------------------------------------------------------------
-- Die führende Box der Anlage (Vertrag §8, E3): gespeichert = die ausdrückliche
-- Wahl; NULL = keine gespeicherte Wahl, dann gilt Speicher-Box → einzige Box →
-- keine (IP-5). Zusammengesetzt über uq_device_id_tenant_identity: nie eine
-- Box eines anderen Mandanten. Dass sie in DIESER Anlage angemeldet ist, prüft
-- IP-5 — ein Fremdschlüssel über device.site_id hielte jede Box an ihrer Anlage
-- fest, auch für Wege, die sie verlegen.
ALTER TABLE site ADD COLUMN IF NOT EXISTS lead_device_id UUID;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_lead_device_fk') THEN
        ALTER TABLE site ADD CONSTRAINT site_lead_device_fk
            FOREIGN KEY (lead_device_id, tenant_id) REFERENCES device (id, tenant_id)
            ON DELETE SET NULL (lead_device_id);
    END IF;
END
$$;

-- Die Datenquelle, hinter der die Komponente antwortet (AP-06 §4.3 Nr. 3:
-- Komponente → Gerät → Datenquelle → lesende Box). NULL = noch nicht
-- zugeordnet — der Stand jeder Bestands-Komponente, bis die Vorschlagsliste
-- (IP-4) bestätigt ist. `measurement_point.device_id` bleibt, wie es ist.
ALTER TABLE measurement_point ADD COLUMN IF NOT EXISTS data_source_id UUID;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'measurement_point_data_source_fk') THEN
        ALTER TABLE measurement_point ADD CONSTRAINT measurement_point_data_source_fk
            FOREIGN KEY (data_source_id, tenant_id) REFERENCES data_source (id, tenant_id)
            ON DELETE RESTRICT;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE data_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_source_tenant_isolation ON data_source;
CREATE POLICY data_source_tenant_isolation ON data_source
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE data_source_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source_kennzeichen_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_source_kennzeichen_seq_tenant_isolation ON data_source_kennzeichen_seq;
CREATE POLICY data_source_kennzeichen_seq_tenant_isolation ON data_source_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE data_source_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source_assignment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_source_assignment_tenant_isolation ON data_source_assignment;
CREATE POLICY data_source_assignment_tenant_isolation ON data_source_assignment
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben darf.
-- Die BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie). Keine Tabelle hat ein BIGSERIAL, darum gibt es
-- kein Sequenz-Grant: der Kennzeichen-Zähler IST eine Tabelle.
--
-- Eine Quelle wird archiviert, nie gelöscht.
GRANT SELECT, INSERT, UPDATE ON data_source TO ${appDbUser};
REVOKE DELETE ON data_source FROM ${appDbUser};
-- Der Zähler rückt vor, er verschwindet nicht.
GRANT SELECT, INSERT, UPDATE ON data_source_kennzeichen_seq TO ${appDbUser};
REVOKE DELETE ON data_source_kennzeichen_seq FROM ${appDbUser};
-- Ein Zeitraum wird beendet — nie gelöscht, nie umgeschrieben. Die Rücknahme
-- eines GEPLANTEN Wechsels (AP-06 §5 „Abschaltung und Rücknahme" Nr. 4) bringt
-- IP-12 mit, als eigenes, auf nicht begonnene Zeiträume beschränktes Recht.
-- (Das REVOKE auf Tabellenebene nimmt auch Spaltenrechte mit; das GRANT danach
-- setzt genau das eine wieder — ein erneuter Lauf landet im selben Zustand.)
GRANT SELECT, INSERT ON data_source_assignment TO ${appDbUser};
REVOKE UPDATE, DELETE ON data_source_assignment FROM ${appDbUser};
GRANT UPDATE (effective_to) ON data_source_assignment TO ${appDbUser};
