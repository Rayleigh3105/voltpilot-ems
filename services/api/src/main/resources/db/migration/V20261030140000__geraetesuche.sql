-- =============================================================================
-- Gerätesuche, Paket 3 (API) — Konzept vp-portal-geraetesuche-konzept vom
-- 30.10.2026, entschieden DP-1 C, DP-2 bis DP-7 A; Vertrag
-- docs/contracts/v2/mqtt-geraetesuche.md.
--
--   geraetesuche            je „Geräte suchen“ eine Zeile: Auftrag (wer, wann,
--                           welche Box, Frist), Zustand, letzter Zwischenstand,
--                           Netze, Ergebnis und die Zahlen in `weitere`
--   geraetesuche_fund       die Funde einer Suche — NUR Energie-Geräte und
--                           Netz-Technik (DP-3 A). Telefone, Tablets, Rechner
--                           und Unbekanntes kommen nie als Fund an, nur als
--                           Zahl in geraetesuche.weitere_*
--   geraetesuche_protokoll  das nur anfügende Protokoll je Anlage: gestartet
--                           (wer), Abbruch angefragt (wer), beendet (Zustand,
--                           Grund, Dauer, Netze, Zähler je Gruppe)
--
-- Datenschutz (DP-3 A): keine Spalte für eine MAC, einen Hostnamen oder einen
-- Gerätenamen — in keiner der drei Tabellen. Die Identität eines Fundes trägt
-- die Seriennummer. Die Verbindung steht in Spalten statt als JSON, damit ein
-- fehlerhaft gesendetes Feld nie mitgespeichert wird.
--
-- Funde und Suchen gehen nach 30 Tagen (Läufer, geraetesuche_aufraeumen); das
-- Protokoll bleibt — es trägt nur Zähler und Personen. Vorbild:
-- ocpp_action/ocpp_action_audit (Mandanten-Zaun, Wartung als SECURITY DEFINER)
-- und steuerungsverbund_sprungprobe (Auftrag mit Frist, actor_*).
-- =============================================================================

CREATE TABLE IF NOT EXISTS geraetesuche (
    -- Die such_id des Vertrags: die API vergibt sie.
    id                   UUID        PRIMARY KEY,
    tenant_id            UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    -- Die Box, die sucht.
    device_id            UUID        NOT NULL,
    ausgeloest_am        TIMESTAMPTZ NOT NULL,
    -- ausgeloest_am + 120 s: danach beginnt die Box nicht mehr.
    gueltig_bis          TIMESTAMPTZ NOT NULL,
    actor_sub            TEXT,
    actor_name           TEXT        NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT        NOT NULL,
    -- Gespeichert wird, was die Box meldet. „keine_antwort“ (30 s ohne
    -- Meldung) leitet die API beim Lesen ab: eine späte Meldung gilt noch.
    zustand              TEXT        NOT NULL DEFAULT 'wartet',
    grund                TEXT,
    -- Der letzte Zwischenstand (Anzeige; verbindlich ist das Ergebnis).
    stand_nr             INTEGER,
    schritt              TEXT,
    erledigt             INTEGER,
    gesamt               INTEGER,
    rest_s               INTEGER,
    -- Die Netze, wie die Box sie zuletzt meldete (Rolle, Netz, Box-Adresse,
    -- Ausschnitt, erreichbar, aktiv) — nie eine Adresse eines Fundes.
    netze                JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Ankunft der letzten Meldung der Box (Zwischenstand oder Ergebnis).
    letzte_meldung_am    TIMESTAMPTZ,
    -- Das Ergebnis: Ankunft, Dauer laut Box, welche Erkenner liefen.
    beendet_am           TIMESTAMPTZ,
    dauer_ms             INTEGER,
    erkenner             TEXT[],
    -- DP-3 A: Geräte von Personen und Unbekanntes nur als Zahl; NULL = nicht
    -- gezählt (nie 0).
    weitere_telefon_tablet INTEGER,
    weitere_rechner      INTEGER,
    weitere_unbekannt    INTEGER,
    -- Wann ein Abbruch an die Box ging (DELETE …/geraetesuche/{suchId}).
    abbruch_gesendet_am  TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT geraetesuche_site_fk FOREIGN KEY (site_id)
        REFERENCES site (id) ON DELETE CASCADE,
    CONSTRAINT geraetesuche_device_fk FOREIGN KEY (device_id)
        REFERENCES device (id) ON DELETE CASCADE,
    CONSTRAINT geraetesuche_frist_chk
        CHECK (gueltig_bis > ausgeloest_am AND gueltig_bis <= ausgeloest_am + interval '120 seconds'),
    CONSTRAINT geraetesuche_zustand_chk
        CHECK (zustand IN ('wartet', 'laeuft', 'fertig', 'abgebrochen', 'fehlgeschlagen', 'abgelehnt')),
    CONSTRAINT geraetesuche_grund_chk CHECK (
        (zustand IN ('wartet', 'laeuft', 'fertig') AND grund IS NULL)
        OR (zustand = 'abgebrochen' AND grund IN ('auf_wunsch', 'neustart', 'zeitlimit'))
        OR (zustand = 'abgelehnt' AND grund IN ('laeuft_schon', 'zu_oft', 'abgelaufen', 'lan_host_fehlt',
                                                'kein_privates_netz'))
        OR (zustand = 'fehlgeschlagen' AND grund = 'interner_fehler')),
    CONSTRAINT geraetesuche_beendet_chk
        CHECK ((zustand IN ('wartet', 'laeuft')) = (beendet_am IS NULL)),
    CONSTRAINT geraetesuche_zaehlung_chk
        CHECK ((erledigt IS NULL OR erledigt >= 0) AND (gesamt IS NULL OR gesamt >= 0)
               AND (rest_s IS NULL OR rest_s >= 0) AND (dauer_ms IS NULL OR dauer_ms >= 0)
               AND (weitere_telefon_tablet IS NULL OR weitere_telefon_tablet >= 0)
               AND (weitere_rechner IS NULL OR weitere_rechner >= 0)
               AND (weitere_unbekannt IS NULL OR weitere_unbekannt >= 0)),
    CONSTRAINT geraetesuche_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall'))
);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_box
    ON geraetesuche (device_id, ausgeloest_am DESC);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_anlage
    ON geraetesuche (site_id, ausgeloest_am DESC);

