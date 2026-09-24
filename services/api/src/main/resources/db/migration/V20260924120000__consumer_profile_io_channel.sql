-- =============================================================================
-- V20260924120000 - Verbraucher an einem Ausgang eines I/O-Moduls.
-- ADDITIV: zwei nullbare Spalten auf consumer_profile, kein Backfill. Ohne
-- Bindung verhaelt sich jeder bestehende Pfad byte-gleich.
-- -----------------------------------------------------------------------------
-- WOFUER: Ein I/O-Modul (Ebyte M31, Entitaetstyp `io-module`) ist EIN Geraet mit
-- N Relais-Ausgaengen. Jeder Ausgang, der eine Last schaltet (Heizstab,
-- SG-Ready-Kontakt, Pumpe), ist ein EIGENER Verbraucher mit eigener Steuerart,
-- eigenen Zyklen-Grenzen und eigener Freigabe. Die Bindung "dieser Verbraucher
-- ist Ausgang k jenes Moduls" steht hier:
--
--   io_entity_id  die Komponente des Moduls (measurement_point, Typ io-module)
--   io_channel    der 1-basierte Ausgang ueber den ganzen Modul-Stapel (DO1 = 1)
--
-- Der Registry-Push setzt daraus den Treiber des Verbrauchers zusammen
-- ({communication, io_entity_id, channel} - bewusst OHNE eigene Verbindung: das
-- Modul hat genau einen Socket-Besitzer, die Box liest die Adresse aus der
-- Modul-Komponente).
--
-- ⚠ WARUM NICHT communication/connection_json DES VERBRAUCHERS: diese Spalten
-- lesen Bestands-Uebernahme, Registerzugriff und UEMS-Geraet als PHYSISCHEN
-- Transport. Ein Kanal-Verbraucher hat keinen eigenen Transport; ihn dort
-- einzutragen, machte ihn fuer jede dieser Stellen zu einem zweiten Geraet
-- unter derselben Adresse.
--
-- ⚠ WARUM NICHT edge_source_id: die Uebernahme-Nadel ist 1:1 (eine Quelle, ein
-- Verbraucher). Acht Verbraucher an einem Modul teilen sich EINE Quelle.
--
-- Mandanten-/Anlagen-Konsistenz wie consumer_profile_entity_consistency: das
-- Modul muss in DERSELBEN Anlage desselben Mandanten liegen. ON DELETE RESTRICT:
-- ein Modul mit gebundenen Verbrauchern verschwindet nicht still unter ihnen.
-- Ein Ausgang gehoert hoechstens EINEM Verbraucher (partieller UNIQUE-Index).
--
-- RLS: consumer_profile ist bereits mandantengebunden (ENABLE + FORCE seit
-- V20260810000000); neue Spalten erben Policy und Grants der Tabelle.
-- =============================================================================

ALTER TABLE consumer_profile
    ADD COLUMN IF NOT EXISTS io_entity_id UUID,
    ADD COLUMN IF NOT EXISTS io_channel   INTEGER;

ALTER TABLE consumer_profile
    DROP CONSTRAINT IF EXISTS consumer_profile_io_binding_complete;
ALTER TABLE consumer_profile
    ADD CONSTRAINT consumer_profile_io_binding_complete
    CHECK ((io_entity_id IS NULL AND io_channel IS NULL)
        OR (io_entity_id IS NOT NULL AND io_channel BETWEEN 1 AND 256));

ALTER TABLE consumer_profile
    DROP CONSTRAINT IF EXISTS consumer_profile_io_entity_consistency;
ALTER TABLE consumer_profile
    ADD CONSTRAINT consumer_profile_io_entity_consistency
    FOREIGN KEY (io_entity_id, tenant_id, site_id)
    REFERENCES measurement_point (id, tenant_id, site_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_consumer_profile_io_channel
    ON consumer_profile (io_entity_id, io_channel)
    WHERE io_entity_id IS NOT NULL;

COMMENT ON COLUMN consumer_profile.io_entity_id IS
    'Komponente des I/O-Moduls, dessen Ausgang dieser Verbraucher schaltet. NULL = keine Kanal-Bindung.';
COMMENT ON COLUMN consumer_profile.io_channel IS
    '1-basierter Relais-Ausgang ueber den ganzen Modul-Stapel (DO1 = 1). Gesetzt genau dann, wenn io_entity_id gesetzt ist.';
