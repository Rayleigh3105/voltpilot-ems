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

    /**
     * Enrollments with no currently-claimed device, newest CSR first.
     *
     * <p>{@code werkstatt_abnahme_am} is the Werkstatt acceptance date, joined
     * by the plain {@code edge_ref}/{@code external_ref} string match that
     * {@code WerkstattRepository} itself uses throughout (no FK between the
     * two domains): {@code null} means the box enrolled without ever passing
     * a Werkstatt acceptance, {@code hand} or {@code dienst} both count.
     */
    public List<PendingEnrollmentDto> findPending() {
        return jdbc.query(
                "SELECT e.external_ref, e.device_info, e.csr_updated_at, e.issued_at, wa.werkstatt_abnahme_am "
                        + "FROM device_enrollment e "
                        + "LEFT JOIN device d ON d.external_ref = e.external_ref AND d.ausgebaut_am IS NULL "
                        + "LEFT JOIN (SELECT edge_ref, min(erfasst_am) AS werkstatt_abnahme_am "
                        + "FROM werkstatt_abnahme GROUP BY edge_ref) wa ON wa.edge_ref = e.external_ref "
                        + "WHERE d.id IS NULL "
                        + "ORDER BY e.csr_updated_at DESC, e.external_ref",
                AdminEnrollmentRepository::map);
    }

    /**
     * Remove a dead enrollment (mistyped reference only - a box that was once issued a
     * certificate is never a dead enrollment, see below) from the registry. Re-checks the
     * claim at delete time - {@link #findPending} can be stale by the time the operator
     * clicks - so a race that claims it first makes this a no-op (0 rows) rather than an
     * error.
     *
     * <p>N3 (vp-box-rueckkehr-diagnose, Abschnitt 6): a row with {@code issued_at NOT NULL}
     * ({@code everIssued}) is refused with {@link EnrollmentHatZertifikat} BEFORE the delete
     * runs, never silently turned into a no-op - deleting it would make the box unreachable
     * forever (it never sends a new CSR once it holds a certificate, {@code enroll.go:162}),
     * and a reset under the same reference would then fail on the held key
     * ({@code schluessel_festgehalten}).
     */
    public boolean delete(String externalRef) {
        Boolean everIssued = jdbc.query(
                "SELECT issued_at IS NOT NULL FROM device_enrollment WHERE external_ref = ?",
                (rs, n) -> rs.getBoolean(1), externalRef).stream().findFirst().orElse(null);
        if (Boolean.TRUE.equals(everIssued)) {
            throw new EnrollmentHatZertifikat(externalRef);
        }
        return jdbc.update(
                "DELETE FROM device_enrollment e WHERE e.external_ref = ? "
                        + "AND e.issued_at IS NULL "
                        + "AND NOT EXISTS (SELECT 1 FROM device d "
                        + "WHERE d.external_ref = e.external_ref AND d.ausgebaut_am IS NULL)",
                externalRef) > 0;
    }

    /** 409: diese Kennung hat schon ein Zertifikat, Löschen käme einem dauerhaften Ausschluss gleich (N3). */
    public static final class EnrollmentHatZertifikat extends org.springframework.web.server.ResponseStatusException {
        public EnrollmentHatZertifikat(String externalRef) {
            super(org.springframework.http.HttpStatus.CONFLICT,
                    "Für '" + externalRef + "' wurde schon ein Zertifikat ausgestellt; diese Anmeldung lässt sich "
                            + "nicht löschen, ohne die Box dauerhaft unerreichbar zu machen.");
        }
    }

    private static PendingEnrollmentDto map(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        java.sql.Timestamp issuedAt = rs.getTimestamp("issued_at");
        java.sql.Timestamp werkstattAbnahmeAm = rs.getTimestamp("werkstatt_abnahme_am");
        return new PendingEnrollmentDto(
                rs.getString("external_ref"),
                rs.getString("device_info"),
                rs.getTimestamp("csr_updated_at").toInstant(),
                issuedAt != null,
                issuedAt == null ? null : issuedAt.toInstant(),
                werkstattAbnahmeAm == null ? null : werkstattAbnahmeAm.toInstant());
    }
}
