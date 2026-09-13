package com.voltpilot.api.enrollment;

import java.util.List;
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
                "SELECT tenant_id, site_id, id FROM device WHERE external_ref = ? AND ausgebaut_am IS NULL",
                (rs, rowNum) -> new DeviceIdentity(
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getObject("id", UUID.class)),
                externalRef).stream().findFirst();
    }

    /**
     * Every claimed + enrolled device's identity - the AUTHORITATIVE list of
     * devices that MUST have a broker ACL grant. A row qualifies when it has an
     * issued certificate ({@code device_enrollment.cert_pem IS NOT NULL}) AND is
     * still claimed (its {@code device_id} still resolves to a {@code device}
     * row; an unclaim deletes the device row, so the INNER JOIN drops it). This
     * is the source of truth the startup ACL self-heal regenerates grants from,
     * so a grant that a prior buggy file rebuild DROPPED is restored on the next
     * api boot - you cannot reload a grant that is not in the file. Uses the
     * BYPASSRLS admin datasource (enrollment carries no tenant), like
     * {@link #findByRef}.
     */
    public List<DeviceIdentity> allEnrolledDeviceIdentities() {
        return jdbc.query(
                "SELECT d.tenant_id, d.site_id, d.id "
                        + "FROM device_enrollment e "
                        + "JOIN device d ON d.id = e.device_id AND d.ausgebaut_am IS NULL "
                        + "WHERE e.cert_pem IS NOT NULL",
                (rs, rowNum) -> new DeviceIdentity(
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getObject("id", UUID.class)));
    }
}
