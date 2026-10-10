-- =============================================================================
-- UEMS AP-15 IP-4 — das VERBUND-OBJEKT der Gemeinsamen Steuerung (Konzept
-- vp-uems-ap15-verbund §3.2, §4.2 T1/T2/T6, §6.1, §8 IP-4, Kasten W3 —
-- entschieden am 21.09.2026; Vertrag docs/contracts/v2/steuerungsverbund.md §5).
--
--   steuerungsverbund            je Anlage höchstens eine Gemeinsame Steuerung:
--                                Stufe (Vokabular `stufe` aus IP-2) und Epoche
--   steuerungsverbund_mitglied   die steuernden Boxen, zeitgültig: Rolle
--                                `fuehrt`/`steuert_mit`, Messpunkt (Datenquelle
--                                der Anlage), Revision gesendet/quittiert
--   steuerungsverbund_aenderung  das Protokoll (Muster netzanschluss_aenderung)
--
-- ⚠ T1 IN DER DATENBANK: Box UND Anlage reisen als ZUSAMMENGESETZTER
-- Fremdschlüssel mit — (device_id, site_id, tenant_id) auf die Heimat der Box
-- (uq_device_id_site_tenant) und (steuerungsverbund_id, site_id, tenant_id) auf
-- den Verbund. Eine Box einer anderen Anlage kann die Datenbank nicht
-- aufnehmen (23503); dieselbe Regel hält uems/SteuerungsverbundRegeln
-- (`box_nicht_in_anlage`). Der gekuppelte Fall (ein System an mehreren
-- Netzanschlüssen, W3) bleibt ausgeschlossen: der Verbund hängt an der Anlage,
-- und die Anlage hängt über anlage_netzanschluss an höchstens EINEM Anschluss
-- je Tag — der Verbund speichert KEINEN eigenen Netzanschluss (T2 prüft die
-- Regel gegen die Bindung).
--
-- ⚠ T6 — LESEN MACHT KEIN MITGLIED: die Rolle `liest` steht hier nie (CHECK);
-- eine Zuständigkeit fürs Lesen (data_source_assignment) legt keine Zeile an.
--
-- ⚠ GENAU EINE FÜHRT: die Datenbank hält „höchstens eine je Zeitpunkt“
-- (Exklusion); „mindestens eine“ ist ein Urteil der Regel
-- (`fuehrende_box_misst_nicht`), weil Mitglieder nacheinander eingetragen werden.
--
-- DIE ZEIT: Mitgliedschaften sind minutengenau und halboffen [gueltig_ab,
-- gueltig_bis) — so steht V-1 in der Referenzdatei 1.5 (E-4 bis zum Box-Tausch,
-- E-4′ ab dann, R17). Beendet oder aufgehoben, nie gelöscht, nie umgehängt.
--
-- ⚠ REIN ADDITIV: drei leere Tabellen und ein zusätzlicher Eindeutigkeits-
-- Schlüssel an data_source (id, site_id, tenant_id — id ist schon Primär-
-- schlüssel, der Schlüssel verengt nichts). Keine Bestandszeile ändert sich, es
-- wird KEINE Zeile angelegt. Eine Anlage ohne Gemeinsame Steuerung verhält sich
-- Byte für Byte wie vorher (I6, R22).
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS).
-- =============================================================================

-- Ziel des Messpunkt-Fremdschlüssels: eine Datenquelle DIESER Anlage.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_data_source_id_site_tenant') THEN
        ALTER TABLE data_source ADD CONSTRAINT uq_data_source_id_site_tenant UNIQUE (id, site_id, tenant_id);
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- steuerungsverbund — je Anlage höchstens einer
-- -----------------------------------------------------------------------------
-- Die Anlage darf gehen: „Anlage löschen“ verlangt, dass alle Boxen ausgebaut sind;
-- dann nimmt die Kaskade den Verbund und seine Mitglieder mit. Das Protokoll hat
-- keinen Verweis auf den Verbund und bleibt.
CREATE TABLE IF NOT EXISTS steuerungsverbund (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL,
    site_id     UUID        NOT NULL,
    -- Vokabular `stufe` (SteuerungsverbundVokabular.Stufe): S0 erklaert · S1
    -- beobachtet · S2 geprueft · S3 anteile_aktiv · angehalten. S4 gibt es nicht (E1 = A).
    stufe       TEXT        NOT NULL DEFAULT 'erklaert',
    -- Eine neue Epoche setzt nur das Scharfschalten (G5); sie steigt nur.
    epoche      BIGINT      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT steuerungsverbund_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_je_anlage_einer UNIQUE (tenant_id, site_id),
    -- Ziel des zusammengesetzten Fremdschlüssels der Mitglieder.
    CONSTRAINT steuerungsverbund_id_site_tenant_uq UNIQUE (id, site_id, tenant_id),
    CONSTRAINT steuerungsverbund_stufe_chk
        CHECK (stufe IN ('erklaert', 'beobachtet', 'geprueft', 'anteile_aktiv', 'angehalten')),
    CONSTRAINT steuerungsverbund_epoche_chk CHECK (epoche >= 0)
);