CREATE TABLE IF NOT EXISTS geraetesuche_fund (
    such_id         UUID        NOT NULL,
    tenant_id       UUID        NOT NULL,
    site_id         UUID        NOT NULL,
    -- <erkenner>:<Seriennummer, Logger-Seriennummer oder ip:port>, eindeutig je Suche.
    schluessel      TEXT        NOT NULL,
    erkenner        TEXT        NOT NULL,
    art             TEXT        NOT NULL,
    hersteller      TEXT,
    modell          TEXT,
    seriennummer    TEXT,
    firmware        TEXT,
    familie         TEXT,
    spannung        TEXT,
    kanaele         INTEGER,
    erkennung       TEXT        NOT NULL,
    merkmale        TEXT[]      NOT NULL,
    anbindung       TEXT        NOT NULL,
    hindernis       TEXT,
    -- Die Verbindung in den Schlüsseln der Vorlagen.
    communication   TEXT,
    ip              TEXT        NOT NULL,
    port            INTEGER     NOT NULL,
    serial          BIGINT,
    unit_id         INTEGER,
    liest_box_schon BOOLEAN     NOT NULL,
    gemeldet_am     TIMESTAMPTZ NOT NULL,
    CONSTRAINT geraetesuche_fund_pk PRIMARY KEY (such_id, schluessel),
    CONSTRAINT geraetesuche_fund_suche_fk FOREIGN KEY (such_id)
        REFERENCES geraetesuche (id) ON DELETE CASCADE,
    CONSTRAINT geraetesuche_fund_site_fk FOREIGN KEY (site_id)
        REFERENCES site (id) ON DELETE CASCADE,
    CONSTRAINT geraetesuche_fund_erkennung_chk CHECK (erkennung IN ('sicher', 'wahrscheinlich', 'unbekannt')),
    CONSTRAINT geraetesuche_fund_anbindung_chk CHECK (anbindung IN ('uebernehmen', 'selbst_beschreiben',
        'nicht_mit_dieser_box', 'kein_leseweg', 'nur_anzeige')),
    CONSTRAINT geraetesuche_fund_hindernis_chk CHECK (hindernis IS NULL OR hindernis IN ('geschuetzt', 'lokale_api_aus')),
    CONSTRAINT geraetesuche_fund_spannung_chk CHECK (spannung IS NULL OR spannung IN ('hv', 'lv')),
    CONSTRAINT geraetesuche_fund_port_chk CHECK (port BETWEEN 1 AND 65535
        AND (unit_id IS NULL OR unit_id BETWEEN 0 AND 255)
        AND (serial IS NULL OR serial BETWEEN 0 AND 4294967295)
        AND (kanaele IS NULL OR kanaele BETWEEN 1 AND 16)),
    CONSTRAINT geraetesuche_fund_merkmale_chk CHECK (cardinality(merkmale) BETWEEN 1 AND 8)
);

