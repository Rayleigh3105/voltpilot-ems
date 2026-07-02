package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import javax.security.auth.x500.X500Principal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Pure unit proof of the api-side certificate signer (no Spring, no Docker):
 * the claim-derived identity is enforced regardless of the CSR's subject, the
 * extensions mirror openssl.cnf [v3_device], and issuance records into the
 * openssl CA database (serial protocol + index.txt) so the shell tooling keeps
 * working over api-issued certificates.
 */
class DeviceCertificateAuthorityTest {

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    @TempDir
    Path caDir;

    private X509Certificate caCert;
    private DeviceCertificateAuthority ca;

    @BeforeEach
    void setUp() throws Exception {
        caCert = TestPki.writeCa(caDir);
        ca = new DeviceCertificateAuthority(caDir, 825,
                Clock.fixed(Instant.parse("2026-07-02T12:00:00Z"), ZoneOffset.UTC));
    }

    @Test
    void issuesClientCertWithClaimDerivedIdentityIgnoringTheCsrSubject() throws Exception {
        KeyPair deviceKey = TestPki.rsaKeyPair(2048);
        // The CSR requests a hostile subject - it must not survive signing.
        String csrPem = TestPki.csrPem(deviceKey, "CN=attacker,O=evil-corp,OU=takeover");

        DeviceCertificateAuthority.IssuedCertificate issued = ca.issue(
                Csrs.parseAndValidate(csrPem), TENANT, SITE, DEVICE);

        X509Certificate cert = TestPki.parseCertificate(issued.certPem());
        // Identity comes from the claim: O=tenant, OU=site, CN=device_id.
        String subject = cert.getSubjectX500Principal().getName(X500Principal.RFC2253);
        assertThat(subject).contains("CN=" + DEVICE).contains("O=" + TENANT).contains("OU=" + SITE);
        assertThat(subject).doesNotContain("attacker").doesNotContain("evil-corp");
        // The device's own key is certified.
        assertThat(cert.getPublicKey()).isEqualTo(deviceKey.getPublic());
        // Chain validates against the CA.
        cert.verify(caCert.getPublicKey());
        // openssl.cnf [v3_device] extensions: clientAuth EKU, critical keyUsage
        // digitalSignature+keyEncipherment, CA:FALSE, SPIFFE URI SAN.
        assertThat(cert.getExtendedKeyUsage()).containsExactly("1.3.6.1.5.5.7.3.2");
        assertThat(cert.getKeyUsage()[0]).isTrue();  // digitalSignature
        assertThat(cert.getKeyUsage()[2]).isTrue();  // keyEncipherment
        assertThat(cert.getBasicConstraints()).isEqualTo(-1);
        assertThat(cert.getSubjectAlternativeNames()).anySatisfy(san -> {
            assertThat(san.get(0)).isEqualTo(6); // uniformResourceIdentifier
            assertThat(san.get(1)).isEqualTo(
                    "spiffe://voltpilot/ems/" + TENANT + "/" + SITE + "/" + DEVICE);
        });
    }

    @Test
    void recordsIssuanceIntoTheOpensslCaDatabase() throws Exception {
        KeyPair deviceKey = TestPki.rsaKeyPair(2048);
        DeviceCertificateAuthority.IssuedCertificate first = ca.issue(
                Csrs.parseAndValidate(TestPki.csrPem(deviceKey, "CN=x")), TENANT, SITE, DEVICE);
        assertThat(first.serialHex()).isEqualTo("1000");

        // openssl serial protocol: the file now holds the NEXT serial...
        assertThat(Files.readString(caDir.resolve("serial")).trim()).isEqualTo("1001");
        // ...the cert is archived under its serial...
        assertThat(caDir.resolve("newcerts/1000.pem")).exists();
        // ...and index.txt got an openssl-ca-format line (V, expiry, empty
        // revocation date, serial, unknown filename, /-separated subject) -
        // which is what `openssl ca -revoke` resolves a certificate by.
        List<String> index = Files.readAllLines(caDir.resolve("index.txt"), StandardCharsets.UTF_8);
        assertThat(index).hasSize(1);
        assertThat(index.get(0)).matches(
                "V\\t\\d{12}Z\\t\\t1000\\tunknown\\t/O=" + TENANT + "/OU=" + SITE + "/CN=" + DEVICE);

        // The next issuance uses the next serial.
        DeviceCertificateAuthority.IssuedCertificate second = ca.issue(
                Csrs.parseAndValidate(TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=y")),
                TENANT, SITE, UUID.randomUUID());
        assertThat(second.serialHex()).isEqualTo("1001");
        assertThat(Files.readString(caDir.resolve("serial")).trim()).isEqualTo("1002");
    }

    @Test
    void aMissingCaFailsTheIssuanceNotTheConstruction() throws Exception {
        DeviceCertificateAuthority broken = new DeviceCertificateAuthority(
                caDir.resolve("does-not-exist"), 825, Clock.systemUTC());
        String csrPem = TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=x");
        assertThatThrownBy(() -> broken.issue(Csrs.parseAndValidate(csrPem), TENANT, SITE, DEVICE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("cannot load device CA");
    }
}
