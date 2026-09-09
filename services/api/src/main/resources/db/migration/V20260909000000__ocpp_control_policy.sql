-- Additive to the existing FORCE-RLS protected site configuration.
ALTER TABLE site_charging_config ADD COLUMN ocpp_control JSONB;
ALTER TABLE site_charging_config ADD CONSTRAINT ocpp_control_object
    CHECK (ocpp_control IS NULL OR jsonb_typeof(ocpp_control) = 'object');
ALTER TABLE device_charging_budget ADD COLUMN ocpp_control_status JSONB;
