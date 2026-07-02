package com.voltpilot.api.enrollment;

import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Claim-state lookup for enrollment: is this ref claimed, and by whom? An
 * enrollment poll carries no tenant (the device is not a portal user), so the
 * RLS-scoped app datasource - default-deny without a tenant - cannot serve it;
 * this uses the BYPASSRLS admin datasource, the same reasoning as the
 * provisioning hello resolver in services/ingest ({@code JdbcDeviceDirectory}).
 * Deliberately a single read-only query: the identity read here is exactly
 * what gets baked into the certificate subject.
 */
@Repository
public class EnrollmentDeviceLookup {

    private final JdbcTemplate jdbc;

    public EnrollmentDeviceLookup(@Qualifier("adminJdbcTemplate") JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record DeviceIdentity(UUID tenantId, UUID siteId, UUID deviceId) {
    }

    public Optional<DeviceIdentity> findByRef(String externalRef) {
        return jdbc.query(
                "SELECT tenant_id, site_id, id FROM device WHERE external_ref = ?",
                (rs, rowNum) -> new DeviceIdentity(
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getObject("id", UUID.class)),
                externalRef).stream().findFirst();
    }
}
