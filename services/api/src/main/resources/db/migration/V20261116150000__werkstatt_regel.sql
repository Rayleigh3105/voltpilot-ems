-- =============================================================================
-- Die Werkstatt nimmt immer die neueste Fassung (Auftrag vp-werkstatt-immer-
-- neueste, Entscheid des Captains 16.11.2026: A). Kein Formular mehr: Die
-- Werkstatt läuft, bis jemand sie anhält.
--
-- werkstatt_freigabe bleibt die Zeile, an der Code, Einlösung und Abnahme
-- hängen (Beleg: welche Fassungen mit welchen Prüfsummen). Neu legt sie die
-- Regel selbst an (quelle = 'regel'): je Berliner Tag und Inhalt eine Zeile,
-- Edge Light aus dem signierten Manifest der neuesten zuweisbaren Fassung
-- (edge_release_seq), OpenWrt fest im Code. Die Zeilen von Hand (quelle =
-- 'formular', bis 16.11.2026) bleiben lesbar, wie sie sind.
--
-- werkstatt_betrieb ist das Protokoll von „Werkstatt anhalten“ und „Werkstatt
-- fortsetzen“: wer, wann, warum. Der Stand ist die jüngste Zeile; ohne Zeile
-- läuft die Werkstatt. Nur anhängen, nie ändern.
--
-- Globale Betriebsdaten ohne Mandant wie werkstatt_freigabe (V20261102120000):
-- keine Rechte für die App-Rolle, RLS mit FORCE und ohne Policy als zweiter
-- Riegel, gelesen und geschrieben nur über die BYPASSRLS-Rolle voltpilot_admin.
-- =============================================================================

ALTER TABLE werkstatt_freigabe ADD COLUMN IF NOT EXISTS quelle TEXT NOT NULL DEFAULT 'formular';
ALTER TABLE werkstatt_freigabe ADD COLUMN IF NOT EXISTS edge_release_seq BIGINT;

ALTER TABLE werkstatt_freigabe DROP CONSTRAINT IF EXISTS werkstatt_freigabe_quelle_chk;
ALTER TABLE werkstatt_freigabe ADD CONSTRAINT werkstatt_freigabe_quelle_chk CHECK (
    quelle IN ('formular', 'regel') AND (quelle = 'formular' OR edge_release_seq IS NOT NULL));

-- Die Regel sucht je Tag die Zeile ihres Inhalts.
CREATE INDEX IF NOT EXISTS idx_werkstatt_freigabe_regel
    ON werkstatt_freigabe (box_art, gueltig_ab DESC) WHERE quelle = 'regel';

-- An einer Freigabe ändert sich weiter nur ihr Ende; Herkunft und Release
-- gehören zum Beleg und sind festgeschrieben wie alles andere.
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
        NEW.notiz, NEW.erteilt_am, NEW.erteilt_von, NEW.erteilt_von_name, NEW.quelle, NEW.edge_release_seq)
       IS DISTINCT FROM
       (OLD.id, OLD.kennung, OLD.box_art, OLD.gueltig_ab, OLD.gueltig_bis, OLD.obergrenze,
        OLD.openwrt_fassung, OLD.openwrt_datei, OLD.openwrt_sha256, OLD.openwrt_quelle,
        OLD.edge_fassung, OLD.edge_quelle, OLD.edge_programm_sha256, OLD.edge_skripte_sha256,
        OLD.notiz, OLD.erteilt_am, OLD.erteilt_von, OLD.erteilt_von_name, OLD.quelle, OLD.edge_release_seq) THEN
        RAISE EXCEPTION 'werkstatt_freigabe: an einer Freigabe ändert sich nur ihr Ende';
    END IF;
    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- Anhalten und Fortsetzen
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS werkstatt_betrieb (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    box_art     TEXT        NOT NULL,
    angehalten  BOOLEAN     NOT NULL,
    grund       TEXT,
    am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    von         TEXT        NOT NULL,
    von_name    TEXT,
    CONSTRAINT werkstatt_betrieb_box_art_chk CHECK (box_art IN ('mango')),
    CONSTRAINT werkstatt_betrieb_grund_chk CHECK (grund IS NULL OR length(grund) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_werkstatt_betrieb_box_art ON werkstatt_betrieb (box_art, am DESC);

CREATE OR REPLACE FUNCTION werkstatt_betrieb_nur_anhaengen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'werkstatt_betrieb: das Protokoll wird nur fortgeschrieben';
END;
$$;

DROP TRIGGER IF EXISTS werkstatt_betrieb_nur_anhaengen ON werkstatt_betrieb;
CREATE TRIGGER werkstatt_betrieb_nur_anhaengen BEFORE UPDATE OR DELETE ON werkstatt_betrieb
    FOR EACH ROW EXECUTE FUNCTION werkstatt_betrieb_nur_anhaengen();

REVOKE ALL ON werkstatt_betrieb FROM ${appDbUser};
REVOKE ALL ON werkstatt_betrieb FROM ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_betrieb TO ${adminDbUser};

ALTER TABLE werkstatt_betrieb ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_betrieb FORCE ROW LEVEL SECURITY;