CREATE TABLE IF NOT EXISTS geraetesuche_protokoll (
    id           BIGSERIAL   PRIMARY KEY,
    tenant_id    UUID        NOT NULL,
    site_id      UUID        NOT NULL,
    device_id    UUID        NOT NULL,
    -- Keine Fremdschlüssel auf die Suche: das Protokoll überlebt den Läufer.
    such_id      UUID        NOT NULL,
    art          TEXT        NOT NULL,
    -- Bei gestartet und abbruch die Person (ProtokollAkteur), bei beendet
    -- leer: das meldet die Box.
    actor_sub    TEXT,
    actor_name   TEXT,
    actor_rolle  TEXT,
    actor_art    TEXT,
    -- Bei beendet: was die Box meldet, und die Zahl der Funde je Gruppe.
    zustand      TEXT,
    grund        TEXT,
    dauer_ms     INTEGER,
    netze        JSONB,
    zaehler      JSONB,
    am           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT geraetesuche_protokoll_site_fk FOREIGN KEY (site_id)
        REFERENCES site (id) ON DELETE CASCADE,
    CONSTRAINT geraetesuche_protokoll_art_chk CHECK (art IN ('gestartet', 'abbruch', 'beendet')),
    CONSTRAINT geraetesuche_protokoll_person_chk
        CHECK ((art = 'beendet') = (actor_name IS NULL AND actor_art IS NULL)),
    CONSTRAINT geraetesuche_protokoll_beendet_chk
        CHECK ((art = 'beendet') = (zustand IS NOT NULL)),
    CONSTRAINT geraetesuche_protokoll_actor_art_chk
        CHECK (actor_art IS NULL OR actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall'))
);
CREATE INDEX IF NOT EXISTS idx_geraetesuche_protokoll_anlage
    ON geraetesuche_protokoll (site_id, am DESC);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK; dazu
-- der Standort-Zaun (RESTRICTIVE, wie measurement_point und geraet).
ALTER TABLE geraetesuche ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraetesuche FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraetesuche_tenant_isolation ON geraetesuche;
CREATE POLICY geraetesuche_tenant_isolation ON geraetesuche
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS geraetesuche_site_scope ON geraetesuche;
CREATE POLICY geraetesuche_site_scope ON geraetesuche AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

ALTER TABLE geraetesuche_fund ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraetesuche_fund FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraetesuche_fund_tenant_isolation ON geraetesuche_fund;
CREATE POLICY geraetesuche_fund_tenant_isolation ON geraetesuche_fund
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS geraetesuche_fund_site_scope ON geraetesuche_fund;
CREATE POLICY geraetesuche_fund_site_scope ON geraetesuche_fund AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

ALTER TABLE geraetesuche_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraetesuche_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraetesuche_protokoll_tenant_isolation ON geraetesuche_protokoll;
CREATE POLICY geraetesuche_protokoll_tenant_isolation ON geraetesuche_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS geraetesuche_protokoll_site_scope ON geraetesuche_protokoll;
CREATE POLICY geraetesuche_protokoll_site_scope ON geraetesuche_protokoll AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

-- Der Läufer hat keinen Mandanten der Anfrage: die App-Rolle bleibt unter RLS
-- ohne DELETE auf den Suchen, und das Aufräumen nach 30 Tagen (DP-3 A) läuft
-- über diese eine eng geschnittene Funktion. Die Funde gehen per Kaskade mit;
-- das Protokoll bleibt.
CREATE OR REPLACE FUNCTION geraetesuche_aufraeumen(p_vor TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE geloescht INTEGER;
BEGIN
  IF p_vor IS NULL OR p_vor > now() - interval '30 days' THEN
    RAISE EXCEPTION 'Gerätesuchen gehen erst nach 30 Tagen' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.geraetesuche WHERE ausgeloest_am < p_vor;
  GET DIAGNOSTICS geloescht = ROW_COUNT;
  RETURN geloescht;
END $$;
REVOKE ALL ON FUNCTION geraetesuche_aufraeumen(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION geraetesuche_aufraeumen(TIMESTAMPTZ) TO ${appDbUser};

-- Rechte: die Suche wird angelegt und fortgeschrieben, nie von der App-Rolle
-- gelöscht; die Funde einer Suche ersetzt das Ergebnis (DELETE je Suche); das
-- Protokoll ist nur anfügend. Das Offboarding (TenantRepository.offboard)
-- räumt über die Admin-Rolle ab.
REVOKE ALL ON geraetesuche, geraetesuche_fund, geraetesuche_protokoll FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON geraetesuche TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON geraetesuche_fund TO ${appDbUser};
GRANT SELECT, INSERT ON geraetesuche_protokoll TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE geraetesuche_protokoll_id_seq TO ${appDbUser};
GRANT SELECT, DELETE ON geraetesuche, geraetesuche_fund, geraetesuche_protokoll TO ${adminDbUser};
