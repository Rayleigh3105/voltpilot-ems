-- MiSpeL MP-25: das Ergebnis des Rechenwerks der Pauschaloption je Anlage und
-- (Rumpf-)Jahr (Anlage 2 der Festlegung zur Marktintegration von Speichern und
-- Ladepunkten, BNetzA, Beschluss 01.10.2026). Vertrag:
-- docs/contracts/v2/mispel-pauschal.md; Rechenwerk: mispel/MispelPauschalRechenwerk.
-- Erst ab der EU-Genehmigung anwendbar (Tenorziffer 9 b): bis dahin Vorbau (E7 = B).
--
-- Muster wie mispel_abgrenzung_monat (MP-8, V20261002153700): JEDE ZEILE IST EIN
-- LAUF, der Nachweis-Datensatz steht als kanonischer JSON-TEXT in `nachweis`,
-- die Prüfsumme ist SHA-256 über genau diese Bytes (bewusst `text`, nicht
-- `jsonb`). Ein neuer Lauf mit anderem Ergebnis hängt eine neue Fassung an; ein
-- Lauf mit gleicher Prüfsumme schreibt nichts. Überschrieben wird nie.
--
-- Bezugszeitraum ist das Kalenderjahr oder ein Rumpfjahr an seiner Stelle
-- (A2 S. 51–53, Abschn. 9): ganze Kalendertage `tag_von` bis `tag_bis`
-- EINSCHLIESSLICH, in einem Kalenderjahr; `zeitraum_von`/`zeitraum_bis` ist
-- derselbe Zeitraum als [von, bis) in gesetzlicher Zeit. `stand` wie MP-8
-- (E4 = C): `endgueltig` nur auf Werten des Messstellenbetreibers, vollständig.
--
-- Keine Bestandszeile ändert sich; die Tabelle beginnt leer.
CREATE TABLE IF NOT EXISTS mispel_pauschal_jahr (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID        NOT NULL,
    site_id                  UUID        NOT NULL,
    jahr                     INTEGER     NOT NULL,
    tag_von                  DATE        NOT NULL,
    tag_bis                  DATE        NOT NULL,
    zeitraum_von             TIMESTAMPTZ NOT NULL,
    zeitraum_bis             TIMESTAMPTZ NOT NULL,
    fassung                  INTEGER     NOT NULL,
    formelsatz               TEXT        NOT NULL,
    stand                    TEXT        NOT NULL,
    wertequelle              TEXT        NOT NULL,
    viertelstunden_erwartet  INTEGER     NOT NULL,
    viertelstunden_gerechnet INTEGER     NOT NULL,
    rechenwerk_version       TEXT        NOT NULL,
    vertrag_version          TEXT        NOT NULL,
    nachweis                 TEXT        NOT NULL,
    pruefsumme               TEXT        NOT NULL,
    gerechnet_am             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mispel_pauschal_jahr_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT mispel_pauschal_jahr_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    -- Ein Rumpfjahr liegt in seinem Kalenderjahr (A2 S. 53, TR).
    CONSTRAINT mispel_pauschal_jahr_tage_chk CHECK (tag_von <= tag_bis
        AND EXTRACT(YEAR FROM tag_von) = jahr AND EXTRACT(YEAR FROM tag_bis) = jahr),
    CONSTRAINT mispel_pauschal_jahr_zeitraum_chk CHECK (zeitraum_von < zeitraum_bis),
    CONSTRAINT mispel_pauschal_jahr_fassung_chk CHECK (fassung >= 1),
    -- Das geschlossene Vokabular von MispelPauschalRechenwerk.FORMELSAETZE.
    CONSTRAINT mispel_pauschal_jahr_formelsatz_chk
        CHECK (formelsatz IN ('P1', 'P2', 'P3', 'P4', 'P4-Variante', 'P5')),
    CONSTRAINT mispel_pauschal_jahr_stand_chk CHECK (stand IN ('vorlaeufig', 'endgueltig')),
    CONSTRAINT mispel_pauschal_jahr_wertequelle_chk
        CHECK (wertequelle IN ('messstellenbetreiber', 'geraet')),
    -- Endgültig nur auf Werten des Messstellenbetreibers und ohne Lücke (E4 = C).
    CONSTRAINT mispel_pauschal_jahr_endgueltig_chk CHECK (stand = 'vorlaeufig'
        OR (wertequelle = 'messstellenbetreiber' AND viertelstunden_gerechnet = viertelstunden_erwartet)),
    CONSTRAINT mispel_pauschal_jahr_viertelstunden_chk
        CHECK (viertelstunden_gerechnet >= 0 AND viertelstunden_gerechnet <= viertelstunden_erwartet),
    CONSTRAINT mispel_pauschal_jahr_pruefsumme_chk CHECK (pruefsumme ~ '^[0-9a-f]{64}$'),
    CONSTRAINT mispel_pauschal_jahr_fassung_uq UNIQUE (tenant_id, site_id, tag_von, fassung)
);
CREATE INDEX IF NOT EXISTS idx_mispel_pauschal_jahr_site
    ON mispel_pauschal_jahr (tenant_id, site_id, jahr, fassung);
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE mispel_pauschal_jahr ENABLE ROW LEVEL SECURITY;
ALTER TABLE mispel_pauschal_jahr FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mispel_pauschal_jahr_tenant_isolation ON mispel_pauschal_jahr;
CREATE POLICY mispel_pauschal_jahr_tenant_isolation ON mispel_pauschal_jahr
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Lesen und anhängen; nur das administrative Offboarding löscht.
REVOKE ALL ON mispel_pauschal_jahr FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON mispel_pauschal_jahr TO ${appDbUser};
GRANT SELECT, DELETE ON mispel_pauschal_jahr TO ${adminDbUser};
COMMENT ON TABLE mispel_pauschal_jahr IS
    'MiSpeL MP-25: Lauf des Rechenwerks der Pauschaloption je Anlage und (Rumpf-)Jahr, mit Nachweis und Prüfsumme.';
