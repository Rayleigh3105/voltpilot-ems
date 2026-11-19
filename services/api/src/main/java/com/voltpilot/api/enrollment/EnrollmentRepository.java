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
            UUID deviceId, String certPem, String certSerial, Instant issuedAt, Instant notAfter) {

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

    /**
     * Lebenszeichen einer Zertifikats-Abfrage (vp-entkoppelte-box-meldet-verbunden, D3 = A):
     * notiert {@code zuletzt_abgefragt_am} für eine Kennung, die schon eine Zeile hat -
     * höchstens einmal je Minute, damit der Abgleich-Takt aller Boxen keine Schreiblast
     * erzeugt. Eine unbekannte Kennung ändert nichts (kein INSERT): die Abfrage bleibt so
     * stumm wie zuvor.
     */
    public void notierAbfrage(String externalRef) {
        jdbc.update(
                "UPDATE device_enrollment SET zuletzt_abgefragt_am = now() WHERE external_ref = ? "
                        + "AND (zuletzt_abgefragt_am IS NULL "
                        + "     OR zuletzt_abgefragt_am < now() - interval '1 minute')",
                externalRef);
    }

    /**
     * Was die Plattform zuletzt von einer Referenz hörte, ohne Schlüsselmaterial: die laufende Fassung aus der
     * letzten Zertifikatsanfrage ({@code deviceInfo}), wann sie kam (der letzte Programmstart), die letzte
     * Zertifikats-Abfrage und ob ein Zertifikat ausgestellt ist.
     */
    public record Meldung(String deviceInfo, Instant csrUpdatedAt, Instant zuletztAbgefragtAm, boolean zertifikat) {
    }

    public Optional<Meldung> meldung(String externalRef) {
        return jdbc.query(
                "SELECT device_info, csr_updated_at, zuletzt_abgefragt_am, cert_pem IS NOT NULL AS zertifikat "
                        + "FROM device_enrollment WHERE external_ref = ?",
                (rs, n) -> new Meldung(rs.getString("device_info"), zeit(rs.getTimestamp("csr_updated_at")),
                        zeit(rs.getTimestamp("zuletzt_abgefragt_am")), rs.getBoolean("zertifikat")),
                externalRef).stream().findFirst();
    }

    private static Instant zeit(java.sql.Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    public Optional<Enrollment> find(String externalRef) {
        return jdbc.query(
                "SELECT external_ref, csr_pem, device_info, device_id, cert_pem, cert_serial, "
                        + "issued_at, not_after FROM device_enrollment WHERE external_ref = ?",
                EnrollmentRepository::mapEnrollment, externalRef).stream().findFirst();
    }

    /**
     * Persists the issued certificate, now mit {@code not_after} (Lücke L4,
     * Adminview-Konzept Abschnitt 3.4): das Ablaufdatum wird beim Ausstellen
     * geschrieben, statt nur im {@code cert_pem} zu stecken. The guard makes a
     * concurrent double-issue for the SAME device lose the race harmlessly (the
     * caller re-reads and returns the winner's certificate), while an
     * unclaim-and-re-claim - a NEW device_id for the ref - replaces the stale
     * certificate.
     */
    public boolean storeCertificate(String externalRef, UUID deviceId, String certPem,
            String certSerial, Instant notAfter) {
        return jdbc.update(
                "UPDATE device_enrollment SET device_id = ?, cert_pem = ?, cert_serial = ?, "
                        + "issued_at = now(), not_after = ? WHERE external_ref = ? "
                        + "AND (cert_pem IS NULL OR device_id IS DISTINCT FROM ?)",
                deviceId, certPem, certSerial, java.sql.Timestamp.from(notAfter),
                externalRef, deviceId) > 0;
    }

    private static Enrollment mapEnrollment(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        java.sql.Timestamp issuedAt = rs.getTimestamp("issued_at");
        java.sql.Timestamp notAfter = rs.getTimestamp("not_after");
        return new Enrollment(
                rs.getString("external_ref"),
                rs.getString("csr_pem"),
                rs.getString("device_info"),
                rs.getObject("device_id", UUID.class),
                rs.getString("cert_pem"),
                rs.getString("cert_serial"),
                issuedAt == null ? null : issuedAt.toInstant(),
                notAfter == null ? null : notAfter.toInstant());
    }
}
