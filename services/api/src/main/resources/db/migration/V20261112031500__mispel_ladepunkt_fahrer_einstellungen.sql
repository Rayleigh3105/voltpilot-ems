-- MiSpeL MP-41a: die Einstellungen des Fahrers am bidirektionalen Ladepunkt
-- (Bedienkonzept BK-41, Variante A, Captain 04.10.2026). Vertrag:
-- docs/contracts/v2/mispel-ladepunkt-bidirektional.md § 5a.
--
-- Der Vertrag MP-31 nennt sie ausdrücklich Wünsche, keine Fähigkeit: „Rückspeisen
-- ja/nein als Freigabe des Kunden und ein Zyklenbudget … kommen mit Optimierer und
-- Fläche“. Eine abgeschaltete Rückspeisung macht einen Ladepunkt nach A1 S. 26 NICHT
-- unidirektional — die Fähigkeit (ladepunkt_faehigkeit) bleibt unberührt.
--
-- ZWEI Tabellen, beide der laufende Stand ohne Fassungen (kein Gegenstand der
-- Festlegung) wie das Fahrzeugfenster, am Ladepunkt und nicht am Fahrzeug:
--   * ladepunkt_fahrer_einstellung — Zurückspeisen (aus · v2h · v2g, das Vokabular
--     von entities[].fahrzeug.rueckspeisen im Fahrplan 2.0, MP-39), „Akku schonen“
--     als Vollzyklen je Tag (der Optimierer rechnet bis hier fest mit 1,
--     domain.py FAHRZEUG_VOLLZYKLEN_JE_TAG) und „nur die nächste Fahrt“.
--   * ladepunkt_abfahrt — eine Abfahrt je Wochentag; „eine Abfahrt für mehrere
--     Wochentage“ ist dieselbe Uhrzeit und derselbe Ladestand an mehreren Tagen.
-- Die Reserve ist kein neues Feld: sie ist mindest_soc_pct des Fahrzeugfensters.
--
-- BESTAND: keine Zeile ändert sich, beide Tabellen beginnen leer. Ohne Zeile gilt
-- Zurückspeisen „aus“ (Vorgabe des Bedienkonzepts) — die Box speist ohne Freigabe
-- nie zurück (MP-39).
--
-- Die Komponente nimmt ihre Zeilen mit (ON DELETE CASCADE); über sie auch die
-- Anlage und der Mandant. Kein eigener Fremdschlüssel auf `tenant`.

CREATE TABLE IF NOT EXISTS ladepunkt_fahrer_einstellung (
    komponente_id          UUID        PRIMARY KEY,
    tenant_id              UUID        NOT NULL,
    site_id                UUID        NOT NULL,
    -- Freigabe des Fahrers: aus · v2h (nur ins Haus) · v2g (Haus und Netz).
    rueckspeisen           TEXT        NOT NULL DEFAULT 'aus',
    -- „Akku schonen“: höchstens so viele volle Ladungen am Tag zurück; NULL = nicht gesagt.
    vollzyklen_je_tag      NUMERIC,
    -- „Nur die nächste Fahrt“: einmalige Abfahrt, danach gilt wieder der Wochenplan.
    naechste_fahrt_abfahrt TIMESTAMPTZ,
    naechste_fahrt_soc_pct NUMERIC,
    geaendert_am           TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_von          TEXT,
    CONSTRAINT ladepunkt_fahrer_einstellung_komponente_fk FOREIGN KEY (komponente_id, tenant_id, site_id)
        REFERENCES measurement_point (id, tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT ladepunkt_fahrer_einstellung_mandant_uq UNIQUE (komponente_id, tenant_id),
    -- Das geschlossene Vokabular von LadepunktRegeln.RUECKSPEISEN (= mqtt-schedule-2.0.schema.json).
    CONSTRAINT ladepunkt_fahrer_einstellung_rueckspeisen_chk
        CHECK (rueckspeisen IN ('aus', 'v2h', 'v2g')),
    CONSTRAINT ladepunkt_fahrer_einstellung_zyklen_chk
        CHECK (vollzyklen_je_tag IS NULL OR vollzyklen_je_tag IN (0.5, 1, 2)),
    CONSTRAINT ladepunkt_fahrer_einstellung_naechste_chk
        CHECK ((naechste_fahrt_abfahrt IS NULL) = (naechste_fahrt_soc_pct IS NULL)),
    CONSTRAINT ladepunkt_fahrer_einstellung_soc_chk
        CHECK (naechste_fahrt_soc_pct IS NULL OR (naechste_fahrt_soc_pct >= 0 AND naechste_fahrt_soc_pct <= 100))
);

-- Je Wochentag höchstens eine Abfahrt, Uhrzeit in der Ortszeit des Kundenbereichs.
CREATE TABLE IF NOT EXISTS ladepunkt_abfahrt (
    komponente_id    UUID     NOT NULL,
    tenant_id        UUID     NOT NULL,
    -- ISO-Wochentag der Abfahrt: 1 = Montag … 7 = Sonntag.
    wochentag        SMALLINT NOT NULL,
    abfahrt          TIME     NOT NULL,
    abfahrt_soc_pct  NUMERIC  NOT NULL,
    PRIMARY KEY (komponente_id, wochentag),
    CONSTRAINT ladepunkt_abfahrt_einstellung_fk FOREIGN KEY (komponente_id, tenant_id)
        REFERENCES ladepunkt_fahrer_einstellung (komponente_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT ladepunkt_abfahrt_wochentag_chk CHECK (wochentag BETWEEN 1 AND 7),
    CONSTRAINT ladepunkt_abfahrt_soc_chk CHECK (abfahrt_soc_pct >= 0 AND abfahrt_soc_pct <= 100)
);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE ladepunkt_fahrer_einstellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_fahrer_einstellung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_fahrer_einstellung_tenant_isolation ON ladepunkt_fahrer_einstellung;
CREATE POLICY ladepunkt_fahrer_einstellung_tenant_isolation ON ladepunkt_fahrer_einstellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ladepunkt_abfahrt ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_abfahrt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_abfahrt_tenant_isolation ON ladepunkt_abfahrt;
CREATE POLICY ladepunkt_abfahrt_tenant_isolation ON ladepunkt_abfahrt
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Der laufende Stand wird ersetzt.
REVOKE ALL ON ladepunkt_fahrer_einstellung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ladepunkt_fahrer_einstellung TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_fahrer_einstellung TO ${adminDbUser};

REVOKE ALL ON ladepunkt_abfahrt FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, DELETE ON ladepunkt_abfahrt TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_abfahrt TO ${adminDbUser};

COMMENT ON TABLE ladepunkt_fahrer_einstellung IS
    'MiSpeL MP-41a: Freigabe des Fahrers (aus/v2h/v2g), Akku schonen (Vollzyklen je Tag), nur die nächste Fahrt.';
COMMENT ON TABLE ladepunkt_abfahrt IS
    'MiSpeL MP-41a: Abfahrt und Ladestand bei Abfahrt je Wochentag am Ladepunkt.';
