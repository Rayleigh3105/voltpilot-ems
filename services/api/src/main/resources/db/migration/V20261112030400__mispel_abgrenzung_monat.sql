-- MiSpeL MP-8: das Ergebnis des Rechenwerks der Abgrenzungsoption je Anlage und
-- (Rumpf-)Monat (Anlage 1 der Festlegung zur Marktintegration von Speichern und
-- Ladepunkten, BNetzA, Beschluss 01.10.2026). Vertrag:
-- docs/contracts/v2/mispel-abgrenzung.md; Rechenwerk: mispel/MispelAbgrenzungRechenwerk.
--
-- JEDE ZEILE IST EIN LAUF: der Nachweis-Datensatz (Eingänge je Viertelstunde,
-- Zwischenwerte, Monatswerte, Version, Zähler, AW-Herkunft, Lücken) steht als
-- kanonischer JSON-TEXT in `nachweis`, die Prüfsumme ist SHA-256 über genau
-- diese Bytes. Bewusst `text`, nicht `jsonb`: jsonb ordnet Schlüssel um und
-- bricht die Prüfsumme. Ein neuer Lauf mit anderem Ergebnis hängt eine neue
-- Fassung an; ein Lauf mit gleicher Prüfsumme schreibt nichts. Überschrieben
-- wird nie.
--
-- `stand` (Entscheid E4 = C, Bauplan § 8.5): `vorlaeufig` auf Gerätewerten oder
-- mit Lücken, Rückfall-AW, offenen Viertelstunden; `endgueltig` nur auf
-- Werten des Messstellenbetreibers, mess- und eichrechtskonform (Tenor S. 28,
-- § 21 Abs. 4 S. 2 EnFG), vollständig. `wertequelle` hält fest, woher die
-- Zählerwerte des Laufs kommen — `geraet`, sobald auch nur ein Zähler vom Gerät
-- liest.
--
-- Keine Bestandszeile ändert sich; die Tabelle beginnt leer.
CREATE TABLE IF NOT EXISTS mispel_abgrenzung_monat (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID        NOT NULL,
    site_id                  UUID        NOT NULL,
    -- Der Kalendermonat (erster Tag) und der gerechnete Zeitraum [von, bis):
    -- der ganze Monat oder ein Rumpfmonat (A1 S. 102, Abschn. 11).
    monat                    DATE        NOT NULL,
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
    CONSTRAINT mispel_abgrenzung_monat_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT mispel_abgrenzung_monat_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT mispel_abgrenzung_monat_monat_chk CHECK (EXTRACT(DAY FROM monat) = 1),
    CONSTRAINT mispel_abgrenzung_monat_zeitraum_chk CHECK (zeitraum_von < zeitraum_bis),
    CONSTRAINT mispel_abgrenzung_monat_fassung_chk CHECK (fassung >= 1),
    -- Das geschlossene Vokabular von MispelAbgrenzungRechenwerk.FORMELSAETZE (E5 = B).
    CONSTRAINT mispel_abgrenzung_monat_formelsatz_chk
        CHECK (formelsatz IN ('A1', 'A5', 'A5-Variante', 'A10', 'A11')),
    CONSTRAINT mispel_abgrenzung_monat_stand_chk CHECK (stand IN ('vorlaeufig', 'endgueltig')),
    CONSTRAINT mispel_abgrenzung_monat_wertequelle_chk
        CHECK (wertequelle IN ('messstellenbetreiber', 'geraet')),
    -- Endgültig nur auf Werten des Messstellenbetreibers und ohne Lücke (E4 = C).
    CONSTRAINT mispel_abgrenzung_monat_endgueltig_chk CHECK (stand = 'vorlaeufig'
        OR (wertequelle = 'messstellenbetreiber' AND viertelstunden_gerechnet = viertelstunden_erwartet)),
    CONSTRAINT mispel_abgrenzung_monat_viertelstunden_chk
        CHECK (viertelstunden_gerechnet >= 0 AND viertelstunden_gerechnet <= viertelstunden_erwartet),
    CONSTRAINT mispel_abgrenzung_monat_pruefsumme_chk CHECK (pruefsumme ~ '^[0-9a-f]{64}$'),
    CONSTRAINT mispel_abgrenzung_monat_fassung_uq UNIQUE (tenant_id, site_id, zeitraum_von, fassung)
);
CREATE INDEX IF NOT EXISTS idx_mispel_abgrenzung_monat_site
    ON mispel_abgrenzung_monat (tenant_id, site_id, monat, fassung);
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE mispel_abgrenzung_monat ENABLE ROW LEVEL SECURITY;
ALTER TABLE mispel_abgrenzung_monat FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mispel_abgrenzung_monat_tenant_isolation ON mispel_abgrenzung_monat;
CREATE POLICY mispel_abgrenzung_monat_tenant_isolation ON mispel_abgrenzung_monat
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Lesen und anhängen; nur das administrative Offboarding löscht.
REVOKE ALL ON mispel_abgrenzung_monat FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON mispel_abgrenzung_monat TO ${appDbUser};
GRANT SELECT, DELETE ON mispel_abgrenzung_monat TO ${adminDbUser};
COMMENT ON TABLE mispel_abgrenzung_monat IS
    'MiSpeL MP-8: Lauf des Rechenwerks der Abgrenzungsoption je Anlage und (Rumpf-)Monat, mit Nachweis und Prüfsumme.';
