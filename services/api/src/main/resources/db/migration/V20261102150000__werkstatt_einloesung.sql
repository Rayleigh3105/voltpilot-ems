-- =============================================================================
-- Werkstatt-Automatik V1, Paket P6b: Einmal-Code, Einlösen und der
-- festgehaltene Geräteschlüssel (D2), Konzept §7.
--
-- werkstatt_code: Der Werkstatt-Dienst holt in einer laufenden Freigabe für
-- genau eine ungekoppelte Referenz einen Code. Die API speichert nur seinen
-- sha256; er gilt höchstens 30 Minuten und einmal. Ein neuer Code für dieselbe
-- Referenz ersetzt den offenen.
--
-- werkstatt_einloesung: Die Box löst den Code selbst ein (ohne Konto, mit
-- ihrem Geräteschlüssel signiert). Eine Zeile je Einlösung, nie geändert und
-- nie gelöscht: was die Box gemeldet hat (Geräteschlüssel, Tunnel-Schlüssel,
-- Host-Schlüssel, Fassung), welche Adresse sie bekam und welches Probe-Fenster
-- die Einlösung geöffnet hat.
--
-- werkstatt_geraeteschluessel: der festgehaltene Geräteschlüssel je Referenz
-- (D2). Danach nimmt die Zertifikatsanfrage nur noch genau diesen Schlüssel an,
-- und ausgestellt wird nur dafür. Ein Tausch ersetzt ihn nur mit einem Code,
-- der ausdrücklich als Tausch geholt wurde, und nur solange die Box ungekoppelt
-- ist. Boxen ohne Zeile verhalten sich wie bisher.
--
-- Globale Betriebsdaten ohne Mandant wie werkstatt_box (V20261026200000):
-- keine Rechte für die App-Rolle, RLS mit FORCE und ohne Policy, gelesen und
-- geschrieben nur über die BYPASSRLS-Rolle voltpilot_admin. Kein Geheimnis in
-- diesen Tabellen: Codes nur als Hash, Schlüssel nur öffentlich.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_code (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    freigabe_id     UUID        NOT NULL REFERENCES werkstatt_freigabe (id),
    edge_ref        TEXT        NOT NULL,
    code_sha256     TEXT        NOT NULL UNIQUE,
    tausch          BOOLEAN     NOT NULL DEFAULT false,
    ausgegeben_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    gueltig_bis     TIMESTAMPTZ NOT NULL,
    ausgegeben_von  TEXT        NOT NULL,
    ersetzt_am      TIMESTAMPTZ,
    eingeloest_am   TIMESTAMPTZ,
    CONSTRAINT werkstatt_code_ref_chk CHECK (edge_ref ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
    CONSTRAINT werkstatt_code_sha_chk CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT werkstatt_code_zeit_chk CHECK (gueltig_bis > ausgegeben_am
        AND gueltig_bis <= ausgegeben_am + INTERVAL '30 minutes'),
    CONSTRAINT werkstatt_code_ende_chk CHECK (ersetzt_am IS NULL OR eingeloest_am IS NULL)
);

-- Je Referenz höchstens ein offener Code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_werkstatt_code_offen
    ON werkstatt_code (edge_ref) WHERE ersetzt_am IS NULL AND eingeloest_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_werkstatt_code_freigabe ON werkstatt_code (freigabe_id);

CREATE TABLE IF NOT EXISTS werkstatt_einloesung (
    id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    code_id                    UUID        NOT NULL UNIQUE REFERENCES werkstatt_code (id),
    freigabe_id                UUID        NOT NULL REFERENCES werkstatt_freigabe (id),
    edge_ref                   TEXT        NOT NULL,
    fassung                    TEXT        NOT NULL,
    geraete_schluessel         TEXT        NOT NULL,
    geraete_schluessel_sha256  TEXT        NOT NULL,
    wireguard_schluessel       TEXT        NOT NULL,
    host_schluessel            TEXT        NOT NULL,
    tunnel_adresse             TEXT        NOT NULL,
    fenster_id                 UUID        NOT NULL REFERENCES fernwartung_fenster (id),
    tausch                     BOOLEAN     NOT NULL,
    eingeloest_am              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT werkstatt_einloesung_sha_chk CHECK (geraete_schluessel_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT werkstatt_einloesung_host_chk CHECK (host_schluessel ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
    CONSTRAINT werkstatt_einloesung_fassung_chk CHECK (length(fassung) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_einloesung_ref ON werkstatt_einloesung (edge_ref, eingeloest_am DESC);
CREATE INDEX IF NOT EXISTS idx_werkstatt_einloesung_freigabe ON werkstatt_einloesung (freigabe_id);

CREATE TABLE IF NOT EXISTS werkstatt_geraeteschluessel (
    edge_ref                   TEXT        PRIMARY KEY,
    geraete_schluessel         TEXT        NOT NULL,
    geraete_schluessel_sha256  TEXT        NOT NULL,
    einloesung_id              UUID        NOT NULL REFERENCES werkstatt_einloesung (id),
    festgehalten_am            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT werkstatt_geraeteschluessel_sha_chk CHECK (geraete_schluessel_sha256 ~ '^[0-9a-f]{64}$')
);

-- Eine Einlösung bleibt, wie sie war.
CREATE OR REPLACE FUNCTION werkstatt_einloesung_unveraenderlich() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'werkstatt_einloesung: eine Einlösung wird weder geändert noch gelöscht';
END;
$$;

DROP TRIGGER IF EXISTS werkstatt_einloesung_unveraenderlich ON werkstatt_einloesung;
CREATE TRIGGER werkstatt_einloesung_unveraenderlich BEFORE UPDATE OR DELETE ON werkstatt_einloesung
    FOR EACH ROW EXECUTE FUNCTION werkstatt_einloesung_unveraenderlich();

-- -----------------------------------------------------------------------------
-- Rechte: die App-Rolle bekommt nichts. Die Admin-Rolle legt an und setzt an
-- einem Code nur das Ende; einen festgehaltenen Schlüssel ersetzt sie nur über
-- einen Tausch (UPDATE), gelöscht wird nichts.
-- -----------------------------------------------------------------------------
REVOKE ALL ON werkstatt_code FROM ${appDbUser};
REVOKE ALL ON werkstatt_code FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_code TO ${adminDbUser};

REVOKE ALL ON werkstatt_einloesung FROM ${appDbUser};
REVOKE ALL ON werkstatt_einloesung FROM ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_einloesung TO ${adminDbUser};

REVOKE ALL ON werkstatt_geraeteschluessel FROM ${appDbUser};
REVOKE ALL ON werkstatt_geraeteschluessel FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_geraeteschluessel TO ${adminDbUser};

ALTER TABLE werkstatt_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_code FORCE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_einloesung ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_einloesung FORCE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_geraeteschluessel ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_geraeteschluessel FORCE ROW LEVEL SECURITY;
