package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Pure unit proof (no Spring, no Docker) of the X.509 parsing behind Lücke L4
 * (Zertifikat gültig bis): {@link CertificateNotAfterBackfillRunner#parseNotAfter}
 * must recover EXACTLY the {@code notAfter} that
 * {@link DeviceCertificateAuthority#issue} wrote into the certificate, and must
 * fail soft (return {@code null}, never throw) on garbage input - a single
 * unparsable row must never abort the backfill.
 */
class CertificateNotAfterBackfillRunnerTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @TempDir
    Path caDir;

    @Test
    void parsesNotAfterFromAnIssuedCertificateExactly() throws Exception {
        TestPki.writeCa(caDir);
        Instant now = Instant.parse("2026-11-06T12:00:00Z");
        DeviceCertificateAuthority ca = new DeviceCertificateAuthority(caDir, 825,
                Clock.fixed(now, ZoneOffset.UTC));
        String csrPem = TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=irrelevant");
        DeviceCertificateAuthority.IssuedCertificate issued =
                ca.issue(Csrs.parseAndValidate(csrPem), TENANT, SITE, DEVICE);

        Instant parsed = CertificateNotAfterBackfillRunner.parseNotAfter(issued.certPem());

        // X.509 notAfter has second precision - the comparison must too.
        assertThat(parsed).isEqualTo(issued.notAfter().truncatedTo(java.time.temporal.ChronoUnit.SECONDS));
        assertThat(parsed).isEqualTo(now.plus(java.time.Duration.ofDays(825))
                .truncatedTo(java.time.temporal.ChronoUnit.SECONDS));
    }

    @Test
    void returnsNullForUnparsablePemInsteadOfThrowing() {
        assertThat(CertificateNotAfterBackfillRunner.parseNotAfter("not a certificate")).isNull();
        assertThat(CertificateNotAfterBackfillRunner.parseNotAfter(null)).isNull();
    }
}
