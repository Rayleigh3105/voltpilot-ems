-- =============================================================================
-- Direktvermarktung Stufe 5 "Werkstatt und Feld" (Konzept
-- vp-direktvermarktung-konzept d2, E5=A, PS-D10): der Paket-Anhang
-- edge-light-pakete.tar.gz eines Edge-Light-Release (OpenVPN samt
-- Abhaengigkeiten, Pins edge-light/openwrt/pakete.json) liegt im Portal und
-- ist offen abrufbar wie die Programme (edge_light_programm, V20261104160000).
-- Feldboxen laden ihn beim Update und pruefen ihn gegen die Pruefsumme aus
-- ihrem signierten Manifest; die Werkstatt laedt ihn von der Release-Quelle.
--
-- EIN Anhang je Release (kein arch: die Pakete gehoeren zum OpenWrt-Abbild
-- der Werkstatt, nicht zur Programm-Plattform). Pruefsumme und Groesse kommen
-- beim ersten Teil aus dem signierten Manifest, nie vom Hochladenden.
-- werkstatt_freigabe bleibt unveraendert: Der Werkstatt-Dienst nimmt die
-- Pruefsumme allein aus dem signierten Manifest, das er ohnehin
-- kryptographisch prueft.
--
-- Plattform-Betriebsdatum, kein Kundendatum: die App-Rolle liest und schreibt
-- nicht (Zugriff ueber die Admin-Verbindung).
-- =============================================================================

CREATE TABLE IF NOT EXISTS edge_light_pakete (
    release_seq BIGINT      NOT NULL REFERENCES edge_release (release_seq) ON DELETE CASCADE,
    sha256      TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    groesse     BIGINT      NOT NULL CHECK (groesse > 0),
    daten       BYTEA       NOT NULL DEFAULT ''::bytea,
    fertig_am   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  TEXT,
    PRIMARY KEY (release_seq),
    CHECK (fertig_am IS NULL OR octet_length(daten) = groesse)
);

CREATE INDEX IF NOT EXISTS edge_light_pakete_fertig_sha
    ON edge_light_pakete (sha256) WHERE fertig_am IS NOT NULL;

REVOKE ALL ON edge_light_pakete FROM ${appDbUser};
