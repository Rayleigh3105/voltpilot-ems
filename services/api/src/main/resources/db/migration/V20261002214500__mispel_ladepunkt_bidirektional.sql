-- MiSpeL MP-31: das Datenmodell des bidirektionalen Ladepunkts nach Anlage 1 der
-- Festlegung (BNetzA, Marktintegration von Speichern und Ladepunkten, Beschluss
-- 01.10.2026). Vertrag: docs/contracts/v2/mispel-ladepunkt-bidirektional.md.
--
-- Anlage 1 S. 7 (Begriff „Ladepunkt“) und S. 26 (Abschn. 3.2.5): nur ein
-- BIDIREKTIONAL nutzbarer Ladepunkt ist dem Stromspeicher gleichgestellt; ein
-- „ausschließlich unidirektional nutzbarer“ Ladepunkt ist gewöhnlicher sonstiger
-- Verbrauch. Entscheidend sind „die technischen Gegebenheiten“ — die Fähigkeit,
-- nicht der Wunsch des Kunden, ob zurückgespeist werden soll (das ist MP-41).
-- Fn. 21: V2G und V2H zählen beide, es sei denn, die Rückspeisung ist technisch
-- unterbunden, sobald gleichzeitig ins Netz eingespeist wird (Fn. 22, die
-- „Alternative zur Ausschließlichkeitsoption“, Abschn. 2.1.3).
--
-- ANKER ist die Komponente des Ladepunkts (measurement_point, Typ `ev-charger`
-- oder `wallbox`), nicht die OCPP-Kennung: die Zählerrollen (MP-6) prüfen über
-- Komponenten, und der V2H-Pilot (MP-40) bindet eine Wallbox über ihre
-- Hersteller-Schnittstelle an, ohne OCPP. `device_charge_point` bleibt der
-- Herzschlag-Spiegel (je Herzschlag ganz ersetzt) und trägt hier nichts.
--
-- ZWEI Gegenstände, zwei Lebensweisen:
--   * ladepunkt_faehigkeit — FASSUNGEN ab einem TAG wie die Zählerrolle: ein
--     Umbau uni- → bidirektional ist eine bestimmungsrelevante Änderung und
--     teilt den Monat (A1 S. 102–104, Abschn. 11). Eine Korrektur desselben
--     Tages hebt die alte Zeile auf (`aufgehoben_am`); gelöscht wird nie.
--   * ladepunkt_fahrzeugfenster + ladepunkt_anwesenheit — die Planungsangaben
--     für den Optimierer (MP-33): wann ein Fahrzeug am Ladepunkt steht, mit
--     welchem Ladestand es abfährt, unter welchen Ladestand nie entladen wird.
--     Kein Gegenstand der Festlegung, darum der laufende Stand ohne Fassungen.
--     Er hängt am Ladepunkt, nicht am Fahrzeug: „egal welches Auto“ (A1 S. 27).
--
-- BESTAND: keine Zeile ändert sich, alle Tabellen beginnen leer. Ein Ladepunkt
-- ohne Fassung gilt als unidirektional (Captain-Vorgabe; VoltPilot kann heute
-- kein bidirektionales Laden) — die Ansicht sagt dazu `erfasst: false`.
--
-- Die Komponente nimmt ihre Zeilen mit (ON DELETE CASCADE); über sie auch die
-- Anlage und der Mandant. Kein eigener Fremdschlüssel auf `tenant`, darum kein
-- Eintrag im Löschzug nötig.

