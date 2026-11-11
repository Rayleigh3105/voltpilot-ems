-- =============================================================================
-- Werkstatt-Automatik V1, Paket P6: die Freigabe der Werkstatt in der API
-- (Entscheide WI-4 A und WI-9 A vom 02.11.2026).
--
-- Eine Freigabe ist das Okay eines VoltPilot-Admins, dass der Werkstatt-Dienst
-- Boxen einrichten darf: welche Fassungen (OpenWrt-Abbild, Edge-Light-Programm,
-- Skriptstand, je mit Prüfsumme) und bis wann. Sie gilt für jede Box, die in
-- der Zeit eingesteckt wird; die Obergrenze ist nur ein Schutz. Das LAN-Netz
-- der Boxen ist Konfiguration des Dienstes (VP_WERKSTATT_LAN_NETZ), nicht Teil
-- der Freigabe. „Werkstatt
-- freigeben“ legt eine Zeile an, „Freigabe beenden“ setzt beendet_am - sonst
-- ändert sich an einer Freigabe nichts, und keine wird gelöscht: Jede Box
-- behält, unter welcher Freigabe sie entstand.
--
-- Globale Betriebsdaten ohne Mandant wie werkstatt_box (V20261026200000):
-- keine Rechte für die App-Rolle, RLS mit FORCE und ohne Policy als zweiter
-- Riegel, gelesen und geschrieben nur über die BYPASSRLS-Rolle voltpilot_admin.
-- Kein Geheimnis in dieser Tabelle.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_freigabe (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kennung               TEXT        NOT NULL UNIQUE,
    box_art               TEXT        NOT NULL,
    gueltig_ab            TIMESTAMPTZ NOT NULL,
    gueltig_bis           TIMESTAMPTZ NOT NULL,
    obergrenze            INTEGER     NOT NULL,
    openwrt_fassung       TEXT        NOT NULL,
    openwrt_datei         TEXT        NOT NULL,
    openwrt_sha256        TEXT        NOT NULL,
    openwrt_quelle        TEXT        NOT NULL,
    edge_fassung          TEXT        NOT NULL,
    edge_quelle           TEXT        NOT NULL,
    edge_programm_sha256  TEXT        NOT NULL,
    edge_skripte_sha256   TEXT        NOT NULL,
    notiz                 TEXT,
    erteilt_am            TIMESTAMPTZ NOT NULL DEFAULT now(),
    erteilt_von           TEXT        NOT NULL,
    erteilt_von_name      TEXT,
    beendet_am            TIMESTAMPTZ,
    beendet_von           TEXT,
    beendet_von_name      TEXT,
    CONSTRAINT werkstatt_freigabe_kennung_chk CHECK (kennung ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
    -- V1 kennt nur die Mango; der Raspberry Pi kommt mit V2.
    CONSTRAINT werkstatt_freigabe_box_art_chk CHECK (box_art IN ('mango')),
    CONSTRAINT werkstatt_freigabe_zeit_chk CHECK (gueltig_bis > gueltig_ab
        AND gueltig_bis <= gueltig_ab + INTERVAL '92 days'),
    CONSTRAINT werkstatt_freigabe_obergrenze_chk CHECK (obergrenze BETWEEN 1 AND 200),
    CONSTRAINT werkstatt_freigabe_openwrt_chk CHECK (openwrt_fassung ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]+$'
        AND openwrt_datei ~ '^[A-Za-z0-9._-]+-sysupgrade\.bin$'
        AND openwrt_sha256 ~ '^[0-9a-f]{64}$'
        AND openwrt_quelle ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$'),
    CONSTRAINT werkstatt_freigabe_edge_chk CHECK (edge_fassung ~ '^edge-light-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$'
        AND edge_programm_sha256 ~ '^[0-9a-f]{64}$'
        AND edge_skripte_sha256 ~ '^[0-9a-f]{64}$'
        AND edge_quelle ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$'),
    CONSTRAINT werkstatt_freigabe_notiz_chk CHECK (notiz IS NULL OR length(notiz) <= 500),
    CONSTRAINT werkstatt_freigabe_ende_chk CHECK ((beendet_am IS NULL) = (beendet_von IS NULL)
        AND (beendet_am IS NULL OR beendet_am >= erteilt_am))
);

CREATE INDEX IF NOT EXISTS idx_werkstatt_freigabe_box_art
    ON werkstatt_freigabe (box_art, gueltig_ab DESC);

-- Eine Freigabe wird nicht umgeschrieben und nicht gelöscht. Erlaubt ist genau
-- ein Schritt: das Ende setzen, solange es noch nicht gesetzt ist.
CREATE OR REPLACE FUNCTION werkstatt_freigabe_nur_ende() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'werkstatt_freigabe: eine Freigabe wird nicht gelöscht';
    END IF;
    IF OLD.beendet_am IS NOT NULL THEN
        RAISE EXCEPTION 'werkstatt_freigabe: die Freigabe % ist schon beendet', OLD.kennung;
    END IF;
    IF (NEW.id, NEW.kennung, NEW.box_art, NEW.gueltig_ab, NEW.gueltig_bis, NEW.obergrenze,
        NEW.openwrt_fassung, NEW.openwrt_datei, NEW.openwrt_sha256, NEW.openwrt_quelle,
        NEW.edge_fassung, NEW.edge_quelle, NEW.edge_programm_sha256, NEW.edge_skripte_sha256,
        NEW.notiz, NEW.erteilt_am, NEW.erteilt_von, NEW.erteilt_von_name)
       IS DISTINCT FROM
       (OLD.id, OLD.kennung, OLD.box_art, OLD.gueltig_ab, OLD.gueltig_bis, OLD.obergrenze,
        OLD.openwrt_fassung, OLD.openwrt_datei, OLD.openwrt_sha256, OLD.openwrt_quelle,
        OLD.edge_fassung, OLD.edge_quelle, OLD.edge_programm_sha256, OLD.edge_skripte_sha256,
        OLD.notiz, OLD.erteilt_am, OLD.erteilt_von, OLD.erteilt_von_name) THEN
        RAISE EXCEPTION 'werkstatt_freigabe: an einer Freigabe ändert sich nur ihr Ende';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS werkstatt_freigabe_nur_ende ON werkstatt_freigabe;
CREATE TRIGGER werkstatt_freigabe_nur_ende BEFORE UPDATE OR DELETE ON werkstatt_freigabe
    FOR EACH ROW EXECUTE FUNCTION werkstatt_freigabe_nur_ende();

-- -----------------------------------------------------------------------------
-- Rechte: wie werkstatt_box. Die App-Rolle bekommt nichts, die Admin-Rolle
-- Lesen, Anlegen und das Ende setzen; kein DELETE.
-- -----------------------------------------------------------------------------
REVOKE ALL ON werkstatt_freigabe FROM ${appDbUser};
REVOKE ALL ON werkstatt_freigabe FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_freigabe TO ${adminDbUser};

ALTER TABLE werkstatt_freigabe ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_freigabe FORCE ROW LEVEL SECURITY;
