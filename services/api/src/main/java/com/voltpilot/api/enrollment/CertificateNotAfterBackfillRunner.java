package com.voltpilot.api.enrollment;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Rückfüllung von {@code device_enrollment.not_after} aus dem bereits
 * gespeicherten {@code cert_pem} (Lücke L4, Migration
 * {@code V20261106150000__device_enrollment_not_after.sql}). Neue
 * Ausstellungen füllen die Spalte längst selbst
 * ({@link EnrollmentRepository#storeCertificate}); dieser Läufer holt nur den
 * BESTAND nach.
 *
 * <p><b>Warum kein SQL-Data-Migration:</b> X.509-Parsing gehört nicht in eine
 * Flyway-Migration (dieselbe Begründung wie bei {@code V2SiteBackfillRunner}
 * für die v1→v2-Entitäten) - eine künftige Änderung an der Rückfüll-Regel darf
 * eine bereits angewandte Migration nicht anfassen müssen.
 *
 * <p>{@code device_enrollment} ist eine globale, RLS-freie Tabelle (wie
 * {@link EnrollmentRepository} selbst dokumentiert), also reicht der normale
 * {@code JdbcTemplate} - kein {@code adminJdbcTemplate} nötig. Idempotent: nur
 * Zeilen mit {@code cert_pem IS NOT NULL AND not_after IS NULL} werden
 * angefasst, ein zweiter Lauf findet nichts mehr. Eine einzelne kaputte Zeile
 * (unparsbares PEM) überspringt der Lauf und macht mit der nächsten weiter -
 * nie stirbt der Start der api daran.
 */
@Component
public class CertificateNotAfterBackfillRunner {

    private static final Logger log = LoggerFactory.getLogger(CertificateNotAfterBackfillRunner.class);

    private final JdbcTemplate jdbc;

    public CertificateNotAfterBackfillRunner(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        try {
            int backfilled = run();
            if (backfilled > 0) {
                log.info("device_enrollment.not_after backfill: {} row(s) filled from cert_pem",
                        backfilled);
            }
        } catch (RuntimeException e) {
            log.warn("device_enrollment.not_after backfill failed, bestand stays unfilled: {}",
                    e.toString(), e);
        }
    }

    /** Returns how many rows were filled. Paket-sichtbar für Tests. */
    int run() {
        List<Row> pending = jdbc.query(
                "SELECT external_ref, cert_pem FROM device_enrollment "
                        + "WHERE cert_pem IS NOT NULL AND not_after IS NULL",
                (rs, n) -> new Row(rs.getString("external_ref"), rs.getString("cert_pem")));
        int filled = 0;
        for (Row row : pending) {
            Instant notAfter = parseNotAfter(row.certPem());
            if (notAfter == null) {
                log.warn("device_enrollment.not_after backfill: could not parse cert_pem for ref '{}'",
                        row.externalRef());
                continue;
            }
            jdbc.update("UPDATE device_enrollment SET not_after = ? "
                            + "WHERE external_ref = ? AND not_after IS NULL",
                    Timestamp.from(notAfter), row.externalRef());
            filled++;
        }
        return filled;
    }

    /** Paket-sichtbar für Tests. */
    static Instant parseNotAfter(String certPem) {
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            X509Certificate cert = (X509Certificate) cf.generateCertificate(
                    new ByteArrayInputStream(certPem.getBytes(StandardCharsets.US_ASCII)));
            return cert.getNotAfter().toInstant();
        } catch (Exception e) {
            return null;
        }
    }

    private record Row(String externalRef, String certPem) {
    }
}
