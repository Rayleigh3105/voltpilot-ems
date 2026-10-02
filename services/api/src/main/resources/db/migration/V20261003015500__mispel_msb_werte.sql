-- MiSpeL MP-15: Viertelstundenwerte des Messstellenbetreibers je Zählpunkt und Richtung
-- (Vertrag docs/contracts/v2/mispel-abgrenzung.md, Abschnitt „Werte des Messstellenbetreibers (MP-15)“).
--
-- Maßgeblich für Nachweis und Abrechnung sind die Werte des Messstellenbetreibers (Tenor mit
-- Begründung S. 28, Abschn. 3.2.3.2.1). Sie kommen als Datei an der Messstelle (später über den Partner)
-- und werden je Zählpunkt (Messlokation, Anlage 1 S. 23) und Richtung gehalten — nicht je Messstelle:
-- ein Zählerwechsel an der Messstelle bringt einen neuen Zählpunkt, die Werte des alten bleiben.
-- Eine Viertelstunde ohne Wert fehlt: unbekannt ist keine Null.
--
-- Zwei neue, leere Tabellen; keine Bestandszeile ändert sich.

CREATE TABLE IF NOT EXISTS mispel_msb_import (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    -- Die Messstelle, an der die Datei hochgeladen wurde.
    messstelle_id   UUID        NOT NULL,
    format          TEXT        NOT NULL,
    dateiname       TEXT,
    -- SHA-256 über die Bytes der Datei: dieselbe Datei ist derselbe Import.
    sha256          TEXT        NOT NULL,
    viertelstunden  INTEGER     NOT NULL,
    ersetzt         INTEGER     NOT NULL,
    von             TIMESTAMPTZ NOT NULL,
    bis             TIMESTAMPTZ NOT NULL,
    importiert_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    importiert_von  TEXT,
    CONSTRAINT mispel_msb_import_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT mispel_msb_import_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT mispel_msb_import_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT mispel_msb_import_sha_uq UNIQUE (tenant_id, sha256),
    -- Heute nur die einfache CSV; MSCONS (EDIFACT) folgt als eigenes Paket.
    CONSTRAINT mispel_msb_import_format_chk CHECK (format IN ('csv')),
    CONSTRAINT mispel_msb_import_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT mispel_msb_import_dateiname_chk CHECK (dateiname IS NULL OR char_length(dateiname) <= 200),
    CONSTRAINT mispel_msb_import_zahl_chk CHECK (viertelstunden > 0 AND ersetzt >= 0 AND ersetzt <= viertelstunden),
    CONSTRAINT mispel_msb_import_zeitraum_chk CHECK (von < bis)
);

CREATE TABLE IF NOT EXISTS mispel_msb_wert (
    tenant_id   UUID        NOT NULL,
    -- Zählpunktbezeichnung wie in messstelle_zaehlerrolle (33 Zeichen, nichts umgewandelt).
    zaehlpunkt  TEXT        NOT NULL,
    -- Bezug (OBIS 1-1:1.29.0) oder Abgabe (OBIS 1-1:2.29.0) am Zählpunkt.
    richtung    TEXT        NOT NULL,
    -- Beginn der Viertelstunde.
    beginn      TIMESTAMPTZ NOT NULL,
    kwh         NUMERIC     NOT NULL,
    -- Der Import, aus dem der geltende Wert stammt; ein späterer Import ersetzt ihn.
    import_id   UUID        NOT NULL,
    PRIMARY KEY (tenant_id, zaehlpunkt, richtung, beginn),
    CONSTRAINT mispel_msb_wert_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT mispel_msb_wert_import_fk FOREIGN KEY (import_id, tenant_id)
        REFERENCES mispel_msb_import (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT mispel_msb_wert_zaehlpunkt_chk CHECK (zaehlpunkt ~ '^DE[0-9A-Z]{31}$'),
    CONSTRAINT mispel_msb_wert_richtung_chk CHECK (richtung IN ('bezug', 'abgabe')),
    CONSTRAINT mispel_msb_wert_viertelstunde_chk CHECK (mod(extract(epoch FROM beginn)::numeric, 900) = 0),
    CONSTRAINT mispel_msb_wert_kwh_chk CHECK (kwh >= 0)
);

CREATE INDEX IF NOT EXISTS idx_mispel_msb_wert_import ON mispel_msb_wert (tenant_id, import_id);
CREATE INDEX IF NOT EXISTS idx_mispel_msb_import_messstelle
    ON mispel_msb_import (tenant_id, messstelle_id, importiert_am);

ALTER TABLE mispel_msb_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE mispel_msb_import FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mispel_msb_import_tenant_isolation ON mispel_msb_import;
CREATE POLICY mispel_msb_import_tenant_isolation ON mispel_msb_import
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE mispel_msb_wert ENABLE ROW LEVEL SECURITY;
ALTER TABLE mispel_msb_wert FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mispel_msb_wert_tenant_isolation ON mispel_msb_wert;
CREATE POLICY mispel_msb_wert_tenant_isolation ON mispel_msb_wert
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON mispel_msb_import FROM ${appDbUser}, ${adminDbUser};
REVOKE ALL ON mispel_msb_wert FROM ${appDbUser}, ${adminDbUser};
-- Ein Import wird nie geändert; ein Wert wird nur durch einen späteren Import ersetzt.
GRANT SELECT, INSERT ON mispel_msb_import TO ${appDbUser};
GRANT SELECT, INSERT ON mispel_msb_wert TO ${appDbUser};
GRANT UPDATE (kwh, import_id) ON mispel_msb_wert TO ${appDbUser};
GRANT SELECT, DELETE ON mispel_msb_import TO ${adminDbUser};
GRANT SELECT, DELETE ON mispel_msb_wert TO ${adminDbUser};

COMMENT ON TABLE mispel_msb_import IS
    'MiSpeL MP-15: eine Datei mit Viertelstundenwerten des Messstellenbetreibers, hochgeladen an der Messstelle.';
COMMENT ON TABLE mispel_msb_wert IS
    'MiSpeL MP-15: geltender Viertelstundenwert des Messstellenbetreibers je Zählpunkt und Richtung (Tenor S. 28).';
