package com.voltpilot.api.enrollment;

import java.io.IOException;
import java.io.StringWriter;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Date;
import javax.security.auth.x500.X500Principal;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder;
import org.bouncycastle.openssl.jcajce.JcaPEMWriter;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import org.bouncycastle.pkcs.jcajce.JcaPKCS10CertificationRequestBuilder;

/**
 * Test PKI: generates a throwaway device CA in the exact on-disk layout
 * {@code tools/pki/voltpilot-ca.sh init-ca} produces (ca.crt, unencrypted
 * ca.key, serial seeded 1000, empty index.txt, newcerts/), plus device
 * keypairs and PEM CSRs - so enrollment tests run without openssl or Docker.
 */
public final class TestPki {

    private TestPki() {
    }

    /** Creates the CA working dir and returns the CA certificate. */
    public static X509Certificate writeCa(Path caDir) throws Exception {
        KeyPair caKey = rsaKeyPair(2048);
        X500Principal subject = new X500Principal("O=VoltPilot,CN=VoltPilot Device CA (test)");
        Date now = new Date();
        X509CertificateHolder holder = new JcaX509v3CertificateBuilder(
                subject, BigInteger.valueOf(1), now,
                new Date(now.getTime() + 365L * 24 * 3600 * 1000), subject, caKey.getPublic())
                .addExtension(Extension.basicConstraints, true, new BasicConstraints(0))
                .addExtension(Extension.keyUsage, true,
                        new KeyUsage(KeyUsage.keyCertSign | KeyUsage.cRLSign))
                .build(new JcaContentSignerBuilder("SHA256withRSA").build(caKey.getPrivate()));

        Files.createDirectories(caDir.resolve("newcerts"));
        Files.writeString(caDir.resolve("ca.crt"), toPem(holder), StandardCharsets.US_ASCII);
        Files.writeString(caDir.resolve("ca.key"), toPem(caKey.getPrivate()), StandardCharsets.US_ASCII);
        Files.writeString(caDir.resolve("serial"), "1000\n", StandardCharsets.US_ASCII);
        Files.writeString(caDir.resolve("index.txt"), "", StandardCharsets.US_ASCII);
        return toX509(holder);
    }

    public static KeyPair rsaKeyPair(int bits) throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(bits);
        return gen.generateKeyPair();
    }

    public static KeyPair ecKeyPair(String curve) throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("EC");
        gen.initialize(new ECGenParameterSpec(curve));
        return gen.generateKeyPair();
    }

    /** PEM CSR self-signed by {@code keyPair}, requesting the given subject. */
    public static String csrPem(KeyPair keyPair, String subject) throws Exception {
        String algorithm = keyPair.getPrivate().getAlgorithm().equals("EC")
                ? "SHA256withECDSA" : "SHA256withRSA";
        PKCS10CertificationRequest csr = new JcaPKCS10CertificationRequestBuilder(
                new X500Principal(subject), keyPair.getPublic())
                .build(new JcaContentSignerBuilder(algorithm).build(keyPair.getPrivate()));
        return toPem(csr);
    }

    public static X509Certificate parseCertificate(String pem) throws Exception {
        return (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new java.io.ByteArrayInputStream(
                        pem.getBytes(StandardCharsets.US_ASCII)));
    }

    private static X509Certificate toX509(X509CertificateHolder holder) throws Exception {
        return parseCertificate(toPem(holder));
    }

    private static String toPem(Object bcOrJcaObject) throws IOException {
        StringWriter out = new StringWriter();
        try (JcaPEMWriter writer = new JcaPEMWriter(out)) {
            writer.writeObject(bcOrJcaObject);
        }
        return out.toString();
    }
}
