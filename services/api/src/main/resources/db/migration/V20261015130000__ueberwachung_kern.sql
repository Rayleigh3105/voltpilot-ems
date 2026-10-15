-- =============================================================================
-- V20261015130000 - Alerting Scheibe 1: Kern der Überwachung (Regel, Instanz, Meldung, Verlauf)
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.5, §6.6, §6.7, §7 Scheibe 1, §9), Captain-
-- Entscheide 15.10.2026: 2A (Vorschläge ab Werk), 3A (nur Dringend braucht
-- "Gesehen"), 4A (Glocke + #/meldungen, Zustands-Anzeige bleibt), 5A (zwei neue
-- Rechte ueberwachung.eigene/verwalten), 6A (Wörter), 13A (3653/90 Tage).
--
-- Diese Migration legt die EINE Regel-, Instanz-, Meldungs- und Verlaufstabelle
-- an, auf die jede spätere Scheibe additiv aufbaut (neue Leserarten, Bedingungen,
-- Kanäle). Scheibe 1 selbst nutzt nur die Bedingungsart "zustand" (Box erreichbar
-- über den Herzschlag, Datenquelle liefert Daten) - "ereignis", freie Schwellen
-- (ueber/unter/ausserhalb/aenderung/periode) und die Fassungs-Historie
-- (ueberwachung_fassung) sind spätere Scheiben (kein Editor für bestehende
-- Regeln in dieser Scheibe, §7 "Ausdrücklich NICHT").
--
--   ueberwachung         die Regel ("Sag mir Bescheid, wenn ..."); auch die
--                        Vorschläge ab Werk sind Zeilen (herkunft = ab_werk),
--                        kein Code (§6.2). Ein Teil-Index verhindert eine
--                        zweite ab-Werk-Zeile derselben Wertart und Anlage -
--                        die Aussaat ist darum idempotent (ON CONFLICT DO
--                        NOTHING), und eine von Hand ausgeschaltete oder
--                        erweiterte Zeile bleibt die EINE Wahrheit.
--   ueberwachung_instanz der technische Stand je Regel UND Bezug (Dauer,
--                        Erholdauer zwischen den Takten) - nie von Menschen
--                        gelesen, deshalb kein site_scope, nur der Mandanten-
--                        Zaun (Muster messreihe_luecke_stand).
--   alarm                die Meldung, wie Menschen sie sehen; Kennzeichen
--                        AL-JJJJ-nnnnnn (§9), nie wiederverwendet.
--   alarm_verlauf        append-only (Trigger reject_audit_mutation, wie
--                        messreihe_ereignis): ausgelöst, Gesehen, wieder
--                        normal, erledigt - der Nachweis, dass überwacht und
--                        reagiert wurde (§6.10 Punkt 4).
--   alarm_kennzeichen_lauf  der Zähler je Kundenbereich und Jahr.
--
-- Der Läufer (UeberwachungsLaeufer, Scheibe 1) arbeitet je Kundenbereich UNTER
-- TenantContext mit der LAUFZEITROLLE (nicht der BYPASSRLS-Admin-Rolle) - er hat
-- keinen Zugriffs-Kontext (§2.5/§6.6), darum sieht er ohne app.zugriff/
-- app.standort_ids automatisch das ganze Unternehmen (site_scope-Vorgabe
-- "unternehmensweit"); die Sicht je EMPFÄNGER prüft erst der Zusteller beim
-- Versand (RechteAbleitung.darf, Scheibe 0 + diese Migration).
-- =============================================================================

