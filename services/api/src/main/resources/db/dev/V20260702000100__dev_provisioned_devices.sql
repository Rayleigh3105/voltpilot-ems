-- =============================================================================
-- DEV-ONLY: provision a handful of sticker Geräte-IDs (local profile only).
-- -----------------------------------------------------------------------------
-- Sticker-format claims (VP- prefix) validate against the provisioned_device
-- registry, so local wizard walkthroughs need known-good IDs. Deliberately a
-- separate migration (NOT an edit of V100) so already-migrated dev volumes do
-- not fail Flyway's checksum validation. Date-versioned to sort AFTER the
-- registry table's migration (a plain V101 would sort before it and fail).
-- =============================================================================

INSERT INTO provisioned_device (external_ref, kind, note) VALUES
    ('VP-DEMO-0001', 'inverter', 'dev seed - wizard walkthrough'),
    ('VP-DEMO-0002', 'inverter', 'dev seed - wizard walkthrough'),
    ('VP-DEMO-0003', 'battery',  'dev seed - wizard walkthrough'),
    ('VP-E2E-0001',  'inverter', 'dev seed - live-stack e2e checks')
ON CONFLICT (external_ref) DO NOTHING;
