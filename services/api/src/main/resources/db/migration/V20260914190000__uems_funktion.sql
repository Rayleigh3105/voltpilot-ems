-- =============================================================================
-- UEMS AP-01 IP-2 — die FUNKTION je Standort und die TEILNAHME je Anlage
-- (Konzept vp-uems-ap01-portalaufbau §4.2/§4.3 Zustandstabelle, §6.2 Datenhaltung,
-- §8 IP-2; Entscheide E6 = C, E7, E8; Auflösungen W5, W7; Vertrag
-- docs/contracts/v2/funktion-zustand.schema.json aus IP-1).
--
--   funktion            „Messen & Auswerten“ bzw. „Steuern & Optimieren“ an EINEM
--                       Standort, mit dem gespeicherten Zustand und dem Zeitpunkt
--                       je Übergang
--   funktion_teilnahme  die Teilnahme EINER Anlage an „Steuern & Optimieren“ ihres
--                       Standorts (Freigaben, Start, Ruhe hängen an der Anlage, W7)
--
-- ⚠ NACH DER MIGRATION SIND BEIDE LEER. Den Bestand übernimmt der Start-Läufer
-- `uems/FunktionBestandLaeufer` NACH der Standort-Übernahme (AP-02 IP-9) — aus zwei
-- Gründen keine SQL-Füllung hier:
--   * die Regel „Bestand → Zustand“ (W5) lebt als Vertrag mit Zwilling in Java
--     (`FunktionZustandAbleitung.bestand`); eine SQL-Fassung wäre eine zweite Wahrheit;
--   * die Standorte der Bestandskunden legt erst der Start-Läufer
--     `BestandsuebernahmeLaeufer` an — beim Ausrollen läuft diese Migration VOR ihm,
--     eine Füllung fände keinen einzigen Standort.
--
-- DIE ZUSTÄNDE sind die Codes des Vertrags (`zustaende`), OHNE `kein_objekt`: kein
-- Objekt ist keine Zeile. „Messen & Auswerten“ kennt nur entwurf · aktiv · archiviert
-- (`zustaende_messen`), eine Teilnahme gibt es nur an „Steuern & Optimieren“. Die
-- Beobachtungen „liefert Daten“ / „steuert“ werden NIE gespeichert.
--
-- EINE FUNKTION JE STANDORT (E6 = C): höchstens eine nicht archivierte Zeile je
-- Standort und Funktion; wiederbeleben ist eine neue Einrichtung (neue Zeile). Ebenso
-- EINE laufende Teilnahme je Anlage. Welche Anlage zu welchem Standort gehört, sagt
-- `anlage_standort` (je Tag) — der Schreibweg prüft es, nicht die Tabelle.
--
-- DIE ANLAGE DARF GEHEN, IHRE TEILNAHME BLEIBT (Muster anlage_standort, W5,
-- V20260911290000): kein Fremdschlüssel auf `site` — ein RESTRICT ließe „Anlage löschen“
-- mit 500 enden, eine Kaskade löschte die Historie. Die EINFÜGE-Hälfte hält ein Trigger
-- (23503, Constraint funktion_teilnahme_site_fk, FOR KEY SHARE).
--
-- ⚠ REIN ADDITIV: keine bestehende Tabelle, Spalte, Policy oder Funktion ändert sich —
-- insbesondere `site_profile_state` nicht (§6.2). Es kommen zwei leere Tabellen dazu.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS);
-- `tenant_id` steht vorn in jedem Unique-Schlüssel. Keine Folge-Nummer, also weder
-- BIGSERIAL noch Zähler-Tabelle.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- funktion — eine Funktion an einem Standort
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funktion (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL,
    standort_id      UUID        NOT NULL,
    -- Vokabular `funktionen` des Vertrags: messen | steuern.
    funktion         TEXT        NOT NULL,
    zustand          TEXT        NOT NULL,
    -- Die Zeitpunkte je Übergang; NULL = nicht (oder nicht bekannt) — eine aus dem
    -- Bestand übernommene Funktion kennt ihr Einrichtungsdatum nicht (W5), und eine
    -- übernommene Teilnahme ohne bekannten Beginn liest „Gestartet (übernommen)“.
    eingerichtet_am  TIMESTAMPTZ,
    aktiv_seit       TIMESTAMPTZ,
    angehalten_seit  TIMESTAMPTZ,
    archiviert_am    TIMESTAMPTZ,
    -- Wer den heutigen Zustand herbeigeführt hat, so wie ein Mensch es liest
    -- („VoltPilot (Bestandsübernahme)“ oder der Name des Kundenadministrators).
    geaendert_von    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT funktion_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT funktion_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    -- Ziel des Verweises der Teilnahme: Mandant UND Funktion reisen mit.
    CONSTRAINT funktion_id_tenant_funktion_uq UNIQUE (id, tenant_id, funktion),
    CONSTRAINT funktion_funktion_chk CHECK (funktion IN ('messen', 'steuern')),
    CONSTRAINT funktion_zustand_chk
        CHECK (zustand IN ('entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert')),
    -- `zustaende_messen`: Messen wird mit der Einrichtung aktiv und wird nie als Ganzes
    -- angehalten (§4.2).
    CONSTRAINT funktion_messen_zustand_chk
        CHECK (funktion <> 'messen' OR zustand IN ('entwurf', 'aktiv', 'archiviert')),
    CONSTRAINT funktion_archiviert_chk CHECK ((zustand = 'archiviert') = (archiviert_am IS NOT NULL)),
    CONSTRAINT funktion_angehalten_chk CHECK (zustand <> 'angehalten' OR angehalten_seit IS NOT NULL),
    CONSTRAINT funktion_geaendert_von_chk CHECK (btrim(geaendert_von) <> '')
);
-- E6 = C: je Standort höchstens EINE laufende Funktion jeder Art.
CREATE UNIQUE INDEX IF NOT EXISTS uq_funktion_je_standort
    ON funktion (tenant_id, standort_id, funktion) WHERE zustand <> 'archiviert';

