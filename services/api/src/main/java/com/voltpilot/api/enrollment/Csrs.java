package com.voltpilot.api.enrollment;

import java.io.IOException;
import java.io.StringReader;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.operator.jcajce.JcaContentVerifierProviderBuilder;
import org.bouncycastle.pkcs.PKCS10CertificationRequest;
import org.bouncycastle.pkcs.jcajce.JcaPKCS10CertificationRequest;

/**
 * Parsing + policy validation of device-supplied PKCS#10 CSRs. The subject a
 * CSR requests is deliberately NOT validated (or honored) anywhere - the CA
 * overrides it with the claim-derived identity (see
 * {@link DeviceCertificateAuthority}); what matters here is that the request is
 * well-formed, self-signed by the enclosed key (proof of possession) and the
 * key meets the platform policy: RSA &gt;= 2048 bits or EC P-256/P-384.
 */
public final class Csrs {

    /** Accepted EC field sizes (P-256 / P-384). */
    private static final int[] EC_FIELD_BITS = {256, 384};
    private static final int MIN_RSA_BITS = 2048;

    static final String INVALID_MESSAGE =
            "Der Zertifikatsantrag (CSR) konnte nicht gelesen werden. Erwartet wird ein "
                    + "PEM-kodierter PKCS#10-Antrag.";
    static final String SIGNATURE_MESSAGE =
            "Die Signatur des Zertifikatsantrags ist ungültig.";
    static final String KEY_POLICY_MESSAGE =
            "Der Schlüssel des Zertifikatsantrags entspricht nicht der Richtlinie: "
                    + "erlaubt sind RSA ab 2048 Bit oder EC P-256/P-384.";

    private Csrs() {
    }

    /**
     * Parses and fully validates a PEM CSR. Throws {@link InvalidCsrException}
     * on any refusal; returns the parsed request otherwise.
     */
    public static PKCS10CertificationRequest parseAndValidate(String csrPem) {
        PKCS10CertificationRequest csr = parse(csrPem);
        PublicKey key = publicKeyOf(csr);
        requireAcceptedKey(key);
        requireValidSignature(csr, key);
        return csr;
    }

    private static PKCS10CertificationRequest parse(String csrPem) {
        try (PEMParser parser = new PEMParser(new StringReader(csrPem))) {
            Object parsed = parser.readObject();
            if (parsed instanceof PKCS10CertificationRequest csr) {
                return csr;
            }
            throw new InvalidCsrException(INVALID_MESSAGE);
        } catch (InvalidCsrException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw new InvalidCsrException(INVALID_MESSAGE, e);
        }
    }

    private static PublicKey publicKeyOf(PKCS10CertificationRequest csr) {
        try {
            return new JcaPKCS10CertificationRequest(csr)
                    .setProvider(new BouncyCastleProvider()).getPublicKey();
        } catch (Exception e) {
            throw new InvalidCsrException(KEY_POLICY_MESSAGE, e);
        }
    }

    private static void requireAcceptedKey(PublicKey key) {
        if (key instanceof RSAPublicKey rsa) {
            if (rsa.getModulus().bitLength() < MIN_RSA_BITS) {
                throw new InvalidCsrException(KEY_POLICY_MESSAGE);
            }
            return;
        }
        if (key instanceof ECPublicKey ec) {
            int fieldBits = ec.getParams().getCurve().getField().getFieldSize();
            for (int accepted : EC_FIELD_BITS) {
                if (fieldBits == accepted) {
                    return;
                }
            }
            throw new InvalidCsrException(KEY_POLICY_MESSAGE);
        }
        throw new InvalidCsrException(KEY_POLICY_MESSAGE);
    }

    private static void requireValidSignature(PKCS10CertificationRequest csr, PublicKey key) {
        try {
            if (!csr.isSignatureValid(new JcaContentVerifierProviderBuilder()
                    .setProvider(new BouncyCastleProvider()).build(key))) {
                throw new InvalidCsrException(SIGNATURE_MESSAGE);
            }
        } catch (InvalidCsrException e) {
            throw e;
        } catch (Exception e) {
            throw new InvalidCsrException(SIGNATURE_MESSAGE, e);
        }
    }
}
