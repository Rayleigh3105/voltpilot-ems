package com.voltpilot.api.enrollment;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Pending CSRs + issued certificates ({@code device_enrollment}). Global,
 * pre-claim manufacturing-style data like {@code provisioned_device} - no
 * tenant, no RLS - so the RLS-scoped app datasource serves the unauthenticated
 * enrollment endpoints fine (see migration V20260702040000).
 */
@Repository
public class EnrollmentRepository {

    private final JdbcTemplate jdbc;

    public EnrollmentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Enrollment(String externalRef, String csrPem, String deviceInfo,
            UUID deviceId, String certPem, String certSerial, Instant issuedAt) {

        public boolean issued() {
            return certPem != null;
        }
    }

    /**
     * Stores/replaces the pending CSR for a ref. Returns {@code false} when a
     * certificate was already issued for the ref - the CSR (and so the key) is
     * then fixed; re-keying goes through revoke + re-enroll (see the controller).
     */
    public boolean upsertCsr(String externalRef, String csrPem, String deviceInfo) {
        return jdbc.update(
                "INSERT INTO device_enrollment (external_ref, csr_pem, device_info) "
                        + "VALUES (?, ?, ?) "
                        + "ON CONFLICT (external_ref) DO UPDATE "
                        + "SET csr_pem = EXCLUDED.csr_pem, device_info = EXCLUDED.device_info, "
                        + "    csr_updated_at = now() "
                        + "WHERE device_enrollment.cert_pem IS NULL",
                externalRef, csrPem, deviceInfo) > 0;
    }

    public Optional<Enrollment> find(String externalRef) {
        return jdbc.query(
                "SELECT external_ref, csr_pem, device_info, device_id, cert_pem, cert_serial, "
                        + "issued_at FROM device_enrollment WHERE external_ref = ?",
                EnrollmentRepository::mapEnrollment, externalRef).stream().findFirst();
    }

    /**
     * Persists the issued certificate. The guard makes a concurrent double-issue
     * for the SAME device lose the race harmlessly (the caller re-reads and
     * returns the winner's certificate), while an unclaim-and-re-claim - a NEW
     * device_id for the ref - replaces the stale certificate.
     */
    public boolean storeCertificate(String externalRef, UUID deviceId, String certPem,
            String certSerial) {
        return jdbc.update(
                "UPDATE device_enrollment SET device_id = ?, cert_pem = ?, cert_serial = ?, "
                        + "issued_at = now() WHERE external_ref = ? "
                        + "AND (cert_pem IS NULL OR device_id IS DISTINCT FROM ?)",
                deviceId, certPem, certSerial, externalRef, deviceId) > 0;
    }

    private static Enrollment mapEnrollment(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        java.sql.Timestamp issuedAt = rs.getTimestamp("issued_at");
        return new Enrollment(
                rs.getString("external_ref"),
                rs.getString("csr_pem"),
                rs.getString("device_info"),
                rs.getObject("device_id", UUID.class),
                rs.getString("cert_pem"),
                rs.getString("cert_serial"),
                issuedAt == null ? null : issuedAt.toInstant());
    }
}
