-- =============================================================================
-- First-boot device enrollment over HTTPS: pending CSRs + issued certificates.
-- -----------------------------------------------------------------------------
-- A fresh edge device knows only its reference and the portal URL. It uploads a
-- certificate signing request (the private key never leaves the device) keyed
-- by its canonical ref, then polls for its certificate. Once the ref is CLAIMED
-- in the portal (a `device` row exists), the api signs the CSR with the device
-- CA - enforcing the subject convention O=tenant/OU=site/CN=device_id - and the
-- issued certificate is stored here so device retries can re-fetch it (the
-- private key is the secret and it never left the device; revocation via the
-- CRL/ACL tooling remains the kill switch).
--
-- Like provisioned_device, this is PRE-CLAIM manufacturing-style data: a CSR
-- arrives before any customer owns the ref, so there is deliberately no
-- tenant_id and no RLS. Ownership is established by the claim; the issuing GET
-- records the claimed device_id for audit.
--
-- The unauthenticated enrollment endpoints run through the app datasource, so
-- the app role needs INSERT/UPDATE here (unlike provisioned_device, whose
-- writes are admin-only); DELETE stays revoked - enrollment rows double as an
-- issuance audit trail and are cleaned up by operators, not by the api.
--
-- Date-based version: sorts after every earlier api migration and never
-- collides with forecast (V3) or market-data (V2026...) versions.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_enrollment (
    external_ref   TEXT PRIMARY KEY,
    csr_pem        TEXT        NOT NULL,
    device_info    TEXT,
    csr_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Filled at issuance (NULL while pending):
    device_id      UUID,
    cert_pem       TEXT,
    cert_serial    TEXT,
    issued_at      TIMESTAMPTZ
);

GRANT SELECT, INSERT, UPDATE ON device_enrollment TO ${appDbUser};
REVOKE DELETE ON device_enrollment FROM ${appDbUser};
