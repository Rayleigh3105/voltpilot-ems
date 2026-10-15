-- =============================================================================
-- V20261016100000 - Alerting Scheibe 3: Ruhezeiten, Erinnern
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4 "Ruhezeiten und Stummschalten", §6.5
-- "Erinnern", §7 Scheibe 3, §9), Captain-Entscheid 15.10.2026: 8A (Dringend
-- durchbricht die Ruhezeit über Push, Schalter "Dringendes trotzdem melden",
-- Vorgabe AN).
--
--   ueberwachung.ruhezeit   optionale Ruhezeit JE REGEL ("nur Mo bis Fr 6 bis
--                           18 Uhr"), additiv zur Spalte aus V20261015130000;
--                           NULL = die Regel kennt keine eigene Ruhezeit (nur
--                           die der Person gilt). Eigene Festlegung (kein
--                           Vorbild im Konzept-Text): dieselbe JSON-Form wie
--                           `ruhezeit_person.regeln` (siehe unten) - EIN
--                           Rechenweg für beide Ebenen, eine Zustellung wird
--                           gehalten, wenn Person- ODER Regel-Ruhezeit greift.
--   ruhezeit_person         wiederkehrend je Person ("werktags 22 bis 7 Uhr,
--                           am Wochenende ganz"), in ihrer eigenen Zeitzone;
--                           `dringend_durch` ist der Schalter "Dringendes
--                           trotzdem melden" (Entscheid 8A, Vorgabe AN) - gilt
--                           nur für den Weg Push (§6.4: "Dringend durchbricht
--                           die Ruhezeit über Push").
--   alarm.erinnerungen_*    Zähler und Zeitpunkt der letzten Erinnerung
--                           (§6.5 Vorgabe: nach 1 Stunde, danach alle 4
--                           Stunden, höchstens dreimal) - additiv auf der
--                           bestehenden `alarm`-Tabelle (V20261015130000),
--                           wie schon `probelauf` (V20261015160000) es tat.
--                           Erinnerungen enden bei "Gesehen" ODER "Erledigt"
--                           (Entscheid 3B) - das prüft der Dienst anhand von
--                           `alarm.zustand`, nicht diese Spalte.
--
-- Ruhezeit haelt NUR die Zustellung an (Zusteller, §6.4: "was unterdrückt
-- wird, steht trotzdem in den Meldungen, nur der Weg nach außen schweigt");
-- das Zustandsmodell der Instanz/des Alarms (UeberwachungsService) laeuft
-- unveraendert weiter - "wieder normal" wird also korrekt erkannt, auch
-- waehrend eine Warnung noch auf das Ende der Ruhezeit wartet.
-- =============================================================================

ALTER TABLE ueberwachung ADD COLUMN IF NOT EXISTS ruhezeit JSONB;
COMMENT ON COLUMN ueberwachung.ruhezeit IS
    'Alerting Scheibe 3 (§6.4): Ruhezeit JE REGEL, NULL = keine eigene (nur die der Person gilt). Form wie ruhezeit_person.regeln.';

ALTER TABLE alarm ADD COLUMN IF NOT EXISTS erinnerungen_gesendet INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alarm ADD COLUMN IF NOT EXISTS letzte_erinnerung_am TIMESTAMPTZ;
ALTER TABLE alarm ADD CONSTRAINT alarm_erinnerungen_chk
    CHECK (erinnerungen_gesendet BETWEEN 0 AND 3);
COMMENT ON COLUMN alarm.erinnerungen_gesendet IS
    'Alerting Scheibe 3 (§6.5): Anzahl bereits gesendeter Erinnerungen fuer diesen Alarm, hoechstens 3.';

CREATE TABLE IF NOT EXISTS ruhezeit_person (
    tenant_id       UUID        NOT NULL,
    benutzer_sub    TEXT        NOT NULL,
    -- {"werktags": {"von": "22:00", "bis": "07:00"}, "wochenende": "ganz"}
    -- "wochenende" ist entweder das Wort "ganz" oder ein {"von","bis"}-Objekt
    -- wie "werktags"; beide Felder optional (fehlend = diese Tage haben keine
    -- Ruhezeit). "von" > "bis" ueberspannt Mitternacht.
    regeln          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    zeitzone        TEXT        NOT NULL DEFAULT 'Europe/Berlin',
    -- Entscheid 8A: "Dringendes trotzdem melden" - Vorgabe AN.
    dringend_durch  BOOLEAN     NOT NULL DEFAULT TRUE,
    erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ruhezeit_person_pk PRIMARY KEY (tenant_id, benutzer_sub),
    CONSTRAINT ruhezeit_person_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ruhezeit_person_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT ruhezeit_person_benutzer_chk CHECK (benutzer_sub <> '')
);

ALTER TABLE ruhezeit_person ENABLE ROW LEVEL SECURITY;
ALTER TABLE ruhezeit_person FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ruhezeit_person_tenant_isolation ON ruhezeit_person;
CREATE POLICY ruhezeit_person_tenant_isolation ON ruhezeit_person
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dieselbe Rechte-Form wie `zustellweg`: die Person verwaltet ihre eigene
-- Zeile unter RLS; die Ruhezeit-Pruefung des Zustellers liest quer ueber alle
-- Kundenbereiche (BYPASSRLS-Admin-Rolle, wie ZustellwegRepository.bestaetigtesZiel).
REVOKE ALL ON ruhezeit_person FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ruhezeit_person TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ruhezeit_person TO ${adminDbUser};

COMMENT ON TABLE ruhezeit_person IS
    'Alerting Scheibe 3 (§6.4): wiederkehrende Ruhezeit je Person, eigene Zeitzone, Schalter "Dringendes trotzdem melden".';
