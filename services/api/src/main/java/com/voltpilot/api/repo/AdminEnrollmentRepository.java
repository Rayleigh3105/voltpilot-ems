package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.PendingEnrollmentDto;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Operator view onto enrolled-but-unclaimed devices: {@code device_enrollment}
 * rows whose ref has no matching {@code device} row (never claimed, or unclaimed
 * after issuance). Uses the {@code adminJdbcTemplate} ({@code voltpilot_admin},
 * BYPASSRLS) like {@link AdminProvisionedDeviceRepository}, because the LEFT
 * JOIN spans the RLS-protected {@code device} table across all tenants - reached
 * solely from {@code @PreAuthorize("hasRole('platform-admin')")} endpoints.
 *
 * <p>{@code device_enrollment} exists regardless of whether the enrollment
 * feature is enabled at runtime (the migration always creates it), so this
 * read-only view needs none of the enrollment-service beans.
 */
@Repository
public class AdminEnrollmentRepository {

    private final JdbcTemplate jdbc;

    public AdminEnrollmentRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Enrollments with no currently-claimed device, newest CSR first. */
    public List<PendingEnrollmentDto> findPending() {
        return jdbc.query(
                "SELECT e.external_ref, e.device_info, e.csr_updated_at, e.issued_at "
                        + "FROM device_enrollment e "
                        + "LEFT JOIN device d ON d.external_ref = e.external_ref "
                        + "WHERE d.id IS NULL "
                        + "ORDER BY e.csr_updated_at DESC, e.external_ref",
                AdminEnrollmentRepository::map);
    }

    private static PendingEnrollmentDto map(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        java.sql.Timestamp issuedAt = rs.getTimestamp("issued_at");
        return new PendingEnrollmentDto(
                rs.getString("external_ref"),
                rs.getString("device_info"),
                rs.getTimestamp("csr_updated_at").toInstant(),
                issuedAt != null,
                issuedAt == null ? null : issuedAt.toInstant());
    }
}