CREATE TABLE IF NOT EXISTS ueberwachung (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    -- NULL = unternehmensweit (eine Wertart ohne Standort-Bezug, z.B. künftig
    -- ein Energieziel des Unternehmens); sonst der Standort DIESER Regel -
    -- nicht notwendig der Standort jeder überwachten Anlage (§6.6 Punkt 1).
    standort_id     UUID,
    fassung         INTEGER     NOT NULL DEFAULT 1,
    name            TEXT,
    wertart         TEXT        NOT NULL,
    -- {"anlage": "<id>"} | {"standort": "<id>", "alle": "anlage"} (§6.7 Skizze).
    bezug           JSONB       NOT NULL,
    -- {"art": "zustand", "ziel": ["nicht_erreichbar"], "dauer_s": 900, "erholen_s": 300}
    bedingung       JSONB       NOT NULL,
    schwere         TEXT        NOT NULL,
    -- [{"person": "<sub>"}, {"rolle": "energiemanager"}] (§6.4 "Mehrere Empfänger").
    empfaenger      JSONB       NOT NULL,
    herkunft        TEXT        NOT NULL,
    aktiv           BOOLEAN     NOT NULL DEFAULT TRUE,
    angelegt_von    TEXT        NOT NULL,
    angelegt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_ueberwachung_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT ueberwachung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ueberwachung_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id),
    CONSTRAINT ueberwachung_schwere_chk CHECK (schwere IN ('hinweis', 'warnung', 'dringend')),
    -- Scheibe 1 kennt nur ab_werk (Entscheid 2A) und vorschlag (eine Person
    -- schaltet sich selbst dazu, §6.4); "eigen" (freie Regel am Wert) ist
    -- Scheibe 2, "steuerung" (Rezept "Sag mir Bescheid") ist Scheibe 6 - die
    -- CHECK weitet additiv, wenn ihre Scheibe kommt.
    CONSTRAINT ueberwachung_herkunft_chk CHECK (herkunft IN ('ab_werk', 'vorschlag')),
    CONSTRAINT ueberwachung_wertart_chk CHECK (wertart <> ''),
    CONSTRAINT ueberwachung_fassung_chk CHECK (fassung >= 1),
    CONSTRAINT ueberwachung_name_chk CHECK (name IS NULL OR btrim(name) <> '')
);
-- Aussaat ab Werk (Entscheid 2A): höchstens EINE ab_werk-Zeile je Wertart und
-- Anlage - der Läufer sät mit ON CONFLICT DO NOTHING, nie ein zweites Mal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ueberwachung_ab_werk
    ON ueberwachung (tenant_id, wertart, (bezug ->> 'anlage'))
    WHERE herkunft = 'ab_werk';

CREATE TABLE IF NOT EXISTS ueberwachung_instanz (
    tenant_id        UUID        NOT NULL,
    ueberwachung_id  UUID        NOT NULL,
    -- 'anlage:<id>' - der konkrete Bezug, den eine Auswahl ("alle Anlagen") je
    -- Treffer ergibt (§6.4 "Eine Auswahl ergibt je Bezug eine eigene Instanz").
    bezug_kennung    TEXT        NOT NULL,
    zustand          TEXT        NOT NULL DEFAULT 'normal',
    seit             TIMESTAMPTZ,
    letzter_wert     JSONB,
    letzte_messzeit  TIMESTAMPTZ,
    ausgewertet_am   TIMESTAMPTZ,
    faellig_ab       TIMESTAMPTZ,
    offener_alarm    UUID,
    CONSTRAINT ueberwachung_instanz_pk PRIMARY KEY (tenant_id, ueberwachung_id, bezug_kennung),
    CONSTRAINT ueberwachung_instanz_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ueberwachung_instanz_ueberwachung_fk FOREIGN KEY (tenant_id, ueberwachung_id)
        REFERENCES ueberwachung (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT ueberwachung_instanz_zustand_chk
        CHECK (zustand IN ('normal', 'ausstehend', 'aktiv', 'erholend'))
);
CREATE INDEX IF NOT EXISTS idx_ueberwachung_instanz_faellig
    ON ueberwachung_instanz (faellig_ab) WHERE faellig_ab IS NOT NULL;

CREATE TABLE IF NOT EXISTS alarm (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL,
    -- Der Standort-Zaun der MELDUNG (§6.6 Punkt 1) - vom Bezug der auslösenden
    -- Instanz übernommen; NULL nur für eine unternehmensweite Wertart.
    standort_id         UUID,
    kennzeichen         TEXT        NOT NULL,
    ueberwachung_id     UUID        NOT NULL,
    fassung             INTEGER     NOT NULL,
    bezug_kennung       TEXT        NOT NULL,
    wertart             TEXT        NOT NULL,
    schwere             TEXT        NOT NULL,
    ausgeloest_am       TIMESTAMPTZ NOT NULL,
    wert_beim_ausloesen JSONB,
    -- aktiv -> gesehen (freiwillig, 3B) -> erledigt (wieder normal oder von
    -- Hand); nur Dringend braucht "Gesehen" vor "Erledigt" (Entscheid 3A) -
    -- das prüft der Dienst, nicht diese Tabelle.
    zustand             TEXT        NOT NULL DEFAULT 'aktiv',
    wieder_normal_am    TIMESTAMPTZ,
    gesehen_von         TEXT,
    gesehen_am          TIMESTAMPTZ,
    erledigt_am         TIMESTAMPTZ,
    erledigt_durch      TEXT,
    notiz               TEXT,
    erstellt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_alarm_tenant_id UNIQUE (tenant_id, id),
    CONSTRAINT uq_alarm_kennzeichen UNIQUE (tenant_id, kennzeichen),
    CONSTRAINT alarm_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT alarm_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id),
    CONSTRAINT alarm_ueberwachung_fk FOREIGN KEY (tenant_id, ueberwachung_id)
        REFERENCES ueberwachung (tenant_id, id),
    CONSTRAINT alarm_schwere_chk CHECK (schwere IN ('hinweis', 'warnung', 'dringend')),
    CONSTRAINT alarm_zustand_chk CHECK (zustand IN ('aktiv', 'gesehen', 'erledigt')),
    CONSTRAINT alarm_erledigt_durch_chk CHECK (erledigt_durch IS NULL
        OR erledigt_durch IN ('wert', 'person', 'regel_geaendert', 'regel_geloescht', 'sicht_verloren')),
    CONSTRAINT alarm_gesehen_chk CHECK ((gesehen_von IS NULL) = (gesehen_am IS NULL)),
    CONSTRAINT alarm_erledigt_chk CHECK ((erledigt_am IS NULL) = (erledigt_durch IS NULL))
);
-- "Eine statt einer Flut" (§6.4 Punkt 6/7): höchstens EIN offener Alarm je
-- Regel und Bezug - dieselbe Entdopplung wie messreihe_luecke_stand.luecke_seit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alarm_offen
    ON alarm (tenant_id, ueberwachung_id, bezug_kennung) WHERE zustand <> 'erledigt';
