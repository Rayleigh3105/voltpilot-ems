-- AP-06 IP-12: einen noch nicht wirksamen Box-Wechsel zurücknehmen, ohne seine
-- historische Anweisung zu löschen. Der aktive Zeitstrahl blendet die markierte
-- Zeile aus; der unmittelbar davor liegende Zeitraum wird wieder geöffnet.

ALTER TABLE data_source_assignment
    ADD COLUMN IF NOT EXISTS zurueckgenommen_am TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS zurueckgenommen_von TEXT;

ALTER TABLE data_source_assignment
    DROP CONSTRAINT data_source_assignment_eine_box_je_zeitpunkt;
ALTER TABLE data_source_assignment
    ADD CONSTRAINT data_source_assignment_eine_box_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        data_source_id WITH =,
        tstzrange(effective_from, effective_to, '[)') WITH &&
    ) WHERE (zurueckgenommen_am IS NULL);

ALTER TABLE data_source_assignment
    DROP CONSTRAINT data_source_assignment_ein_weg_je_box;
ALTER TABLE data_source_assignment
    ADD CONSTRAINT data_source_assignment_ein_weg_je_box EXCLUDE USING gist (
        tenant_id WITH =,
        device_id WITH =,
        protokoll WITH =,
        adresse WITH =,
        tstzrange(effective_from, effective_to, '[)') WITH &&
    ) WHERE (zurueckgenommen_am IS NULL);

ALTER TABLE data_source_aenderung
    DROP CONSTRAINT data_source_aenderung_art_chk;
ALTER TABLE data_source_aenderung
    ADD CONSTRAINT data_source_aenderung_art_chk CHECK (art IN (
        'angelegt', 'bearbeitet', 'erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
        'zustaendigkeit_gewechselt', 'zustaendigkeit_zurueckgenommen',
        'aus_bestand_uebernommen'));

ALTER TABLE data_source_aenderung
    DROP CONSTRAINT data_source_aenderung_box_chk;
ALTER TABLE data_source_aenderung
    ADD CONSTRAINT data_source_aenderung_box_chk CHECK (
        device_id IS NOT NULL
        OR art NOT IN ('erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
                       'zustaendigkeit_gewechselt', 'zustaendigkeit_zurueckgenommen',
                       'aus_bestand_uebernommen'));

REVOKE UPDATE, DELETE ON data_source_assignment FROM ${appDbUser};
GRANT UPDATE (effective_to, zurueckgenommen_am, zurueckgenommen_von)
    ON data_source_assignment TO ${appDbUser};
