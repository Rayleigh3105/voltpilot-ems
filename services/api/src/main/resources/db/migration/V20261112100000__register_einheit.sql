-- =============================================================================
-- S1 (Konzept vp-mastr-mehrere-einheiten-konzept, Captain-Entscheide E1=B,
-- E2=A, E3=A, E4=A, E5=A, R1=C vom 11.11.2026, report.md Abschnitt 5.1): eine
-- Anlage kann MEHRERE registrierte Erzeugungseinheiten tragen (z. B. ein
-- Süddach von 2014 und ein Ost-West-Dach von 2024), nicht nur eine.
--
--   register_einheit   eine Einheit (PV oder Speicher) am MaStR oder ohne
--                       Registernummer; zwei Schichten: `r_*` = zuletzt vom
--                       Register gelesen (nie direkt wirksam), die übrigen
--                       Spalten = die vom Kunden bestätigten, WIRKSAMEN Werte.
--                       Ein neuer Abruf schreibt nur `r_*`; weicht er von einem
--                       bestätigten Wert ab, ist das ein Hinweis (api-seitig),
--                       keine stille Änderung.
--   einheit_flaeche     eine Dachfläche einer PV-Einheit: Richtung, Neigung,
--                       ihr Anteil an der kWp der Einheit. Eine Einheit mit
--                       "Ost-West" wird zwei Flächen (api-seitig berechnet).
--   einheit_geraet      freiwillige Zuordnung Einheit <-> gemessenes Gerät
--                       (measurement_point ODER geraet_teil der
--                       Anlagensteuerung) - Anzeige, keine Berechnung (S5).
--
-- Die Summen-Zeile `asset` bleibt unverändert die Zahl, mit der Prognose,
-- Optimierer und Erlöse heute rechnen (Rechnung bleibt gleich - Vektoren).
-- Diese Scheibe richtet nur das Datenmodell ein und befüllt es aus dem
-- Bestand; KEIN Leser von `asset` wird umgehängt (das ist S4).
--
-- ÜBERGANG (Abschnitt 5.4): jede Anlage mit `asset.registry_unit_id` bekommt
-- eine Einheit mit genau dieser Nummer. Inbetriebnahme und Modulzahl werden
-- übernommen; die Leistung NUR, wenn an der Anlage keine Erzeuger-Komponente
-- mit eigener kWp hängt (`measurement_point.role = 'pv-generation'` mit
-- gesetzter `capacity_kwp`) - sonst ist `asset.pv_capacity_kwp` schon die
-- Summe aus Haupteinheit + Zusatz-Erzeugern, nicht die Leistung EINER Einheit,
-- und eine geratene Zahl wäre falscher als keine (Abschnitt 5.4). Richtung und
-- Neigung stehen an `asset` nur als Grad, nicht als Katalogwort; eine
-- `einheit_flaeche`-Zeile entsteht nur, wenn sowohl die Grad-Werte als auch
-- die Leistung bekannt sind (die Spalte verlangt `anteil_kwp > 0`). Nichts
-- wird gelöscht, nichts an `asset` geändert.
--
-- Rein additiv: neue Tabellen, Lese-only-Rückfüllung. Angewandte Migrationen
-- bleiben unberührt; funktioniert in Versionsreihenfolge auf einer frischen DB
-- (die Rückfüllung läuft dann einfach über 0 bestehende Anlagen) und bei
-- späterer Ankunft (out-of-order: true).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- register_einheit
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS register_einheit (
    id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id                    UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    art                        TEXT        NOT NULL CHECK (art IN ('pv', 'speicher')),
    -- NULL = noch nicht abgerufen (eine Einheit kann der Kunde auch ohne
    -- Registernummer anlegen, Abschnitt 5.1).
    registry                   TEXT        CHECK (registry IS NULL OR registry = 'mastr'),
    registry_unit_id           TEXT        CHECK (registry_unit_id IS NULL OR registry_unit_id ~ '^SEE[0-9]{12}$'),
    bezeichnung                TEXT        CHECK (bezeichnung IS NULL
                                    OR (char_length(bezeichnung) BETWEEN 1 AND 120 AND btrim(bezeichnung) <> '')),

    -- Register-Schicht: zuletzt gelesen, nie direkt wirksam (Abschnitt 5.1).
    r_inbetriebnahme           DATE,
    r_leistung_kwp             NUMERIC(10, 3) CHECK (r_leistung_kwp IS NULL OR r_leistung_kwp >= 0),
    r_wechselrichter_kw        NUMERIC(10, 3) CHECK (r_wechselrichter_kw IS NULL OR r_wechselrichter_kw >= 0),
    r_module                   INTEGER        CHECK (r_module IS NULL OR r_module >= 0),
    r_hauptausrichtung         TEXT,
    r_nebenausrichtung         TEXT,
    r_neigung                  TEXT,
    r_einspeisungsart          TEXT,
    r_eeg_nummer               TEXT,
    r_lokation                 TEXT        CHECK (r_lokation IS NULL OR r_lokation ~ '^SEL[0-9]{12}$'),
    r_speicher_kwh              NUMERIC(10, 3) CHECK (r_speicher_kwh IS NULL OR r_speicher_kwh >= 0),
    r_speicher_kw               NUMERIC(10, 3) CHECK (r_speicher_kw IS NULL OR r_speicher_kw >= 0),
    r_speicher_ladeleistung_kw  NUMERIC(10, 3) CHECK (r_speicher_ladeleistung_kw IS NULL OR r_speicher_ladeleistung_kw >= 0),
    r_abgerufen_am              TIMESTAMPTZ,

    -- Wirksame Schicht: vom Kunden bestätigt, kann von der Register-Schicht
    -- abweichen (ein späterer Abruf überschreibt sie nie, Abschnitt 4.5).
    inbetriebnahme              DATE,
    leistung_kwp                NUMERIC(10, 3) CHECK (leistung_kwp IS NULL OR leistung_kwp >= 0),
    speicher_kwh                 NUMERIC(10, 3) CHECK (speicher_kwh IS NULL OR speicher_kwh >= 0),
    speicher_kw                  NUMERIC(10, 3) CHECK (speicher_kw IS NULL OR speicher_kw >= 0),
    speicher_ladeleistung_kw     NUMERIC(10, 3) CHECK (speicher_ladeleistung_kw IS NULL OR speicher_ladeleistung_kw >= 0),
    bestaetigt_am                TIMESTAMPTZ,
    bestaetigt_von               TEXT,
    revision                     INTEGER     NOT NULL DEFAULT 1 CHECK (revision >= 1),

    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Eine Registernummer ist je Anlage eindeutig (zwei Anlagen können nicht
    -- dieselbe Einheit tragen - Abschnitt 5.1); NULL (keine Nummer) ist
    -- mehrfach erlaubt.
    CONSTRAINT uq_register_einheit_site_nummer UNIQUE (site_id, registry_unit_id)
);
CREATE INDEX IF NOT EXISTS idx_register_einheit_site ON register_einheit (site_id);
CREATE INDEX IF NOT EXISTS idx_register_einheit_tenant ON register_einheit (tenant_id);
-- Die Lokations-Suche (S2) prüft "schon an dieser Anlage?" vor der Übernahme.
CREATE INDEX IF NOT EXISTS idx_register_einheit_lokation ON register_einheit (r_lokation) WHERE r_lokation IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON register_einheit TO ${appDbUser};

