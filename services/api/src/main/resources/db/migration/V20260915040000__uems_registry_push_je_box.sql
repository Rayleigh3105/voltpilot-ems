-- =============================================================================
-- V20260915040000 - UEMS AP-06 IP-6: der Soll-Zustand des Registry-Pushs je
-- (Anlage, Box) statt je Anlage (Widerspruch W7, Entscheid E4 = A).
-- -----------------------------------------------------------------------------
-- Bisher hielt entity_registry_state EINE Zeile je Anlage (site_id PRIMARY KEY):
-- die Revision des einen Pushs an die eine Box. Mit dem Push je Box bekommt
-- jede Box ihren eigenen, vollständigen Sollbestand - also braucht jede Box
-- ihre eigene Zeile, sonst überschriebe die Revision der zweiten Box die der
-- ersten, und der Abgleich „ist das angekommen?" verglich gegen die falsche.
--
-- ⚠ Nur der SCHLÜSSEL ändert sich, KEINE Zeile. Der Primärschlüssel auf
-- site_id fällt; an seine Stelle tritt die Eindeutigkeit von
-- (tenant_id, site_id, device_id) - tenant_id vorn wie in jedem Unique-Index
-- des Programms. Jede bestehende Zeile ist darin schon eindeutig.
--
-- device_id bleibt NULL-fähig, bewusst:
--   * Das Abmelden einer Box (DeviceRepository.ausDerTopologieLoesen) und der
--     Fremdschlüssel ON DELETE SET NULL setzen sie weiter auf NULL. Eine solche
--     Zeile ist das „Soll ohne Box" und bleibt stehen, wie sie ist.
--   * Zwei NULL-Zeilen derselben Anlage verletzen die Eindeutigkeit nicht
--     (NULLs sind verschieden) - genau das braucht das Abmelden der zweiten
--     Box derselben Anlage.
--   * Geschrieben wird eine Zeile nur noch MIT Box (EntityRegistryRepository).
--
-- site_id bleibt NOT NULL (der gefallene Primärschlüssel hatte es gesetzt,
-- hier ausdrücklich). Die Leser fragen je Anlage; die Eindeutigkeit beginnt
-- mit tenant_id, darum ein eigener Index über site_id. Rechte und RLS der
-- Tabelle bleiben unverändert (V20260719030000).
-- =============================================================================

ALTER TABLE entity_registry_state DROP CONSTRAINT IF EXISTS entity_registry_state_pkey;

ALTER TABLE entity_registry_state ALTER COLUMN site_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_registry_state_je_box') THEN
        ALTER TABLE entity_registry_state ADD CONSTRAINT entity_registry_state_je_box
            UNIQUE (tenant_id, site_id, device_id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_entity_registry_state_site ON entity_registry_state (site_id);