-- -----------------------------------------------------------------------------
-- funktion_teilnahme — eine Anlage nimmt an „Steuern & Optimieren“ teil
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funktion_teilnahme (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL,
    funktion_id      UUID        NOT NULL,
    -- Nur „Steuern & Optimieren“ kennt Teilnahmen (§4.2); die Spalte trägt den
    -- zusammengesetzten Verweis, damit keine Teilnahme an „Messen“ hängen kann.
    funktion         TEXT        NOT NULL DEFAULT 'steuern',
    site_id          UUID        NOT NULL,
    zustand          TEXT        NOT NULL,
    -- Beim Umstieg aus dem Bestand abgeleitet (W5) — der Satz sagt dann „(übernommen)“
    -- (Vertrag `teilnahmeEingang.uebernommen`).
    uebernommen      BOOLEAN     NOT NULL DEFAULT false,
    -- Wann die Prüfliste grün wurde (Vertrag `eingerichtet_am`); NULL = unbekannt.
    eingerichtet_am  TIMESTAMPTZ,
    -- „Steuerung starten“; NULL = nie gestartet (oder bei einer übernommenen Teilnahme:
    -- Beginn nicht bekannt).
    gestartet_am     TIMESTAMPTZ,
    angehalten_seit  TIMESTAMPTZ,
    -- „Steuerung beenden“.
    beendet_am       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT funktion_teilnahme_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT funktion_teilnahme_funktion_fk FOREIGN KEY (funktion_id, tenant_id, funktion)
        REFERENCES funktion (id, tenant_id, funktion) ON DELETE RESTRICT,
    CONSTRAINT funktion_teilnahme_nur_steuern_chk CHECK (funktion = 'steuern'),
    CONSTRAINT funktion_teilnahme_zustand_chk
        CHECK (zustand IN ('entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert')),
    CONSTRAINT funktion_teilnahme_beendet_chk CHECK ((zustand = 'archiviert') = (beendet_am IS NOT NULL)),
    CONSTRAINT funktion_teilnahme_angehalten_chk
        CHECK (zustand <> 'angehalten' OR angehalten_seit IS NOT NULL),
    -- Nie gestartet heißt nie gestartet: eine Teilnahme im Entwurf oder eingerichtet
    -- (in Ruhe bis zum Start, E7) trägt weder Start noch Anhalten.
    CONSTRAINT funktion_teilnahme_nie_gestartet_chk
        CHECK (zustand NOT IN ('entwurf', 'eingerichtet')
               OR (gestartet_am IS NULL AND angehalten_seit IS NULL))
);
-- Eine Anlage nimmt höchstens EINMAL laufend teil (Mandant vorn: die Ablehnung prüft
-- ohne RLS und verrät einem fremden Mandanten sonst eine Anlage).
CREATE UNIQUE INDEX IF NOT EXISTS uq_funktion_teilnahme_je_anlage
    ON funktion_teilnahme (tenant_id, site_id) WHERE zustand <> 'archiviert';
