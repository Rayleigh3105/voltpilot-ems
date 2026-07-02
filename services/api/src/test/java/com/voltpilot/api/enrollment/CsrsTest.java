package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/** Pure unit proof of the CSR acceptance policy (no Spring, no Docker). */
class CsrsTest {

    @Test
    void acceptsRsa2048AndEcP256() throws Exception {
        assertThat(Csrs.parseAndValidate(
                TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=dev"))).isNotNull();
        assertThat(Csrs.parseAndValidate(
                TestPki.csrPem(TestPki.ecKeyPair("secp256r1"), "CN=dev"))).isNotNull();
    }

    @Test
    void refusesWeakOrOffPolicyKeys() throws Exception {
        String weakRsa = TestPki.csrPem(TestPki.rsaKeyPair(1024), "CN=dev");
        assertThatThrownBy(() -> Csrs.parseAndValidate(weakRsa))
                .isInstanceOf(InvalidCsrException.class)
                .hasMessageContaining("Richtlinie");

        String offCurve = TestPki.csrPem(TestPki.ecKeyPair("secp521r1"), "CN=dev");
        assertThatThrownBy(() -> Csrs.parseAndValidate(offCurve))
                .isInstanceOf(InvalidCsrException.class)
                .hasMessageContaining("Richtlinie");
    }

    @Test
    void refusesGarbageAndNonCsrPem() throws Exception {
        assertThatThrownBy(() -> Csrs.parseAndValidate("not pem at all"))
                .isInstanceOf(InvalidCsrException.class);
        // Valid PEM, wrong object type (a certificate, not a CSR).
        java.nio.file.Path tmp = java.nio.file.Files.createTempDirectory("csr-test-ca");
        TestPki.writeCa(tmp);
        String certPem = java.nio.file.Files.readString(tmp.resolve("ca.crt"));
        assertThatThrownBy(() -> Csrs.parseAndValidate(certPem))
                .isInstanceOf(InvalidCsrException.class);
    }

    @Test
    void refusesATamperedSignature() throws Exception {
        // A CSR whose body was altered after signing: swap the embedded subject
        // by rebuilding the PEM with a bit flipped in the base64 payload.
        String csr = TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=dev");
        String[] lines = csr.split("\n");
        // Flip a character in the middle of the base64 body (not header/footer).
        int mid = lines.length / 2;
        char[] chars = lines[mid].toCharArray();
        chars[10] = chars[10] == 'A' ? 'B' : 'A';
        lines[mid] = new String(chars);
        String tampered = String.join("\n", lines);
        assertThatThrownBy(() -> Csrs.parseAndValidate(tampered))
                .isInstanceOf(InvalidCsrException.class);
    }
}
