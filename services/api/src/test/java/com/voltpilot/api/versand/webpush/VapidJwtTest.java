package com.voltpilot.api.versand.webpush;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.params.ECDomainParameters;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.params.ECPublicKeyParameters;
import org.bouncycastle.crypto.signers.ECDSASigner;
import org.bouncycastle.math.ec.ECPoint;
import org.junit.jupiter.api.Test;

/** RFC 8292: der Push-Dienst prüft die VAPID-Signatur mit dem öffentlichen Schlüssel - das hier tut. */
class VapidJwtTest {

    @Test
    void jwtIstMitDemOeffentlichenSchluesselPruefbarUndTraegtDieErwartetenAnsprueche() {
        SecureRandom zufall = new SecureRandom();
        AsymmetricCipherKeyPair schluesselpaar = P256.neuesSchluesselpaar(zufall);
        ECPrivateKeyParameters privat = (ECPrivateKeyParameters) schluesselpaar.getPrivate();
        ECPublicKeyParameters oeffentlich = (ECPublicKeyParameters) schluesselpaar.getPublic();

        String jwt = VapidJwt.erzeugen("https://push.example.org", "mailto:meldungen@voltpilot.de",
                Duration.ofHours(1), privat);

        String[] teile = jwt.split("\\.");
        assertThat(teile).hasSize(3);
        String header = new String(Base64Url.decode(teile[0]), StandardCharsets.UTF_8);
        String claims = new String(Base64Url.decode(teile[1]), StandardCharsets.UTF_8);
        assertThat(header).isEqualTo("{\"typ\":\"JWT\",\"alg\":\"ES256\"}");
        assertThat(claims).contains("\"aud\":\"https://push.example.org\"")
                .contains("\"sub\":\"mailto:meldungen@voltpilot.de\"");

        byte[] signierbar = (teile[0] + "." + teile[1]).getBytes(StandardCharsets.US_ASCII);
        byte[] signatur = Base64Url.decode(teile[2]);
        assertThat(signatur).hasSize(64);
        assertThat(signaturPrueft(signierbar, signatur, oeffentlich)).isTrue();

        byte[] verfaelscht = signatur.clone();
        verfaelscht[0] ^= 1;
        assertThat(signaturPrueft(signierbar, verfaelscht, oeffentlich)).isFalse();
    }

    @Test
    void zweiAufrufeErgebenUnterschiedlicheSignaturenTrotzDeterministischemK() {
        // RFC 6979 (HMacDSAKCalculator) ist deterministisch IM K-Wert, nicht in der Nachricht -
        // unterschiedliche "exp"-Werte (Systemzeit) ergeben trotzdem unterschiedliche JWTs.
        AsymmetricCipherKeyPair schluesselpaar = P256.neuesSchluesselpaar(new SecureRandom());
        ECPrivateKeyParameters privat = (ECPrivateKeyParameters) schluesselpaar.getPrivate();
        String erstes = VapidJwt.erzeugen("https://a.example", "mailto:a@b.de", Duration.ofMinutes(1), privat);
        String zweites = VapidJwt.erzeugen("https://b.example", "mailto:a@b.de", Duration.ofMinutes(1), privat);
        assertThat(erstes).isNotEqualTo(zweites);
    }

    private static boolean signaturPrueft(byte[] daten, byte[] signatur64, ECPublicKeyParameters oeffentlich) {
        SHA256Digest digest = new SHA256Digest();
        byte[] hash = new byte[digest.getDigestSize()];
        digest.update(daten, 0, daten.length);
        digest.doFinal(hash, 0);
        BigInteger r = new BigInteger(1, java.util.Arrays.copyOfRange(signatur64, 0, 32));
        BigInteger s = new BigInteger(1, java.util.Arrays.copyOfRange(signatur64, 32, 64));
        ECDSASigner verifier = new ECDSASigner();
        verifier.init(false, oeffentlich);
        return verifier.verifySignature(hash, r, s);
    }

    /** Beleg, dass {@link P256#neuesSchluesselpaar} tatsächlich auf secp256r1 liegt (Punkt auf der Kurve). */
    @Test
    void erzeugterOeffentlicherSchluesselLiegtAufDerKurve() {
        AsymmetricCipherKeyPair paar = P256.neuesSchluesselpaar(new SecureRandom());
        ECDomainParameters domain = P256.domainParameter();
        ECPublicKeyParameters oeffentlich = (ECPublicKeyParameters) paar.getPublic();
        ECPoint nachgebaut = domain.getCurve().decodePoint(P256.unkomprimiertePunktBytes(oeffentlich));
        assertThat(nachgebaut.isValid()).isTrue();
        assertThat(nachgebaut.equals(oeffentlich.getQ())).isTrue();
    }
}
