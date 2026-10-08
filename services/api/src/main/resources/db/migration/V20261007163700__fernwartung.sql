-- =============================================================================
-- V20261007163700 - Fernwartung: der Soll-Zustand des Wartungstunnels (T1).
-- -----------------------------------------------------------------------------
-- Entscheid E5 des Kapitäns (07.10.2026): der Wartungstunnel der Boxen wird über
-- das Portal verwaltet. Das Portal führt den SOLL-Zustand, ein Tunnel-Dienst auf
-- einer eigenen VM holt ihn ab und setzt ihn auf WireGuard und nftables um
-- (services/tunnel-dienst, docs/fernwartung.md).
--
--   fernwartung_zugang      ein WireGuard-Peer auf dem Wartungsserver: eine BOX
--                           (Schlüssel entsteht auf der Box) oder ein
--                           TECHNIKER-Zugang (Schlüssel entsteht auf dem Gerät
--                           des Technikers). Beide in EINER Tabelle, damit
--                           Schlüssel und Tunnel-Adresse über beide Arten
--                           hinweg eindeutig sind: WireGuard kennt je Schlüssel
--                           genau einen Peer und je Adresse genau einen Weg.
--   fernwartung_fenster     ein Fernwartungs-Zeitfenster: Box, Techniker, Grund,
--                           Beginn, Ende; vorzeitig schließbar.
--   fernwartung_protokoll   jede Änderung, append-only an der Datenbankgrenze.
--   fernwartung_dienst_abruf  wann der Tunnel-Dienst den Soll-Stand zuletzt
--                           abgeholt hat - eine Aussage über das Abholen, NICHT
--                           über die Wirkung auf dem Server.
--
-- GLOBALE Betriebsdaten wie provisioned_device und rollout_event: eine Box hat
-- ihren Tunnel schon vor der Kopplung (Werkstatt), also kein tenant_id. O3: der
-- Kunde stimmt der Fernwartung einmal generell zu und SIEHT die Fenster nicht -
-- die App-Rolle bekommt deshalb KEIN Recht, auch kein SELECT, und RLS ohne
-- Policy ist der zweite Riegel, falls je ein GRANT durchrutscht. Geschrieben
-- wird ausschließlich über die BYPASSRLS-Rolle voltpilot_admin aus
-- platform-admin-Routen; der Tunnel-Dienst liest über dieselbe Rolle hinter
-- seiner eigenen, nur lesenden Route.
--
-- Zeilen werden nie gelöscht: eine Tunnel-Adresse bleibt ihrem Zugang, auch
-- gesperrt. Eine wiedervergebene Adresse ließe einen Techniker bei einem
-- fremden Gerät landen.
-- =============================================================================

