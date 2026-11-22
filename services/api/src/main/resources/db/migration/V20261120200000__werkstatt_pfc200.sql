-- =============================================================================
-- Werkstatt: der WAGO PFC200 (Edge Industrie) als zweites Gerät neben der Mango
-- (PFC200-Konzept Stufe 3, Teilstufe 2b).
--
-- werkstatt_freigabe: Eine Freigabe gilt für ein Gerät (box_art mango oder
--   pfc200). Der PFC200 hat kein OpenWrt-Abbild (die Firmware des Geräts fasst
--   die Werkstatt nicht an): Die Spalten openwrt_* sind für ihn leer, für die
--   Mango bleiben sie Pflicht. Seine Fassung kommt aus der Linie
--   edge-industrie-JJJJ.MM.N, und zu Programm und Skriptstand kommt die
--   Prüfsumme des Tunnel-Programms (edge_wartung_sha256): Es läuft auf dem
--   Gerät als root. Für die Mango bleibt die Spalte leer.
-- werkstatt_box: die Box-Art edge-industrie im Register.
-- werkstatt_abnahme: angaben - was an der Abnahme steht, ohne eine Prüfung zu
--   sein (Bestellnummer, Firmware, Seriennummer des PFC200).
--
-- Anhalten und Fortsetzen (werkstatt_betrieb) bleibt EIN Schalter für die
-- ganze Werkstatt, geführt unter box_art mango; die Tabelle ändert sich nicht.
--
-- Alle Prüfungen sind auf dem aktuellen Schema neu aufgebaut (V20261102120000,
-- V20261116150000, V20261026200000, V20261102170100); wiederholbar.
-- =============================================================================

ALTER TABLE werkstatt_freigabe ADD COLUMN IF NOT EXISTS edge_wartung_sha256 TEXT;
ALTER TABLE werkstatt_freigabe ALTER COLUMN openwrt_fassung DROP NOT NULL;
ALTER TABLE werkstatt_freigabe ALTER COLUMN openwrt_datei DROP NOT NULL;
ALTER TABLE werkstatt_freigabe ALTER COLUMN openwrt_sha256 DROP NOT NULL;
ALTER TABLE werkstatt_freigabe ALTER COLUMN openwrt_quelle DROP NOT NULL;

ALTER TABLE werkstatt_freigabe DROP CONSTRAINT IF EXISTS werkstatt_freigabe_box_art_chk;
ALTER TABLE werkstatt_freigabe ADD CONSTRAINT werkstatt_freigabe_box_art_chk CHECK (box_art IN ('mango', 'pfc200'));

-- Mit "IS NOT NULL" ausgeschrieben: Ein Muster gegen NULL ergibt NULL, und eine
-- Prüfung, die NULL ergibt, gilt als bestanden.
ALTER TABLE werkstatt_freigabe DROP CONSTRAINT IF EXISTS werkstatt_freigabe_openwrt_chk;
ALTER TABLE werkstatt_freigabe ADD CONSTRAINT werkstatt_freigabe_openwrt_chk CHECK (
    (box_art = 'mango'
        AND openwrt_fassung IS NOT NULL AND openwrt_datei IS NOT NULL
        AND openwrt_sha256 IS NOT NULL AND openwrt_quelle IS NOT NULL
        AND openwrt_fassung ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]+$'
        AND openwrt_datei ~ '^[A-Za-z0-9._-]+-sysupgrade\.bin$'
        AND openwrt_sha256 ~ '^[0-9a-f]{64}$'
        AND openwrt_quelle ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$')
    OR (box_art = 'pfc200'
        AND openwrt_fassung IS NULL AND openwrt_datei IS NULL
        AND openwrt_sha256 IS NULL AND openwrt_quelle IS NULL));

ALTER TABLE werkstatt_freigabe DROP CONSTRAINT IF EXISTS werkstatt_freigabe_edge_chk;
ALTER TABLE werkstatt_freigabe ADD CONSTRAINT werkstatt_freigabe_edge_chk CHECK (
    edge_programm_sha256 ~ '^[0-9a-f]{64}$'
    AND edge_skripte_sha256 ~ '^[0-9a-f]{64}$'
    AND edge_quelle ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$'
    AND ((box_art = 'mango'
            AND edge_fassung ~ '^edge-light-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$'
            AND edge_wartung_sha256 IS NULL)
        OR (box_art = 'pfc200'
            AND edge_fassung ~ '^edge-industrie-[0-9]{4}\.(0[1-9]|1[0-2])\.(0|[1-9][0-9]*)$'
            AND edge_wartung_sha256 IS NOT NULL
            AND edge_wartung_sha256 ~ '^[0-9a-f]{64}$')));

-- Eine Freigabe wird nicht umgeschrieben und nicht gelöscht; erlaubt bleibt
-- genau ein Schritt, das Ende zu setzen. Die neue Spalte gehört zum Inhalt.
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
        NEW.edge_wartung_sha256,
        NEW.notiz, NEW.erteilt_am, NEW.erteilt_von, NEW.erteilt_von_name, NEW.quelle, NEW.edge_release_seq)
       IS DISTINCT FROM
       (OLD.id, OLD.kennung, OLD.box_art, OLD.gueltig_ab, OLD.gueltig_bis, OLD.obergrenze,
        OLD.openwrt_fassung, OLD.openwrt_datei, OLD.openwrt_sha256, OLD.openwrt_quelle,
        OLD.edge_fassung, OLD.edge_quelle, OLD.edge_programm_sha256, OLD.edge_skripte_sha256,
        OLD.edge_wartung_sha256,
        OLD.notiz, OLD.erteilt_am, OLD.erteilt_von, OLD.erteilt_von_name, OLD.quelle, OLD.edge_release_seq) THEN
        RAISE EXCEPTION 'werkstatt_freigabe: an einer Freigabe ändert sich nur ihr Ende';
    END IF;
    RETURN NEW;
END;
$$;

ALTER TABLE werkstatt_box DROP CONSTRAINT IF EXISTS werkstatt_box_art_chk;
ALTER TABLE werkstatt_box ADD CONSTRAINT werkstatt_box_art_chk
    CHECK (box_art IN ('edge-light', 'edge-app', 'edge-industrie'));

ALTER TABLE werkstatt_abnahme ADD COLUMN IF NOT EXISTS angaben JSONB;
ALTER TABLE werkstatt_abnahme DROP CONSTRAINT IF EXISTS werkstatt_abnahme_angaben_chk;
ALTER TABLE werkstatt_abnahme ADD CONSTRAINT werkstatt_abnahme_angaben_chk
    CHECK (angaben IS NULL OR (jsonb_typeof(angaben) = 'object' AND length(angaben::text) <= 2000));
