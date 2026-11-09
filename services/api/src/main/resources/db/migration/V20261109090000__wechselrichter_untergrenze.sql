-- =============================================================================
-- Die Entladegrenze, die am Wechselrichter selbst eingestellt ist (Deye-Hybrid,
-- „Battery Low SOC“, 3P Register 117 / 1P Register 219).
--
-- Befund (Pilotanlage, 09.11.2026): der Deye entlädt nur bis 15 %, das Portal
-- zeigte „Min. Ladestand 5 %“ (Plattform-Vorgabe, weil am Speicher kein
-- `asset.soc_min_pct` steht). Die Box liest die Grenze jetzt regelmäßig als
-- Messpunkt (Takt 300 s); die API übernimmt die jüngste plausible Lesung je
-- Anlage in diese Tabelle. Wirksam ist dann das GRÖSSERE von Lesung und
-- VoltPilot-Wert (`asset.soc_min_pct`, sonst 5 %). Ohne Zeile hier bleibt alles
-- wie vorher.
--
-- Eine Zeile je Anlage (der Primärspeicher), kein Verlauf: der Wechsel steht im
-- Änderungsprotokoll der Komponente (`component_change_event`, neuer Typ
-- `wr_untergrenze_gelesen`, Werte in from_value/to_value). Die Zeile bleibt
-- stehen, wenn die Box schweigt - die letzte gültige Lesung gilt mit ihrem
-- Zeitpunkt weiter, nie ein stiller Rückfall auf 5 %.
--
-- Rein additiv: neue Tabelle, ein CHECK wird erweitert (fallend und neu
-- gesetzt, er nimmt dem alten Leser nichts weg).
-- =============================================================================

CREATE TABLE IF NOT EXISTS wechselrichter_untergrenze (
    site_id                   UUID PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id                 UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    -- Die Speicher-Komponente (battery-hybrid) und die Box, die sie liest.
    entity_id                 UUID NOT NULL,
    device_id                 UUID NOT NULL,
    point_key                 TEXT NOT NULL,
    -- Die übernommene Grenze in % und wann sie zuletzt gültig gelesen wurde.
    soc_min_pct               NUMERIC(5,2) NOT NULL CHECK (soc_min_pct >= 0 AND soc_min_pct <= 100),
    gelesen_am                TIMESTAMPTZ NOT NULL,
    -- Seit wann dieser Wert gilt (erste Lesung mit genau diesem Wert).
    seit                      TIMESTAMPTZ NOT NULL,
    -- Die jüngste Lesung überhaupt - auch eine, die nicht übernommen wurde.
    letzte_lesung_am          TIMESTAMPTZ,
    letzte_lesung_pct         NUMERIC,
    letzte_lesung_verworfen   TEXT CHECK (letzte_lesung_verworfen IN ('unplausibel', 'veraltet')),
    aktualisiert_am           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wechselrichter_untergrenze_tenant
    ON wechselrichter_untergrenze (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON wechselrichter_untergrenze TO ${appDbUser};

ALTER TABLE wechselrichter_untergrenze ENABLE ROW LEVEL SECURITY;
ALTER TABLE wechselrichter_untergrenze FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wechselrichter_untergrenze_isolation ON wechselrichter_untergrenze;
CREATE POLICY wechselrichter_untergrenze_isolation ON wechselrichter_untergrenze
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE component_change_event DROP CONSTRAINT IF EXISTS component_change_event_event_type_check;
ALTER TABLE component_change_event ADD CONSTRAINT component_change_event_event_type_check
    CHECK (event_type IN ('edited', 'family_changed', 'rolled_back', 'device_replaced',
                          'wr_untergrenze_gelesen'));
