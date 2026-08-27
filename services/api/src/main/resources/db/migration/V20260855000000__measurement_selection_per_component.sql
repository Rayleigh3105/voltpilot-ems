-- =============================================================================
-- V20260855000000 - Mess-Selektion JE KOMPONENTE (Geraeteseite Stufe 3b).
-- -----------------------------------------------------------------------------
-- Bis hierher war die Auswahl je (device_id, point_key) gespeichert, also je
-- BOX. Zwei baugleiche Geraete hinter EINER Box (die zwei Fronius Eco von
-- Herzogau) teilten sich damit zwangslaeufig eine Liste, und die Wallbox-Seite
-- konnte gar keine eigene fuehren. Diese Migration ergaenzt beide Tabellen um
-- eine NULLABLE Komponenten-Referenz; getrennte Listen sind damit moeglich.
--
-- ⚠ NULL IST DIE BISHERIGE BOX-SEMANTIK, nicht "unbekannt". Jede bestehende
-- Zeile bleibt damit exakt das, was sie war, und ein Client ohne entityId
-- verhaelt sich Zeichen fuer Zeichen wie vorher. Additiv im Wortsinn: es wird
-- keine Zeile geschrieben, gelesen oder umgedeutet.
-- =============================================================================

ALTER TABLE device_measurement_selection       ADD COLUMN IF NOT EXISTS entity_id UUID;
ALTER TABLE device_measurement_selection_event ADD COLUMN IF NOT EXISTS entity_id UUID;

-- Der FK unten bindet die Komponente an DENSELBEN Mandanten. `id` ist die PK,
-- das Paar ist also trivial eindeutig - der Index existiert nur, damit ein
-- zusammengesetzter Fremdschluessel darauf zeigen kann.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'uq_measurement_point_id_tenant') THEN
        ALTER TABLE measurement_point
            ADD CONSTRAINT uq_measurement_point_id_tenant UNIQUE (id, tenant_id);
    END IF;
END $$;

-- ⚠ Gebunden wird (entity_id, tenant_id), BEWUSST OHNE site_id - obwohl der
-- Geraete-FK daneben das volle Tripel bindet. Grund ist der Geraete-Umzug
-- (V20260850000000 / DeviceRepository.move): dort wandert `device.site_id` und
-- nimmt diese Zeilen ueber ON UPDATE CASCADE mit, waehrend eine Komponente OHNE
-- `device_id` am alten Standort zurueckbleibt. Ein site-gebundener FK waere
-- mitten im Umzug verletzt. Der Mandant IST der Sicherheitszaun (RLS); die
-- Standort-Gleichheit ist eine Anlege-Regel des Dienstes, keine Invariante
-- ueber einen Umzug hinweg. MATCH SIMPLE: entity_id NULL erfuellt den FK
-- trivial - genau die Box-Semantik oben.
ALTER TABLE device_measurement_selection
    DROP CONSTRAINT IF EXISTS device_measurement_selection_entity_fk;
ALTER TABLE device_measurement_selection
    ADD CONSTRAINT device_measurement_selection_entity_fk
    FOREIGN KEY (entity_id, tenant_id)
    REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE;

-- ⚠ Die Papier-Spur bekommt AUSDRUECKLICH KEINEN Fremdschluessel: sie ist
-- append-only und muss die Komponente ueberleben, ueber die sie berichtet (das
-- rule_event-/rollout_device-Muster - wer die Komponente morgen loescht,
-- schreibt die Vergangenheit nicht um). Ihr Mandanten-/Standort-/Geraete-Zaun
-- samt RLS ist unveraendert; `entity_id` ist dort eine reine Zuordnungsnotiz.

-- Der Schluessel wird (device_id, entity_id, point_key). NULLS NOT DISTINCT
-- (PG15+) macht die Box-Semantik zu GENAU EINER Zeile je point_key, ohne einen
-- Sentinel-UUID-Ausdruck zu erfinden; ON CONFLICT kann darauf schliessen.
-- Es bleibt eine UNIQUE-Bedingung statt einer PK, weil eine PK-Spalte NOT NULL
-- sein muesste - und NULL ist hier eine Aussage.
ALTER TABLE device_measurement_selection
    DROP CONSTRAINT IF EXISTS device_measurement_selection_pkey;
ALTER TABLE device_measurement_selection
    DROP CONSTRAINT IF EXISTS uq_device_measurement_selection_point;
ALTER TABLE device_measurement_selection
    ADD CONSTRAINT uq_device_measurement_selection_point
    UNIQUE NULLS NOT DISTINCT (device_id, entity_id, point_key);

-- Die Auswahl braucht KEINEN eigenen Index: das Unique-Constraint oben liegt
-- schon auf (device_id, entity_id, ...) und traegt jede Filterung. Die
-- Papier-Spur hat bisher nur (device_id, requested_at DESC, id DESC) und
-- bekommt deshalb einen, der Filter UND Sortierung der Lese-Route bedient.
CREATE INDEX IF NOT EXISTS idx_device_measurement_selection_event_entity
    ON device_measurement_selection_event
       (device_id, entity_id, desired_revision DESC, id DESC);

COMMENT ON COLUMN device_measurement_selection.entity_id IS
    'Die Komponente, die diesen Punkt beobachtet. NULL = die bisherige '
    'Box-Semantik (die Auswahl gehoert dem Geraet als Ganzem), nie "unbekannt".';
COMMENT ON COLUMN device_measurement_selection_event.entity_id IS
    'Zuordnungsnotiz der Anforderung; ohne Fremdschluessel, damit die '
    'append-only Papier-Spur die Komponente ueberlebt.';