ALTER TABLE register_einheit ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_einheit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS register_einheit_tenant_isolation ON register_einheit;
CREATE POLICY register_einheit_tenant_isolation ON register_einheit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE register_einheit IS
    'Eine registrierte Erzeugungs- oder Speichereinheit einer Anlage (es kann '
    'mehrere je Anlage geben); r_*-Spalten sind die zuletzt gelesenen '
    'Register-Werte, die uebrigen die vom Kunden bestaetigten, wirksamen Werte. '
    'Konzept vp-mastr-mehrere-einheiten-konzept, report.md Abschnitt 5.1.';

-- -----------------------------------------------------------------------------
-- einheit_flaeche
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS einheit_flaeche (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    einheit_id      UUID        NOT NULL REFERENCES register_einheit(id) ON DELETE CASCADE,
    richtung_grad   NUMERIC(5, 1) NOT NULL CHECK (richtung_grad >= 0 AND richtung_grad < 360),
    neigung_grad    NUMERIC(5, 1) CHECK (neigung_grad IS NULL OR (neigung_grad >= 0 AND neigung_grad <= 90)),
    anteil_kwp      NUMERIC(10, 3) NOT NULL CHECK (anteil_kwp > 0),
    module          INTEGER     CHECK (module IS NULL OR module >= 0),
    quelle          TEXT        NOT NULL CHECK (quelle IN ('register', 'vorschlag', 'kunde')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_einheit_flaeche_einheit ON einheit_flaeche (einheit_id);
CREATE INDEX IF NOT EXISTS idx_einheit_flaeche_tenant ON einheit_flaeche (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON einheit_flaeche TO ${appDbUser};

ALTER TABLE einheit_flaeche ENABLE ROW LEVEL SECURITY;
ALTER TABLE einheit_flaeche FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS einheit_flaeche_tenant_isolation ON einheit_flaeche;
CREATE POLICY einheit_flaeche_tenant_isolation ON einheit_flaeche
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE einheit_flaeche IS
    'Eine Dachflaeche einer PV-Einheit (Richtung, Neigung, Anteil an ihrer kWp); '
    'eine Einheit mit "Ost-West" wird zwei Flaechen. Konzept '
    'vp-mastr-mehrere-einheiten-konzept, report.md Abschnitt 5.1.';

-- -----------------------------------------------------------------------------
-- einheit_geraet — freiwillige Anzeige-Zuordnung, keine Berechnung (S5 nutzt sie)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS einheit_geraet (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    einheit_id              UUID        NOT NULL REFERENCES register_einheit(id) ON DELETE CASCADE,
    measurement_point_id    UUID        REFERENCES measurement_point(id) ON DELETE CASCADE,
    geraet_teil_id          UUID        REFERENCES geraet_teil(id) ON DELETE CASCADE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Entweder eine Komponente oder eine Erzeugungseinheit der
    -- Anlagensteuerung - nie beides, nie keines.
    CONSTRAINT einheit_geraet_genau_eins
        CHECK (num_nonnulls(measurement_point_id, geraet_teil_id) = 1),
    CONSTRAINT uq_einheit_geraet_mp UNIQUE (einheit_id, measurement_point_id),
    CONSTRAINT uq_einheit_geraet_gt UNIQUE (einheit_id, geraet_teil_id)
);
CREATE INDEX IF NOT EXISTS idx_einheit_geraet_einheit ON einheit_geraet (einheit_id);
CREATE INDEX IF NOT EXISTS idx_einheit_geraet_tenant ON einheit_geraet (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON einheit_geraet TO ${appDbUser};

ALTER TABLE einheit_geraet ENABLE ROW LEVEL SECURITY;
ALTER TABLE einheit_geraet FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS einheit_geraet_tenant_isolation ON einheit_geraet;
CREATE POLICY einheit_geraet_tenant_isolation ON einheit_geraet
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE einheit_geraet IS
    'Freiwillige Anzeige-Zuordnung einer Einheit zu einem gemessenen Geraet '
    '(measurement_point oder geraet_teil); keine Berechnung haengt daran (S5). '
    'Konzept vp-mastr-mehrere-einheiten-konzept, report.md Abschnitt 5.1.';

-- -----------------------------------------------------------------------------
-- ÜBERGANG: jede Anlage mit asset.registry_unit_id bekommt eine Einheit.
-- Nur INSERT - nichts an `asset` oder an Bestandsdaten wird geändert.
-- -----------------------------------------------------------------------------
INSERT INTO register_einheit (
    tenant_id, site_id, art, registry, registry_unit_id,
    r_inbetriebnahme, r_leistung_kwp, r_module, r_abgerufen_am,
    r_speicher_kwh, r_speicher_kw,
    inbetriebnahme, leistung_kwp, speicher_kwh, speicher_kw,
    bestaetigt_am, bestaetigt_von
)
SELECT
    a.tenant_id, a.site_id,
    CASE a.type WHEN 'pv' THEN 'pv' ELSE 'speicher' END,
    a.registry, a.registry_unit_id,
    CASE WHEN a.type = 'pv' THEN a.commissioned_on END,
    -- Leistung nur ohne zusätzliche Erzeuger-Komponente mit eigener kWp:
    -- sonst ist asset.pv_capacity_kwp schon die Summe, nicht die Leistung
    -- dieser einen Einheit (Abschnitt 5.4) - eine geratene Zahl wäre falscher
    -- als keine.
    CASE WHEN a.type = 'pv' AND NOT EXISTS (
            SELECT 1 FROM measurement_point mp
            WHERE mp.site_id = a.site_id AND mp.role = 'pv-generation' AND mp.capacity_kwp IS NOT NULL)
        THEN a.pv_capacity_kwp END,
    CASE WHEN a.type = 'pv' THEN a.module_count END,
    a.registry_fetched_at,
    CASE WHEN a.type = 'battery' THEN a.capacity_kwh END,
    CASE WHEN a.type = 'battery' THEN a.max_discharge_kw END,
    CASE WHEN a.type = 'pv' THEN a.commissioned_on END,
    CASE WHEN a.type = 'pv' AND NOT EXISTS (
            SELECT 1 FROM measurement_point mp
            WHERE mp.site_id = a.site_id AND mp.role = 'pv-generation' AND mp.capacity_kwp IS NOT NULL)
        THEN a.pv_capacity_kwp END,
    CASE WHEN a.type = 'battery' THEN a.capacity_kwh END,
    CASE WHEN a.type = 'battery' THEN a.max_discharge_kw END,
    -- Die ursprüngliche MaStR-Übernahme WAR die Bestätigung des Kunden.
    COALESCE(a.registry_fetched_at, now()), 'migration-V20261112100000'
FROM asset a
WHERE a.is_primary AND a.type IN ('pv', 'battery') AND a.registry_unit_id IS NOT NULL
ON CONFLICT (site_id, registry_unit_id) DO NOTHING;

-- Eine Dachfläche nur, wenn Richtung/Neigung UND die Leistung der Einheit
-- bekannt sind (anteil_kwp verlangt > 0, Abschnitt 5.4).
INSERT INTO einheit_flaeche (tenant_id, einheit_id, richtung_grad, neigung_grad, anteil_kwp, module, quelle)
SELECT a.tenant_id, re.id, a.azimuth_deg, a.tilt_deg, a.pv_capacity_kwp, a.module_count, 'register'
FROM asset a
JOIN register_einheit re ON re.site_id = a.site_id AND re.registry_unit_id = a.registry_unit_id
WHERE a.is_primary AND a.type = 'pv' AND a.registry_unit_id IS NOT NULL
    AND a.azimuth_deg IS NOT NULL AND a.pv_capacity_kwp IS NOT NULL AND a.pv_capacity_kwp > 0
    AND re.leistung_kwp IS NOT NULL
    -- Wiederholbar: ein zweiter Lauf legt keine zweite Fläche an (kein
    -- natürlicher Schlüssel auf einheit_flaeche, darum dieser Wächter statt
    -- ON CONFLICT).
    AND NOT EXISTS (SELECT 1 FROM einheit_flaeche ef WHERE ef.einheit_id = re.id);
