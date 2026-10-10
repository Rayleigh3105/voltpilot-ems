-- AP-05 IP-9. Nur nullable Ergänzungen; kein Seed und kein Bestands-Backfill.
-- Primär/Sekundär, Anwendung und Skalierungsfaktor bleiben quelle_einstellung.
-- Seriennummer und Kartenidentität bleiben geraet / geraet_teil / geraet_komponente.
ALTER TABLE measurement_point
    ADD COLUMN slot integer CHECK (slot BETWEEN 1 AND 65535),
    ADD COLUMN wago_anwenderskalierung boolean,
    ADD COLUMN wago_register_35 integer CHECK (wago_register_35 BETWEEN 0 AND 65535);
ALTER TABLE component_definition
    ADD COLUMN slot integer CHECK (slot BETWEEN 1 AND 65535),
    ADD COLUMN wago_anwenderskalierung boolean,
    ADD COLUMN wago_register_35 integer CHECK (wago_register_35 BETWEEN 0 AND 65535);
ALTER TABLE geraet
    ADD COLUMN firmware text CHECK (firmware IS NULL OR (length(firmware) <= 200 AND btrim(firmware) <> '')),
    ADD COLUMN anwendung text CHECK (anwendung IS NULL OR (length(anwendung) <= 200 AND btrim(anwendung) <> ''));
GRANT UPDATE (firmware, anwendung) ON geraet TO ${appDbUser};
-- Bestehende Tabellen behalten ENABLE/FORCE RLS und ihre Mandanten-Policies.
-- Die Fassungen erhalten zusätzlich den Standortzaun wie measurement_point.
CREATE POLICY wago_definition_site_scope ON component_definition AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));
CREATE POLICY wago_geraet_site_scope ON geraet AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));
-- Jeder vorhandene Schreiber einer Komponenten-Fassung nimmt die Kartenfakten mit.
-- Kein UPDATE bestehender Fassungen; die Lesecode-vor-Migration-Tests bleiben kompatibel.
CREATE FUNCTION uems_wago_kartenfassung() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT m.slot, m.wago_anwenderskalierung, m.wago_register_35
      INTO NEW.slot, NEW.wago_anwenderskalierung, NEW.wago_register_35
      FROM measurement_point m
     WHERE m.id = NEW.entity_id AND m.tenant_id = NEW.tenant_id AND m.site_id = NEW.site_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER wago_kartenfassung BEFORE INSERT ON component_definition
    FOR EACH ROW EXECUTE FUNCTION uems_wago_kartenfassung();
