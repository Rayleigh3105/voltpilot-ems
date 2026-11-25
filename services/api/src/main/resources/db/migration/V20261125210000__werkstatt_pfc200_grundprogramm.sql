-- =============================================================================
-- Werkstatt: das Grundprogramm des PFC200 (Boot-Applikation des Basisprojekts
-- auf der SPS, Captain's Intent vom 25.11.2026, Konzept vp-pfc200-edge-konzept
-- Abschnitt 6.7).
--
-- werkstatt_freigabe: anders als edge_wartung_sha256 ist edge_grundprogramm_sha256
--   OPTIONAL, auch fuer den PFC200: Das Basisprojekt aendert sich nur, wenn der
--   Captain ein neues CODESYS-Projekt uebergibt, nicht mit jeder
--   Edge-Industrie-Fassung. Fuer die Mango bleibt die Spalte leer (wie
--   edge_wartung_sha256).
--
-- Alle Pruefungen sind auf dem aktuellen Schema neu aufgebaut (V20261102120000,
-- V20261116150000, V20261026200000, V20261102170100, V20261120200000);
-- wiederholbar.
-- =============================================================================

ALTER TABLE werkstatt_freigabe ADD COLUMN IF NOT EXISTS edge_grundprogramm_sha256 TEXT;

ALTER TABLE werkstatt_freigabe DROP CONSTRAINT IF EXISTS werkstatt_freigabe_edge_chk;
ALTER TABLE werkstatt_freigabe ADD CONSTRAINT werkstatt_freigabe_edge_chk CHECK (
    edge_programm_sha256 ~ '^[0-9a-f]{64}$'
    AND edge_skripte_sha256 ~ '^[0-9a-f]{64}$'
    AND edge_quelle ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$'
    AND ((box_art = 'mango'
            AND edge_fassung ~ '^edge-light-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$'
            AND edge_wartung_sha256 IS NULL
            AND edge_grundprogramm_sha256 IS NULL)
        OR (box_art = 'pfc200'
            AND edge_fassung ~ '^edge-industrie-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$'
            AND edge_wartung_sha256 IS NOT NULL
            AND edge_wartung_sha256 ~ '^[0-9a-f]{64}$'
            AND (edge_grundprogramm_sha256 IS NULL OR edge_grundprogramm_sha256 ~ '^[0-9a-f]{64}$'))));

-- Die Spur "an einer Freigabe aendert sich nur ihr Ende" (werkstatt_freigabe_nur_ende,
-- V20261102120000) muss die neue Spalte mitvergleichen, sonst koennte sie
-- unbemerkt an einer schon erteilten Freigabe wechseln.
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
        NEW.edge_wartung_sha256, NEW.edge_grundprogramm_sha256,
        NEW.notiz, NEW.erteilt_am, NEW.erteilt_von, NEW.erteilt_von_name, NEW.quelle, NEW.edge_release_seq)
       IS DISTINCT FROM
       (OLD.id, OLD.kennung, OLD.box_art, OLD.gueltig_ab, OLD.gueltig_bis, OLD.obergrenze,
        OLD.openwrt_fassung, OLD.openwrt_datei, OLD.openwrt_sha256, OLD.openwrt_quelle,
        OLD.edge_fassung, OLD.edge_quelle, OLD.edge_programm_sha256, OLD.edge_skripte_sha256,
        OLD.edge_wartung_sha256, OLD.edge_grundprogramm_sha256,
        OLD.notiz, OLD.erteilt_am, OLD.erteilt_von, OLD.erteilt_von_name, OLD.quelle, OLD.edge_release_seq) THEN
        RAISE EXCEPTION 'werkstatt_freigabe: an einer Freigabe ändert sich nur ihr Ende';
    END IF;
    RETURN NEW;
END;
$$;
