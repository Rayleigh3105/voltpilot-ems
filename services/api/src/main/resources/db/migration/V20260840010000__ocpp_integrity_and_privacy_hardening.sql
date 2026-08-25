-- =============================================================================
-- Slice 10 review hardening (additive: V20260840000000 may already be applied).
--
-- 1. OCPP rows must belong to one real tenant/site/device tuple and disappear
--    with that device. The application still deletes them explicitly in every
--    purge/offboarding path; the composite FK is the final schema backstop.
-- 2. CallError.error_description is untyped station/vendor text. Preserve the
--    typed error code/details, but never persist the free text itself.
-- 3. Sensitive transaction data also expires for abandoned transactions that
--    never received StopTransaction.
-- =============================================================================

-- A previously deployed foundation had no FK. Remove only rows that cannot
-- possibly be attributed to their claimed device before validating the new
-- constraints; retaining such orphans would be both misleading and a privacy
-- violation.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ocpp_station', 'ocpp_connector_state', 'ocpp_protocol_event',
    'ocpp_connector_status_event', 'ocpp_authorization_event', 'ocpp_transaction',
    'ocpp_meter_sample', 'ocpp_station_status_event', 'ocpp_configuration_key',
    'ocpp_configuration_unknown_key', 'ocpp_station_capability'
  ] LOOP
    EXECUTE format(
      'DELETE FROM %I o WHERE NOT EXISTS (' ||
      'SELECT 1 FROM device d WHERE d.id = o.device_id ' ||
      'AND d.site_id = o.site_id AND d.tenant_id = o.tenant_id)', t);
  END LOOP;
END $$;

ALTER TABLE device
  ADD CONSTRAINT uq_device_id_site_tenant UNIQUE (id, site_id, tenant_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ocpp_station', 'ocpp_connector_state', 'ocpp_protocol_event',
    'ocpp_connector_status_event', 'ocpp_authorization_event', 'ocpp_transaction',
    'ocpp_meter_sample', 'ocpp_station_status_event', 'ocpp_configuration_key',
    'ocpp_configuration_unknown_key', 'ocpp_station_capability'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I ' ||
      'FOREIGN KEY (device_id, site_id, tenant_id) ' ||
      'REFERENCES device (id, site_id, tenant_id) ' ||
      'ON UPDATE CASCADE ON DELETE CASCADE NOT VALID',
      t, t || '_device_scope_fk');
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',
      t, t || '_device_scope_fk');
  END LOOP;
END $$;

UPDATE ocpp_protocol_event
   SET error_description = '[redacted-call-error-description]'
 WHERE error_description IS NOT NULL
   AND error_description <> '[redacted-call-error-description]';

ALTER TABLE ocpp_protocol_event
  ADD CONSTRAINT ocpp_protocol_error_description_redacted_chk
  CHECK (error_description IS NULL
         OR error_description = '[redacted-call-error-description]');

-- Replacement in a NEW migration: never edit the possibly-published original.
-- For an open transaction, updated_at is the last evidence that it was still
-- active. Once both its start and last update are older than 90 days, the same
-- sensitive fields as for a stopped transaction are erased while the neutral
-- operational header remains.
CREATE OR REPLACE PROCEDURE ocpp_sensitive_retention(job_id INTEGER, config JSONB)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE ocpp_transaction
     SET transaction_data = '[]'::jsonb,
         start_id_tag_ref = NULL,
         stop_id_tag_ref = NULL,
         parent_id_tag_ref = NULL,
         transaction_data_purged_at = now()
   WHERE (
          stopped_at < now() - INTERVAL '90 days'
          OR (stopped_at IS NULL
              AND started_at < now() - INTERVAL '90 days'
              AND updated_at < now() - INTERVAL '90 days')
         )
     AND (transaction_data <> '[]'::jsonb OR start_id_tag_ref IS NOT NULL
          OR stop_id_tag_ref IS NOT NULL OR parent_id_tag_ref IS NOT NULL);
END $$;
