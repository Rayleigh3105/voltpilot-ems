package com.voltpilot.api.enrollment;

import java.io.FileReader;
import java.io.IOException;
import java.io.StringWriter;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.PrivateKey;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.UUID;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x500.X500NameBuilder;
import org.bouncycastle.asn1.x500.style.BCStyle;
import org.bouncycastle.asn1.x509.BasicConstraints;
import org.bouncycastle.asn1.x509.ExtendedKeyUsage;
import org.bouncycastle.asn1.x509.Extension;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.asn1.x509.GeneralNames;
import org.bouncycastle.asn1.x509.KeyPurposeId;
import org.bouncycastle.asn1.x509.KeyUsage;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.JcaX509ExtensionUtils;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMKeyPair;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter;
import org.bouncycastle.openssl.jcajce.JcaPEMWriter;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;

/**
 * The api-side signer of device client certificates - the Java twin of
 * {@code tools/pki/voltpilot-ca.sh issue}, operating on the SAME CA working
 * directory so both issuers share one serial sequence and one certificate
 * database, and the shell tool's {@code revoke}/{@code gen-crl}/{@code list}
 * keep working over api-issued certificates:
 *
 * <ul>
 *   <li>Subject is ALWAYS the claim-derived identity
 *       {@code O=tenant_id, OU=site_id, CN=device_id} - whatever subject the
 *       CSR requested is ignored (a device proves key possession, never picks
 *       its identity).</li>
 *   <li>Extensions mirror {@code openssl.cnf [v3_device]}: CA:FALSE, critical
 *       keyUsage digitalSignature+keyEncipherment, EKU clientAuth, SKI/AKI, and
 *       the SPIFFE-style URI SAN
 *       {@code spiffe://voltpilot/ems/{tenant}/{site}/{device}}.</li>
 *   <li>The serial comes from the CA dir's {@code serial} file (read, used,
 *       written back incremented - openssl's own protocol), the issued cert is
 *       recorded in {@code index.txt} (openssl's ca database format, which is
 *       what {@code openssl ca -revoke} looks a cert up in) and archived under
 *       {@code newcerts/<SERIAL>.pem}.</li>
 * </ul>
 *
 * <p>Issuance is serialized with a lock: the serial-file read-increment-write
 * must not interleave. Multi-instance deployments must not share a CA dir
 * without external coordination (the single-VM deployment has one api).
 *
 * <p>Security consideration (docs/security-mqtt.md): wiring the CA key into the
 * api makes the api host part of the PKI trust boundary. This class is the
 * whole signing code path, and every issuance is audit-logged by the caller.
 */
class DeviceCertificateAuthority {

