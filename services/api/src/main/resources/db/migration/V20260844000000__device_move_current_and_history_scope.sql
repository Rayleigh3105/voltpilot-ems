-- A location move has two deliberately different meanings:
--
-- * current desired/snapshot rows follow the stable device identity;
-- * append-only events retain the tenant and site where they happened.
--
-- Keep both meanings database-enforced.  A stable (device, tenant) FK prevents
-- an event from being attributed to another tenant's device, while a separate
-- (site, tenant) FK prevents a historical site from crossing the ownership
-- boundary.  The current selection keeps the stricter live
-- (device, tenant, site) tuple and follows the device atomically on UPDATE.

CREATE UNIQUE INDEX IF NOT EXISTS uq_device_id_tenant_identity
    ON device (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_id_tenant_identity
    ON site (id, tenant_id);

ALTER TABLE device_measurement_selection
    DROP CONSTRAINT IF EXISTS device_measurement_selection_device_fk;
ALTER TABLE device_measurement_selection
    ADD CONSTRAINT device_measurement_selection_device_fk
    FOREIGN KEY (device_id, tenant_id, site_id)
    REFERENCES device (id, tenant_id, site_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE device_measurement_selection_event
    DROP CONSTRAINT IF EXISTS device_measurement_selection_event_device_fk;
ALTER TABLE device_measurement_selection_event
    ADD CONSTRAINT device_measurement_selection_event_device_tenant_fk
    FOREIGN KEY (device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE CASCADE;
ALTER TABLE device_measurement_selection_event
    ADD CONSTRAINT device_measurement_selection_event_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE CASCADE;

-- The previous edit-contract migration already split current OCPP snapshots
-- from historical OCPP facts.  Tighten those history constraints to the same
-- stable tenant/site semantics instead of retaining an id-only device FK.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ocpp_protocol_event','ocpp_connector_status_event',
    'ocpp_authorization_event','ocpp_meter_sample','ocpp_station_status_event','ocpp_transaction'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      t, t || '_device_history_device_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I '
      || 'FOREIGN KEY (device_id, tenant_id) REFERENCES device(id, tenant_id) ON DELETE CASCADE',
      t, t || '_history_device_tenant_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I '
      || 'FOREIGN KEY (site_id, tenant_id) REFERENCES site(id, tenant_id) ON DELETE CASCADE',
      t, t || '_history_site_tenant_fk');
  END LOOP;
END $$;