-- „Welche Anlagen nehmen an Steuern & Optimieren von Werk Ahrenberg teil?“
CREATE INDEX IF NOT EXISTS idx_funktion_teilnahme_funktion
    ON funktion_teilnahme (tenant_id, funktion_id);

-- -----------------------------------------------------------------------------
-- Die Einfüge-Hälfte des Anlagen-Verweises (W5, Muster uems_anlage_standort_anlage_pruefen)
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER (die Vorgabe): unter RLS sieht die App-Rolle nur die Anlagen ihres
-- Mandanten — und der Mandant der Zeile IST ihrer (Policy WITH CHECK).
CREATE OR REPLACE FUNCTION uems_funktion_teilnahme_anlage_pruefen() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1 FROM site WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'funktion_teilnahme_site_fk',
            MESSAGE = 'funktion_teilnahme: Anlage nicht gefunden';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION uems_funktion_teilnahme_anlage_pruefen() FROM PUBLIC;

DROP TRIGGER IF EXISTS funktion_teilnahme_anlage_pruefen ON funktion_teilnahme;
CREATE TRIGGER funktion_teilnahme_anlage_pruefen
    BEFORE INSERT OR UPDATE OF site_id, tenant_id ON funktion_teilnahme
    FOR EACH ROW EXECUTE FUNCTION uems_funktion_teilnahme_anlage_pruefen();

-- -----------------------------------------------------------------------------
-- Zaun
-- -----------------------------------------------------------------------------
ALTER TABLE funktion ENABLE ROW LEVEL SECURITY;
ALTER TABLE funktion FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS funktion_tenant_isolation ON funktion;
CREATE POLICY funktion_tenant_isolation ON funktion
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE funktion_teilnahme ENABLE ROW LEVEL SECURITY;
ALTER TABLE funktion_teilnahme FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS funktion_teilnahme_tenant_isolation ON funktion_teilnahme;
CREATE POLICY funktion_teilnahme_tenant_isolation ON funktion_teilnahme
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben. Das REVOKE auf
-- Tabellenebene nimmt auch Spaltenrechte mit; ein erneuter Lauf landet im selben
-- Zustand.
--
-- Beenden statt löschen: kein DELETE für die App-Rolle. Änderbar sind nur der Zustand
-- und seine Zeitpunkte — nie Standort, Anlage, Funktion, Mandant oder die Herkunft
-- „übernommen“.
-- -----------------------------------------------------------------------------
REVOKE ALL ON funktion, funktion_teilnahme FROM ${appDbUser}, ${adminDbUser};

GRANT SELECT, INSERT ON funktion TO ${appDbUser};
GRANT UPDATE (zustand, eingerichtet_am, aktiv_seit, angehalten_seit, archiviert_am, geaendert_von,
              updated_at)
    ON funktion TO ${appDbUser};
GRANT SELECT, INSERT ON funktion_teilnahme TO ${appDbUser};
GRANT UPDATE (zustand, eingerichtet_am, gestartet_am, angehalten_seit, beendet_am, updated_at)
    ON funktion_teilnahme TO ${appDbUser};

-- Das Offboarding (TenantRepository.offboard) räumt beide ab, die Teilnahme zuerst.
GRANT SELECT, DELETE ON funktion, funktion_teilnahme TO ${adminDbUser};

COMMENT ON TABLE funktion IS
    'UEMS AP-01 IP-2: Funktion messen|steuern je Standort (E6 = C) mit Zustand und Zeitpunkt je Uebergang; hoechstens eine nicht archivierte je Standort und Funktion.';
COMMENT ON TABLE funktion_teilnahme IS
    'UEMS AP-01 IP-2: Teilnahme einer Anlage an Steuern & Optimieren ihres Standorts (W7); uebernommen = aus dem Bestand abgeleitet (W5). Kein FK auf site (W5), Einfuege-Pruefung per Trigger.';