-- -----------------------------------------------------------------------------
-- steuerungsverbund_mitglied — die steuernden Boxen der Anlage, zeitgültig
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS steuerungsverbund_mitglied (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    steuerungsverbund_id UUID        NOT NULL,
    -- Die Anlage des Verbunds UND die Heimat der Box — dieselbe Spalte in beiden
    -- zusammengesetzten Fremdschlüsseln (T1).
    site_id              UUID        NOT NULL,
    device_id            UUID        NOT NULL,
    rolle                TEXT        NOT NULL,
    -- Der eigene Messpunkt: eine Datenquelle dieser Anlage. NULL nur bei
    -- `steuert_mit` ohne Abgangszähler — dann gilt die Summe ihrer Geräteleistungen (B3).
    -- Ob das Mitglied ihn liest, ist zeitabhängig und ein Urteil der Regel.
    data_source_id       UUID,
    gueltig_ab           TIMESTAMPTZ NOT NULL,
    gueltig_bis          TIMESTAMPTZ,
    aufgehoben_am        TIMESTAMPTZ,
    -- Zuletzt gesendetes und zuletzt quittiertes Anteils-Dokument (G5, Y1). NULL =
    -- noch nie — unbekannt ist keine Null. Beide steigen nur (Schreibweg).
    gesendet_epoche      BIGINT,
    gesendet_revision    BIGINT,
    gesendet_am          TIMESTAMPTZ,
    quittiert_epoche     BIGINT,
    quittiert_revision   BIGINT,
    quittiert_am         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by           TEXT,
    CONSTRAINT steuerungsverbund_mitglied_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_mitglied_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    -- T1: die Heimat der Box ist die Anlage des Verbunds.
    CONSTRAINT steuerungsverbund_mitglied_box_fk FOREIGN KEY (device_id, site_id, tenant_id)
        REFERENCES device (id, site_id, tenant_id) ON DELETE CASCADE,
    -- Messpunkt = Datenquelle DIESER Anlage.
    CONSTRAINT steuerungsverbund_mitglied_messpunkt_fk FOREIGN KEY (data_source_id, site_id, tenant_id)
        REFERENCES data_source (id, site_id, tenant_id) ON DELETE RESTRICT,
    -- T6: `liest` ist kein Mitglied.
    CONSTRAINT steuerungsverbund_mitglied_rolle_chk CHECK (rolle IN ('fuehrt', 'steuert_mit')),
    -- Die führende Box misst den Netzanschluss (B1): ohne Messpunkt führt keine.
    CONSTRAINT steuerungsverbund_mitglied_fuehrt_misst_chk
        CHECK (rolle <> 'fuehrt' OR data_source_id IS NOT NULL),
    CONSTRAINT steuerungsverbund_mitglied_nicht_leer
        CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    CONSTRAINT steuerungsverbund_mitglied_volle_minute
        CHECK (date_trunc('minute', gueltig_ab AT TIME ZONE 'UTC') = gueltig_ab AT TIME ZONE 'UTC'
               AND (gueltig_bis IS NULL
                    OR date_trunc('minute', gueltig_bis AT TIME ZONE 'UTC') = gueltig_bis AT TIME ZONE 'UTC')),
    CONSTRAINT steuerungsverbund_mitglied_gesendet_chk
        CHECK ((gesendet_epoche IS NULL) = (gesendet_revision IS NULL)
               AND (gesendet_epoche IS NULL) = (gesendet_am IS NULL)
               AND (gesendet_epoche IS NULL OR (gesendet_epoche >= 0 AND gesendet_revision >= 0))),
    -- Quittiert wird nur, was gesendet wurde — nie ein jüngerer Stand.
    CONSTRAINT steuerungsverbund_mitglied_quittiert_chk
        CHECK ((quittiert_epoche IS NULL) = (quittiert_revision IS NULL)
               AND (quittiert_epoche IS NULL) = (quittiert_am IS NULL)
               AND (quittiert_epoche IS NULL
                    OR (gesendet_epoche IS NOT NULL
                        AND (quittiert_epoche, quittiert_revision) <= (gesendet_epoche, gesendet_revision)))),
    -- Genau eine führt: je Verbund und Zeitpunkt höchstens EINE führende Box.
    -- tenant_id vorn: die Exklusion prüft ohne RLS und verrät keinem fremden Mandanten etwas.
    CONSTRAINT steuerungsverbund_mitglied_eine_fuehrt EXCLUDE USING gist (
        tenant_id WITH =,
        steuerungsverbund_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (rolle = 'fuehrt' AND aufgehoben_am IS NULL),
    -- Eine Box ist je Zeitpunkt höchstens einmal Mitglied.
    CONSTRAINT steuerungsverbund_mitglied_box_einmal EXCLUDE USING gist (
        tenant_id WITH =,
        device_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (aufgehoben_am IS NULL),
    -- Kein Doppel-Lesen (§3.3, AP-06 E10 = B): ein Messpunkt ist je Zeitpunkt die
    -- Regelgröße höchstens EINES Mitglieds.
    CONSTRAINT steuerungsverbund_mitglied_messpunkt_einmal EXCLUDE USING gist (
        tenant_id WITH =,
        data_source_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (aufgehoben_am IS NULL AND data_source_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_mitglied_verbund
    ON steuerungsverbund_mitglied (steuerungsverbund_id, gueltig_ab);

-- -----------------------------------------------------------------------------
-- steuerungsverbund_aenderung — das Protokoll (Muster netzanschluss_aenderung).
-- `art`: eingerichtet · stufe (alt/neu = die Stufe) · epoche · mitglied (alt null =
-- aufgenommen, neu null = beendet/aufgehoben) · anlage_entfernt. Kein Verweis auf
-- den Verbund (ein Protokoll überlebt sein Objekt), aber auf den Mandanten: nur
-- das Offboarding räumt es ab.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS steuerungsverbund_aenderung (
    id                   BIGSERIAL   PRIMARY KEY,
    tenant_id            UUID        NOT NULL,
    steuerungsverbund_id UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    art                  TEXT        NOT NULL,
    alt                  JSONB,
    neu                  JSONB,
    gilt_ab              TIMESTAMPTZ NOT NULL,
    rueckwirkend         BOOLEAN     NOT NULL,
    grund                TEXT,
    actor_sub            TEXT,
    actor_name           TEXT        NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT steuerungsverbund_aenderung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_aenderung_art_chk
        CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt')),
    CONSTRAINT steuerungsverbund_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT steuerungsverbund_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT steuerungsverbund_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT steuerungsverbund_aenderung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gilt_ab < created_at)
);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_aenderung_verbund
    ON steuerungsverbund_aenderung (steuerungsverbund_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_aenderung_site
    ON steuerungsverbund_aenderung (site_id, created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE steuerungsverbund ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_tenant_isolation ON steuerungsverbund;
CREATE POLICY steuerungsverbund_tenant_isolation ON steuerungsverbund
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerungsverbund_mitglied ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_mitglied FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_mitglied_tenant_isolation ON steuerungsverbund_mitglied;
CREATE POLICY steuerungsverbund_mitglied_tenant_isolation ON steuerungsverbund_mitglied
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE steuerungsverbund_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_aenderung_tenant_isolation ON steuerungsverbund_aenderung;
CREATE POLICY steuerungsverbund_aenderung_tenant_isolation ON steuerungsverbund_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. ALTER DEFAULT PRIVILEGES gibt beiden Rollen alles — hier wird ALLES
-- genommen und eng neu gegeben. Beenden statt löschen: kein DELETE für die
-- App-Rolle; Anlage und Mandant eines Verbunds oder Mitglieds ändern sich nie,
-- ein Mitglied wird nie umgehängt (Box, Rolle, Messpunkt fest — eine Änderung ist
-- ein neues Intervall, T6). Das Offboarding (TenantRepository.offboard) räumt alle
-- drei ab, Kinder zuerst.
-- -----------------------------------------------------------------------------
REVOKE ALL ON steuerungsverbund, steuerungsverbund_mitglied, steuerungsverbund_aenderung
    FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT, INSERT ON steuerungsverbund TO ${appDbUser};
GRANT UPDATE (stufe, epoche, updated_at) ON steuerungsverbund TO ${appDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_mitglied TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am, gesendet_epoche, gesendet_revision, gesendet_am,
              quittiert_epoche, quittiert_revision, quittiert_am)
    ON steuerungsverbund_mitglied TO ${appDbUser};
-- Das Protokoll: lesen und anhängen.
GRANT SELECT, INSERT ON steuerungsverbund_aenderung TO ${appDbUser};

GRANT SELECT, DELETE ON steuerungsverbund, steuerungsverbund_mitglied, steuerungsverbund_aenderung
    TO ${adminDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Recht (die rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE steuerungsverbund_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE steuerungsverbund_aenderung_id_seq TO ${adminDbUser};

COMMENT ON TABLE steuerungsverbund IS
    'UEMS AP-15 IP-4: Gemeinsame Steuerung je Anlage (hoechstens eine), Stufe und Epoche; der Netzanschluss kommt aus anlage_netzanschluss (T2, W3).';
COMMENT ON TABLE steuerungsverbund_mitglied IS
    'UEMS AP-15 IP-4: steuernde Box je Zeitraum; Box + Anlage als zusammengesetzter Fremdschluessel (T1), hoechstens eine fuehrt, Messpunkt = Datenquelle der Anlage, liest ist kein Mitglied (T6).';
COMMENT ON TABLE steuerungsverbund_aenderung IS
    'UEMS AP-15 IP-4: append-only Aenderungsprotokoll der Gemeinsamen Steuerung mit Urheber (actor_*).';