CREATE INDEX IF NOT EXISTS idx_alarm_standort_offen
    ON alarm (tenant_id, standort_id) WHERE zustand <> 'erledigt';
-- Der Löschlauf einer späteren Scheibe fegt nach Alter (Entscheid 13A: 3653 Tage).
CREATE INDEX IF NOT EXISTS idx_alarm_erstellt ON alarm (erstellt_am);

CREATE TABLE IF NOT EXISTS alarm_verlauf (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL,
    alarm_id    UUID        NOT NULL,
    zeitpunkt   TIMESTAMPTZ NOT NULL DEFAULT now(),
    art         TEXT        NOT NULL,
    wer         TEXT,
    wert        JSONB,
    text        TEXT,
    CONSTRAINT alarm_verlauf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT alarm_verlauf_alarm_fk FOREIGN KEY (tenant_id, alarm_id)
        REFERENCES alarm (tenant_id, id),
    CONSTRAINT alarm_verlauf_art_chk
        CHECK (art IN ('ausgeloest', 'versand', 'gesehen', 'wieder_normal', 'erledigt'))
);
CREATE INDEX IF NOT EXISTS idx_alarm_verlauf_alarm ON alarm_verlauf (tenant_id, alarm_id, zeitpunkt);

DROP TRIGGER IF EXISTS alarm_verlauf_append_only ON alarm_verlauf;
CREATE TRIGGER alarm_verlauf_append_only BEFORE UPDATE OR DELETE ON alarm_verlauf
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE IF NOT EXISTS alarm_kennzeichen_lauf (
    tenant_id   UUID    NOT NULL,
    jahr        INTEGER NOT NULL,
    naechste_nr INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT alarm_kennzeichen_lauf_pk PRIMARY KEY (tenant_id, jahr),
    CONSTRAINT alarm_kennzeichen_lauf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT alarm_kennzeichen_lauf_jahr_chk CHECK (jahr >= 2026),
    CONSTRAINT alarm_kennzeichen_lauf_nr_chk CHECK (naechste_nr >= 1)
);

COMMENT ON TABLE ueberwachung IS
    'Alerting Scheibe 1 (§6.4, §6.7): die Regel "Sag mir Bescheid, wenn ..."; auch Vorschläge ab Werk sind Zeilen (herkunft = ab_werk).';
COMMENT ON TABLE ueberwachung_instanz IS
    'Alerting Scheibe 1 (§6.5): der technische Stand je Regel und Bezug zwischen zwei Takten - nie von Menschen gelesen.';
