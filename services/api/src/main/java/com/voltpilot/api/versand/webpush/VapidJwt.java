package com.voltpilot.api.versand.webpush;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.signers.ECDSASigner;
import org.bouncycastle.crypto.signers.HMacDSAKCalculator;

/**
 * VAPID (RFC 8292): ein selbst signiertes JWT, das dem Push-Dienst beweist, welcher Absender eine
 * Zustellung schickt - {@code ES256} mit der ROHEN Signaturform ({@code r || s}, je 32 Bytes), nicht
 * der DER-Kodierung normaler JCA-Signaturen. Deterministisch signiert (RFC 6979 über
 * {@link HMacDSAKCalculator}), kein Zufallsgenerator nötig.
 */
final class VapidJwt {

    private static final byte[] HEADER = base64UrlOfUtf8("{\"typ\":\"JWT\",\"alg\":\"ES256\"}");

    private VapidJwt() {
    }

    static String erzeugen(String audience, String subjectMailto, Duration gueltig, ECPrivateKeyParameters schluessel) {
        long exp = Instant.now().plus(gueltig).getEpochSecond();
        String claimsJson = "{\"aud\":\"" + audience + "\",\"exp\":" + exp + ",\"sub\":\"" + subjectMailto + "\"}";
        String signierbar = new String(HEADER, StandardCharsets.US_ASCII) + "."
                + Base64Url.encode(claimsJson.getBytes(StandardCharsets.UTF_8));
        byte[] signatur = signieren(signierbar.getBytes(StandardCharsets.US_ASCII), schluessel);
        return signierbar + "." + Base64Url.encode(signatur);
    }

    private static byte[] signieren(byte[] daten, ECPrivateKeyParameters schluessel) {
        SHA256Digest digest = new SHA256Digest();
        byte[] hash = new byte[digest.getDigestSize()];
        digest.update(daten, 0, daten.length);
        digest.doFinal(hash, 0);

        ECDSASigner signer = new ECDSASigner(new HMacDSAKCalculator(new SHA256Digest()));
        signer.init(true, schluessel);
        BigInteger[] rs = signer.generateSignature(hash);
        byte[] r = P256.aufFesteLaenge(rs[0], 32);
        byte[] s = P256.aufFesteLaenge(rs[1], 32);
        byte[] signatur = new byte[64];
        System.arraycopy(r, 0, signatur, 0, 32);
        System.arraycopy(s, 0, signatur, 32, 32);
        return signatur;
    }

    private static byte[] base64UrlOfUtf8(String text) {
        return Base64Url.encode(text.getBytes(StandardCharsets.UTF_8)).getBytes(StandardCharsets.US_ASCII);
    }
}
