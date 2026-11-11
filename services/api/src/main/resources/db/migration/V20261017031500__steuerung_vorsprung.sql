-- =============================================================================
-- V20261017031500 - Vorsprung mit Bestand je Anlage fuer den Optimierer
-- (NS-2 A, Captain-Entscheid 15.10.2026, Untersuchung
-- vp-herzogau-nie-schlechter-k5 §7, Bauplan NS-P2).
-- -----------------------------------------------------------------------------
-- Die Kachel "VoltPilot-Steuerung" zeigt Monat und letzte 7 Tage MIT BESTAND
-- gegen den sturen Speicher (HZ-3 A, gegen die faire Messlatte aus NS-1 A).
-- Der Optimierer haelt beide Zahlen ueber ein Vorsprung-Budget nie tiefer als
-- das Budget unter null - dazu braucht er sie beim Einlesen. Er liest die
-- Datenbank direkt (inputs.py), keine Route der api; die api rechnet die
-- Zahlen deshalb periodisch (SteuerungVorsprungLaeufer) und legt je Anlage
-- EINE Zeile hier ab, die sie bei jedem Takt ueberschreibt.
--
-- Vertrag: docs/contracts/steuerung-vorsprung-v1.md. Spalten:
--   tag                      der Berliner Tag D, zu dem die Fenster gehoeren
--   messung_bis              Ende des letzten gemessenen Eimers - der Moment
--                            von vorsprung_kwh (der Optimierer verwirft einen
--                            zu alten Stand)
--   bewertung_ct_kwh         Bezugspreis x sqrt(0,92) (25 ct -> 23,98 ct)
--   vorsprung_kwh            gemessener Ladestand minus Vergleichsspeicher
--   kapazitaet_kwh           kWh je 100 % des Vergleichsspeichers (NS-1 A)
--   monat_mit_bestand_eur    Σ der Tage vom Monatsersten bis einschl. D;
--                            NULL bei einer Luecke (= kein Budget)
--   sieben_tage_mit_bestand_eur  D-6..D, der laufende Tag bis messung_bis;
--                            NULL bei einer Luecke (= kein Budget)
--   tage_mit_bestand_eur     die 6 abgeschlossenen Tage D-6..D-1, aeltester
--                            zuerst (NULL-Eintrag = Luecke); sie fallen an den
--                            Mitternaechten des Plan-Horizonts aus dem Fenster
--   berechnet_am             wann die api die Zeile geschrieben hat
--
-- Rein additiv: neue Tabelle, kein Leser ausser dem Optimierer. Der Optimierer
-- verbindet sich mit der Vertrauensrolle (POSTGRES_USER), die api schreibt je
-- Kundenbereich unter TenantContext mit der Laufzeitrolle - RLS wie jede
-- mandanteneigene Tabelle.
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerung_vorsprung (
    site_id                      UUID           PRIMARY KEY,
    tenant_id                    UUID           NOT NULL,
    tag                          DATE           NOT NULL,
    messung_bis                  TIMESTAMPTZ    NOT NULL,
    bewertung_ct_kwh             NUMERIC(8, 2)  NOT NULL,
    vorsprung_kwh                NUMERIC(12, 3) NOT NULL,
    kapazitaet_kwh               NUMERIC(12, 3) NOT NULL,
    monat_mit_bestand_eur        NUMERIC(12, 2),
    sieben_tage_mit_bestand_eur  NUMERIC(12, 2),
    tage_mit_bestand_eur         NUMERIC(12, 2)[] NOT NULL DEFAULT '{}',
    berechnet_am                 TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT steuerung_vorsprung_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerung_vorsprung_kapazitaet_chk CHECK (kapazitaet_kwh > 0),
    CONSTRAINT steuerung_vorsprung_tage_chk CHECK (cardinality(tage_mit_bestand_eur) <= 6)
);

ALTER TABLE steuerung_vorsprung ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerung_vorsprung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerung_vorsprung_tenant_isolation ON steuerung_vorsprung;
CREATE POLICY steuerung_vorsprung_tenant_isolation ON steuerung_vorsprung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Die Laufzeitrolle schreibt je Kundenbereich (Upsert, Aufraeumen einer
-- Anlage ohne Zahl); die Admin-Rolle liest und loescht wie bei den
-- Alerting-Tabellen.
REVOKE ALL ON steuerung_vorsprung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON steuerung_vorsprung TO ${appDbUser};
GRANT SELECT, DELETE ON steuerung_vorsprung TO ${adminDbUser};

COMMENT ON TABLE steuerung_vorsprung IS
    'NS-2 A: Vorsprung mit Bestand je Anlage (Monat, 7 Tage, kWh) - die api schreibt, der Optimierer liest fuer das Vorsprung-Budget. Vertrag docs/contracts/steuerung-vorsprung-v1.md.';