COMMENT ON TABLE alarm IS
    'Alerting Scheibe 1 (§6.5, §9): die Meldung, wie Menschen sie sehen; Kennzeichen AL-JJJJ-nnnnnn, nie wiederverwendet.';
COMMENT ON TABLE alarm_verlauf IS
    'Alerting Scheibe 1 (§6.10 Punkt 4): append-only Nachweis je Meldung - ausgelöst, Versand, gesehen, wieder normal, erledigt.';

-- -----------------------------------------------------------------------------
-- Mandantenzaun + Standort-Zaun (Hausregel: ENABLE + FORCE; site_scope nutzt die
-- Hilfsfunktionen aus V20260915190000, RESTRICTIVE, UND-verknüpft mit dem
-- Mandanten-Zaun - Muster `massnahme`/`massnahme_aenderung`).
-- -----------------------------------------------------------------------------
ALTER TABLE ueberwachung ENABLE ROW LEVEL SECURITY;
ALTER TABLE ueberwachung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ueberwachung_tenant_isolation ON ueberwachung;
CREATE POLICY ueberwachung_tenant_isolation ON ueberwachung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS site_scope ON ueberwachung;
CREATE POLICY site_scope ON ueberwachung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);

ALTER TABLE ueberwachung_instanz ENABLE ROW LEVEL SECURITY;
ALTER TABLE ueberwachung_instanz FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ueberwachung_instanz_tenant_isolation ON ueberwachung_instanz;
CREATE POLICY ueberwachung_instanz_tenant_isolation ON ueberwachung_instanz
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE alarm ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarm FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alarm_tenant_isolation ON alarm;
CREATE POLICY alarm_tenant_isolation ON alarm
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS site_scope ON alarm;
CREATE POLICY site_scope ON alarm AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);

ALTER TABLE alarm_verlauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarm_verlauf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alarm_verlauf_tenant_isolation ON alarm_verlauf;
CREATE POLICY alarm_verlauf_tenant_isolation ON alarm_verlauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS site_scope ON alarm_verlauf;
CREATE POLICY site_scope ON alarm_verlauf AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE EXISTS (SELECT 1 FROM alarm a
                             WHERE a.id = alarm_verlauf.alarm_id AND a.tenant_id = alarm_verlauf.tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE EXISTS (SELECT 1 FROM alarm a
                                  WHERE a.id = alarm_verlauf.alarm_id AND a.tenant_id = alarm_verlauf.tenant_id) END);

ALTER TABLE alarm_kennzeichen_lauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarm_kennzeichen_lauf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alarm_kennzeichen_lauf_tenant_isolation ON alarm_kennzeichen_lauf;
CREATE POLICY alarm_kennzeichen_lauf_tenant_isolation ON alarm_kennzeichen_lauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte: V2/V4s ALTER DEFAULT PRIVILEGES gäben beiden Rollen ALLES - erst
-- zurücknehmen, dann eng erteilen. Der Läufer (UeberwachungsLaeufer) arbeitet
-- je Kundenbereich UNTER TenantContext MIT DER LAUFZEITROLLE (§6.6), nicht der
-- BYPASSRLS-Admin-Rolle - anders als der Zusteller, der quer über alle
-- Kundenbereiche fällige Ausgangszeilen claimt. Die Admin-Rolle bekommt hier
-- nur Lesen (Offboarding/Auswertung), kein eigenes Schreiben.
-- -----------------------------------------------------------------------------
REVOKE ALL ON ueberwachung, ueberwachung_instanz, alarm, alarm_verlauf, alarm_kennzeichen_lauf
    FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT, INSERT, UPDATE, DELETE ON ueberwachung TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ueberwachung_instanz TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE ON alarm TO ${appDbUser};
GRANT SELECT, INSERT ON alarm_verlauf TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE ON alarm_kennzeichen_lauf TO ${appDbUser};

GRANT SELECT ON ueberwachung, ueberwachung_instanz, alarm, alarm_verlauf, alarm_kennzeichen_lauf
    TO ${adminDbUser};
-- Das Offboarding (TenantRepository) löscht einen Kundenbereich vollständig.
GRANT DELETE ON ueberwachung, ueberwachung_instanz, alarm, alarm_verlauf, alarm_kennzeichen_lauf
    TO ${adminDbUser};