    private static final DateTimeFormatter INDEX_DATE =
            DateTimeFormatter.ofPattern("yyMMddHHmmss'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);
    /** Back-dated notBefore absorbs device clock skew right after first boot. */
    private static final Duration NOT_BEFORE_SKEW = Duration.ofMinutes(5);

    private final Path caDir;
    private final int certDays;
    private final Clock clock;
    private final Object lock = new Object();

    // Loaded lazily so a misconfigured CA dir fails the first issuance (503),
    // not api startup - enrollment must never take the whole portal down.
    private X509CertificateHolder caCert;
    private PrivateKey caKey;
    private String caPem;

    DeviceCertificateAuthority(Path caDir, int certDays, Clock clock) {
        this.caDir = caDir;
        this.certDays = certDays;
        this.clock = clock;
    }

    record IssuedCertificate(String certPem, String serialHex) {
    }

    /** The CA certificate PEM (what the device needs to verify the broker). */
    String caPem() {
        synchronized (lock) {
            loadCa();
            return caPem;
        }
    }

    IssuedCertificate issue(PKCS10CertificationRequest csr, UUID tenantId, UUID siteId,
            UUID deviceId) {
        synchronized (lock) {
            try {
                loadCa();
                BigInteger serial = nextSerial();
                Instant now = clock.instant();
                Instant notAfter = now.plus(Duration.ofDays(certDays));

                X500Name subject = new X500NameBuilder(BCStyle.INSTANCE)
                        .addRDN(BCStyle.O, tenantId.toString())
                        .addRDN(BCStyle.OU, siteId.toString())
                        .addRDN(BCStyle.CN, deviceId.toString())
                        .build();

                X509v3CertificateBuilder builder = new X509v3CertificateBuilder(
                        caCert.getSubject(), serial,
                        java.util.Date.from(now.minus(NOT_BEFORE_SKEW)),
                        java.util.Date.from(notAfter),
                        subject, csr.getSubjectPublicKeyInfo());

                JcaX509ExtensionUtils ext = new JcaX509ExtensionUtils();
                builder.addExtension(Extension.basicConstraints, false,
                        new BasicConstraints(false));
                builder.addExtension(Extension.keyUsage, true,
                        new KeyUsage(KeyUsage.digitalSignature | KeyUsage.keyEncipherment));
                builder.addExtension(Extension.extendedKeyUsage, false,
                        new ExtendedKeyUsage(KeyPurposeId.id_kp_clientAuth));
                builder.addExtension(Extension.subjectKeyIdentifier, false,
                        ext.createSubjectKeyIdentifier(csr.getSubjectPublicKeyInfo()));
                builder.addExtension(Extension.authorityKeyIdentifier, false,
                        ext.createAuthorityKeyIdentifier(caCert));
                builder.addExtension(Extension.subjectAlternativeName, false,
                        new GeneralNames(new GeneralName(GeneralName.uniformResourceIdentifier,
                                "spiffe://voltpilot/ems/" + tenantId + "/" + siteId + "/" + deviceId)));

                ContentSigner signer = new JcaContentSignerBuilder(signatureAlgorithm())
                        .setProvider(new BouncyCastleProvider()).build(caKey);
                X509CertificateHolder issued = builder.build(signer);

                String serialHex = toSerialHex(serial);
                String certPem = toPem(issued);
                archive(issued, certPem, serialHex, subject, notAfter);
                return new IssuedCertificate(certPem, serialHex);
            } catch (IOException | java.security.GeneralSecurityException
                    | org.bouncycastle.operator.OperatorCreationException e) {
                throw new IllegalStateException("certificate issuance failed: " + e.getMessage(), e);
            }
        }
    }

    private void loadCa() {
        if (caKey != null) {
            return;
        }
        Path certPath = caDir.resolve("ca.crt");
        Path keyPath = caDir.resolve("ca.key");
        try (PEMParser certParser = new PEMParser(new FileReader(certPath.toFile(), StandardCharsets.US_ASCII));
                PEMParser keyParser = new PEMParser(new FileReader(keyPath.toFile(), StandardCharsets.US_ASCII))) {
            Object cert = certParser.readObject();
            if (!(cert instanceof X509CertificateHolder holder)) {
                throw new IllegalStateException(certPath + " is not an X.509 certificate");
            }
            Object key = keyParser.readObject();
            JcaPEMKeyConverter converter = new JcaPEMKeyConverter().setProvider(new BouncyCastleProvider());
            PrivateKey privateKey;
            if (key instanceof PEMKeyPair pair) { // PKCS#1 (openssl genrsa)
                privateKey = converter.getPrivateKey(pair.getPrivateKeyInfo());
            } else if (key instanceof org.bouncycastle.asn1.pkcs.PrivateKeyInfo info) { // PKCS#8
                privateKey = converter.getPrivateKey(info);
            } else {
                throw new IllegalStateException(keyPath + " is not an unencrypted private key");
            }
            this.caCert = holder;
            this.caKey = privateKey;
            this.caPem = toPem(holder);
        } catch (IOException e) {
            throw new IllegalStateException("cannot load device CA from " + caDir
                    + " (expected ca.crt + unencrypted ca.key): " + e.getMessage(), e);
        }
    }

    /**
     * openssl's serial protocol: the {@code serial} file holds the NEXT serial
     * as hex; use it and write back +1. Initialized at 0x1000 when absent (the
     * value {@code init-ca} seeds).
     */
    private BigInteger nextSerial() throws IOException {
        Path serialFile = caDir.resolve("serial");
        BigInteger serial = Files.exists(serialFile)
                ? new BigInteger(Files.readString(serialFile, StandardCharsets.US_ASCII).trim(), 16)
                : BigInteger.valueOf(0x1000);
        Files.writeString(serialFile, toSerialHex(serial.add(BigInteger.ONE)) + "\n",
                StandardCharsets.US_ASCII);
        return serial;
    }

    /**
     * Records the issued certificate the way {@code openssl ca} would: one
     * {@code index.txt} line (status V, expiry, empty revocation date, serial,
     * "unknown" filename, subject) plus the archived PEM in {@code newcerts/} -
     * so revocation ({@code openssl ca -revoke}, which resolves the cert by
     * serial in this database), {@code gen-crl} and {@code list} all keep
     * working over api-issued certificates.
     */
    private void archive(X509CertificateHolder issued, String certPem, String serialHex,
            X500Name subject, Instant notAfter) throws IOException {
        Path newcerts = caDir.resolve("newcerts");
        Files.createDirectories(newcerts);
        Files.writeString(newcerts.resolve(serialHex + ".pem"), certPem, StandardCharsets.US_ASCII);
        String indexLine = "V\t" + INDEX_DATE.format(notAfter) + "\t\t" + serialHex
                + "\tunknown\t" + openSslSubject(subject) + "\n";
        Files.writeString(caDir.resolve("index.txt"), indexLine, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    /** openssl one-line subject format: {@code /O=.../OU=.../CN=...}. */
    private static String openSslSubject(X500Name subject) {
        StringBuilder sb = new StringBuilder();
        for (org.bouncycastle.asn1.x500.RDN rdn : subject.getRDNs()) {
            String type = BCStyle.INSTANCE.oidToDisplayName(rdn.getFirst().getType());
            sb.append('/').append(type).append('=').append(rdn.getFirst().getValue());
        }
        return sb.toString();
    }

    /** Uppercase hex, padded to even length - the shape openssl writes. */
    private static String toSerialHex(BigInteger serial) {
        String hex = serial.toString(16).toUpperCase(Locale.ROOT);
        return hex.length() % 2 == 0 ? hex : "0" + hex;
    }

    private String signatureAlgorithm() {
        return caKey.getAlgorithm().equals("EC") ? "SHA256withECDSA" : "SHA256withRSA";
    }

    private static String toPem(Object bcObject) throws IOException {
        StringWriter out = new StringWriter();
        try (JcaPEMWriter writer = new JcaPEMWriter(out)) {
            writer.writeObject(bcObject);
        }
        return out.toString();
    }
}