CREATE TABLE IF NOT EXISTS ladepunkt_faehigkeit (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL,
    site_id                UUID        NOT NULL,
    komponente_id          UUID        NOT NULL,
    -- A1 S. 26, Abschn. 3.2.5: „ausschließlich unidirektional nutzbar“ oder
    -- „bidirektional nutzbar“.
    nutzbarkeit            TEXT        NOT NULL,
    -- Die Betriebsweisen der Fn. 21: ins Haus (V2H) bzw. ins Netz (V2G).
    v2h                    BOOLEAN     NOT NULL DEFAULT FALSE,
    v2g                    BOOLEAN     NOT NULL DEFAULT FALSE,
    -- A1 S. 27 Fn. 22: die Rückspeisung wird technisch unterbunden, sobald
    -- gleichzeitig Strom ins Netz eingespeist wird.
    rueckspeisung_bei_einspeisung_unterbunden BOOLEAN NOT NULL DEFAULT FALSE,
    -- Höchste Rückspeiseleistung in kW; NULL = nicht bekannt, nie 0.
    rueckspeiseleistung_kw NUMERIC,
    gueltig_ab             DATE        NOT NULL,
    aufgehoben_am          TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by             TEXT,
    CONSTRAINT ladepunkt_faehigkeit_komponente_fk FOREIGN KEY (komponente_id, tenant_id, site_id)
        REFERENCES measurement_point (id, tenant_id, site_id) ON DELETE CASCADE,
    -- Das geschlossene Vokabular von LadepunktRegeln.NUTZBARKEITEN.
    CONSTRAINT ladepunkt_faehigkeit_nutzbarkeit_chk
        CHECK (nutzbarkeit IN ('unidirektional', 'bidirektional')),
    -- Unidirektional trägt keine Rückspeise-Angaben; bidirektional mindestens eine Betriebsweise.
    CONSTRAINT ladepunkt_faehigkeit_betriebsweise_chk CHECK (
        (nutzbarkeit = 'unidirektional' AND NOT v2h AND NOT v2g
            AND NOT rueckspeisung_bei_einspeisung_unterbunden AND rueckspeiseleistung_kw IS NULL)
        OR (nutzbarkeit = 'bidirektional' AND (v2h OR v2g))),
    -- V2G speist ins Netz: die Sperre der Fn. 22 schlösse genau das aus.
    CONSTRAINT ladepunkt_faehigkeit_unterbunden_chk
        CHECK (NOT (v2g AND rueckspeisung_bei_einspeisung_unterbunden)),
    CONSTRAINT ladepunkt_faehigkeit_leistung_chk
        CHECK (rueckspeiseleistung_kw IS NULL OR (rueckspeiseleistung_kw > 0 AND rueckspeiseleistung_kw <= 1000))
);

-- Je Ladepunkt und Tag höchstens EINE wirksame Fassung.
CREATE UNIQUE INDEX IF NOT EXISTS ladepunkt_faehigkeit_ein_tag
    ON ladepunkt_faehigkeit (komponente_id, gueltig_ab) WHERE aufgehoben_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_ladepunkt_faehigkeit_site
    ON ladepunkt_faehigkeit (tenant_id, site_id, komponente_id, gueltig_ab);