CREATE TABLE IF NOT EXISTS fernwartung_zugang (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    art            TEXT        NOT NULL,
    edge_ref       TEXT        UNIQUE,
    name           TEXT,
    public_key     TEXT        NOT NULL UNIQUE,
    tunnel_adresse INET        NOT NULL UNIQUE,
    status         TEXT        NOT NULL DEFAULT 'aktiv',
    notiz          TEXT,
    angelegt_am    TIMESTAMPTZ NOT NULL DEFAULT now(),
    angelegt_von   TEXT        NOT NULL,
    geaendert_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_von  TEXT        NOT NULL,
    CONSTRAINT fernwartung_zugang_art_chk CHECK (art IN ('box', 'techniker')),
    CONSTRAINT fernwartung_zugang_status_chk CHECK (status IN ('aktiv', 'gesperrt')),
    -- Eine Box ist über ihre Referenz bestimmt, ein Techniker-Zugang über
    -- seinen Namen - jeweils nur die eine Art.
    CONSTRAINT fernwartung_zugang_box_ref_chk CHECK ((art = 'box') = (edge_ref IS NOT NULL)),
    CONSTRAINT fernwartung_zugang_name_chk CHECK (
        (art = 'techniker') = (name IS NOT NULL)
        AND (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 80)),
    -- Öffentlicher WireGuard-Schlüssel: 32 Byte Base64 (43 Zeichen + '=').
    -- Das vorletzte Zeichen trägt nur 4 Bit, daher die enge Klasse.
    CONSTRAINT fernwartung_zugang_key_chk CHECK (
        public_key ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'),
    -- Nur IPv4-Einzeladressen: der Server nimmt von jedem Peer genau seine
    -- eigene /32 an, darauf ruht die Firewall.
    CONSTRAINT fernwartung_zugang_adresse_chk CHECK (
        family(tunnel_adresse) = 4 AND masklen(tunnel_adresse) = 32),
    -- Ziel der zusammengesetzten Fremdschlüssel in fernwartung_fenster: ein
    -- Fenster verweist strukturell auf eine BOX und einen TECHNIKER.
    CONSTRAINT fernwartung_zugang_id_art_uq UNIQUE (id, art)
);

CREATE TABLE IF NOT EXISTS fernwartung_fenster (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    box_id               UUID        NOT NULL,
    box_art              TEXT        NOT NULL DEFAULT 'box',
    techniker_id         UUID        NOT NULL,
    techniker_art        TEXT        NOT NULL DEFAULT 'techniker',
    grund                TEXT        NOT NULL,
    beginn               TIMESTAMPTZ NOT NULL,
    ende                 TIMESTAMPTZ NOT NULL,
    geoeffnet_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    geoeffnet_von        TEXT        NOT NULL,
    geoeffnet_von_name   TEXT,
    geschlossen_am       TIMESTAMPTZ,
    geschlossen_von      TEXT,
    geschlossen_von_name TEXT,
    CONSTRAINT fernwartung_fenster_box_art_chk CHECK (box_art = 'box'),
    CONSTRAINT fernwartung_fenster_techniker_art_chk CHECK (techniker_art = 'techniker'),
    CONSTRAINT fernwartung_fenster_box_fk FOREIGN KEY (box_id, box_art)
        REFERENCES fernwartung_zugang (id, art),
    CONSTRAINT fernwartung_fenster_techniker_fk FOREIGN KEY (techniker_id, techniker_art)
        REFERENCES fernwartung_zugang (id, art),
    CONSTRAINT fernwartung_fenster_grund_chk CHECK (length(btrim(grund)) BETWEEN 3 AND 500),
    CONSTRAINT fernwartung_fenster_zeit_chk CHECK (ende > beginn),
    -- Harte Obergrenze an der Datenbankgrenze; die API begrenzt enger
    -- (voltpilot.fernwartung.max-fenster-dauer), der Tunnel-Dienst noch einmal
    -- selbst.
    CONSTRAINT fernwartung_fenster_dauer_chk CHECK (ende <= beginn + interval '7 days'),
    CONSTRAINT fernwartung_fenster_schliessen_chk CHECK (
        (geschlossen_am IS NULL) = (geschlossen_von IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_fernwartung_fenster_box
    ON fernwartung_fenster (box_id, beginn DESC);
CREATE INDEX IF NOT EXISTS idx_fernwartung_fenster_ende
    ON fernwartung_fenster (ende) WHERE geschlossen_am IS NULL;

CREATE TABLE IF NOT EXISTS fernwartung_protokoll (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    zeit         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    akteur       TEXT        NOT NULL,
    akteur_name  TEXT,
    aktion       TEXT        NOT NULL,
    box_id       UUID        REFERENCES fernwartung_zugang (id),
    techniker_id UUID        REFERENCES fernwartung_zugang (id),
    fenster_id   UUID        REFERENCES fernwartung_fenster (id),
    details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT fernwartung_protokoll_aktion_chk CHECK (aktion IN (
        'box_schluessel_hinterlegt', 'box_schluessel_getauscht',
        'box_gesperrt', 'box_entsperrt',
        'techniker_angelegt', 'techniker_gesperrt', 'techniker_entsperrt',
        'fenster_geoeffnet', 'fenster_geschlossen')),
    CONSTRAINT fernwartung_protokoll_akteur_chk CHECK (btrim(akteur) <> '')
);

CREATE INDEX IF NOT EXISTS idx_fernwartung_protokoll_zeit
    ON fernwartung_protokoll (zeit DESC);
CREATE INDEX IF NOT EXISTS idx_fernwartung_protokoll_box
    ON fernwartung_protokoll (box_id, zeit DESC);
CREATE INDEX IF NOT EXISTS idx_fernwartung_protokoll_techniker
    ON fernwartung_protokoll (techniker_id, zeit DESC);

-- Append-only an der Datenbankgrenze, nicht nur per Konvention - dieselbe
-- Funktion wie component_change_event (V20260843000000).
DROP TRIGGER IF EXISTS fernwartung_protokoll_append_only ON fernwartung_protokoll;
CREATE TRIGGER fernwartung_protokoll_append_only BEFORE UPDATE OR DELETE ON fernwartung_protokoll
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE IF NOT EXISTS fernwartung_dienst_abruf (
    dienst      TEXT        PRIMARY KEY,
    zuletzt_am  TIMESTAMPTZ NOT NULL,
    peers       INTEGER     NOT NULL,
    fenster     INTEGER     NOT NULL
);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2 und V4 vergeben per ALTER DEFAULT PRIVILEGES alles an beide Rollen. Für
-- die App-Rolle zurück auf NICHTS (O3: kein Kunden-Lesepfad), für die
-- Admin-Rolle auf das, was die Routen brauchen: kein DELETE irgendwo, am
-- Protokoll nur Anhängen und Lesen.
REVOKE ALL ON fernwartung_zugang, fernwartung_fenster, fernwartung_protokoll,
    fernwartung_dienst_abruf FROM ${appDbUser};
REVOKE ALL ON fernwartung_zugang, fernwartung_fenster, fernwartung_protokoll,
    fernwartung_dienst_abruf FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON fernwartung_zugang, fernwartung_fenster,
    fernwartung_dienst_abruf TO ${adminDbUser};
GRANT SELECT, INSERT ON fernwartung_protokoll TO ${adminDbUser};

-- Zweiter Riegel: RLS ohne Policy. Die App-Rolle sähe selbst mit einem
-- versehentlichen GRANT keine Zeile; voltpilot_admin (BYPASSRLS) ist davon
-- nicht berührt.
ALTER TABLE fernwartung_zugang ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_zugang FORCE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_fenster ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_fenster FORCE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_protokoll FORCE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_dienst_abruf ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_dienst_abruf FORCE ROW LEVEL SECURITY;