CREATE TABLE IF NOT EXISTS ladepunkt_fahrzeugfenster (
    komponente_id    UUID        PRIMARY KEY,
    tenant_id        UUID        NOT NULL,
    site_id          UUID        NOT NULL,
    -- Unter diesen Ladestand wird nie entladen; NULL = nicht gesagt.
    mindest_soc_pct  NUMERIC,
    -- Nutzbare Kapazität des Fahrzeugs, das hier üblicherweise steht; NULL = nicht bekannt.
    kapazitaet_kwh   NUMERIC,
    geaendert_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_von    TEXT,
    CONSTRAINT ladepunkt_fahrzeugfenster_komponente_fk FOREIGN KEY (komponente_id, tenant_id, site_id)
        REFERENCES measurement_point (id, tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT ladepunkt_fahrzeugfenster_mandant_uq UNIQUE (komponente_id, tenant_id),
    CONSTRAINT ladepunkt_fahrzeugfenster_soc_chk
        CHECK (mindest_soc_pct IS NULL OR (mindest_soc_pct >= 0 AND mindest_soc_pct <= 100)),
    CONSTRAINT ladepunkt_fahrzeugfenster_kapazitaet_chk
        CHECK (kapazitaet_kwh IS NULL OR (kapazitaet_kwh > 0 AND kapazitaet_kwh <= 500))
);

-- Die Anwesenheit: je Wochentag ein oder mehrere Fenster [ankunft, abfahrt) in der
-- Ortszeit des Kundenbereichs. abfahrt < ankunft = über Mitternacht.
CREATE TABLE IF NOT EXISTS ladepunkt_anwesenheit (
    komponente_id    UUID     NOT NULL,
    tenant_id        UUID     NOT NULL,
    -- ISO-Wochentag des Ankunftstags: 1 = Montag … 7 = Sonntag.
    wochentag        SMALLINT NOT NULL,
    ankunft          TIME     NOT NULL,
    abfahrt          TIME     NOT NULL,
    -- Ladestand, mit dem das Fahrzeug abfahren soll; NULL = nicht gesagt.
    abfahrt_soc_pct  NUMERIC,
    PRIMARY KEY (komponente_id, wochentag, ankunft),
    CONSTRAINT ladepunkt_anwesenheit_fenster_fk FOREIGN KEY (komponente_id, tenant_id)
        REFERENCES ladepunkt_fahrzeugfenster (komponente_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT ladepunkt_anwesenheit_wochentag_chk CHECK (wochentag BETWEEN 1 AND 7),
    CONSTRAINT ladepunkt_anwesenheit_dauer_chk CHECK (ankunft <> abfahrt),
    CONSTRAINT ladepunkt_anwesenheit_soc_chk
        CHECK (abfahrt_soc_pct IS NULL OR (abfahrt_soc_pct >= 0 AND abfahrt_soc_pct <= 100))
);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE ladepunkt_faehigkeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_faehigkeit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_faehigkeit_tenant_isolation ON ladepunkt_faehigkeit;
CREATE POLICY ladepunkt_faehigkeit_tenant_isolation ON ladepunkt_faehigkeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ladepunkt_fahrzeugfenster ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_fahrzeugfenster FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_fahrzeugfenster_tenant_isolation ON ladepunkt_fahrzeugfenster;
CREATE POLICY ladepunkt_fahrzeugfenster_tenant_isolation ON ladepunkt_fahrzeugfenster
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ladepunkt_anwesenheit ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_anwesenheit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_anwesenheit_tenant_isolation ON ladepunkt_anwesenheit;
CREATE POLICY ladepunkt_anwesenheit_tenant_isolation ON ladepunkt_anwesenheit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Fähigkeit: lesen, anhängen, aufheben. Fahrzeugfenster: der laufende Stand wird ersetzt.
REVOKE ALL ON ladepunkt_faehigkeit FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON ladepunkt_faehigkeit TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON ladepunkt_faehigkeit TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_faehigkeit TO ${adminDbUser};

REVOKE ALL ON ladepunkt_fahrzeugfenster FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ladepunkt_fahrzeugfenster TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_fahrzeugfenster TO ${adminDbUser};

REVOKE ALL ON ladepunkt_anwesenheit FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, DELETE ON ladepunkt_anwesenheit TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_anwesenheit TO ${adminDbUser};

COMMENT ON TABLE ladepunkt_faehigkeit IS
    'MiSpeL MP-31: Nutzbarkeit uni-/bidirektional (V2H/V2G) je Ladepunkt nach Anlage 1 S. 26, als Fassungen ab einem Tag.';
COMMENT ON TABLE ladepunkt_fahrzeugfenster IS
    'MiSpeL MP-31: Planungsangaben des Ladepunkts für den Optimierer (Mindest-Ladestand, Kapazität).';
COMMENT ON TABLE ladepunkt_anwesenheit IS
    'MiSpeL MP-31: wöchentliche Anwesenheitsfenster am Ladepunkt mit Abfahrt und Ziel-Ladestand.';
