package com.voltpilot.api.versand.webpush;

import java.math.BigInteger;
import java.security.SecureRandom;
import org.bouncycastle.asn1.x9.X9ECParameters;
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.agreement.ECDHBasicAgreement;
import org.bouncycastle.crypto.ec.CustomNamedCurves;
import org.bouncycastle.crypto.generators.ECKeyPairGenerator;
import org.bouncycastle.crypto.params.ECDomainParameters;
import org.bouncycastle.crypto.params.ECKeyGenerationParameters;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.params.ECPublicKeyParameters;
import org.bouncycastle.math.ec.ECPoint;

/**
 * Elliptische Kurve secp256r1 (P-256, "prime256v1") über die Low-Level-API von BouncyCastle - sowohl
 * ECDH (RFC 8291, Nutzlast-Verschlüsselung) als auch ECDSA (RFC 8292, VAPID) brauchen dieselben
 * Kurvenparameter und dieselbe Schlüsselform (unkomprimierter Punkt, 65 Bytes = {@code 0x04 || X || Y}).
 */
final class P256 {

    private static final int FELD_BYTES = 32;

    private P256() {
    }

    static ECDomainParameters domainParameter() {
        X9ECParameters p = CustomNamedCurves.getByName("secp256r1");
        return new ECDomainParameters(p.getCurve(), p.getG(), p.getN(), p.getH());
    }

    static ECPublicKeyParameters schluesselOeffentlich(byte[] unkomprimiert65) {
        ECDomainParameters domain = domainParameter();
        ECPoint punkt = domain.getCurve().decodePoint(unkomprimiert65);
        return new ECPublicKeyParameters(punkt, domain);
    }

    static ECPrivateKeyParameters schluesselPrivat(byte[] skalar32) {
        return new ECPrivateKeyParameters(new BigInteger(1, skalar32), domainParameter());
    }

    static AsymmetricCipherKeyPair neuesSchluesselpaar(SecureRandom zufall) {
        ECKeyPairGenerator generator = new ECKeyPairGenerator();
        generator.init(new ECKeyGenerationParameters(domainParameter(), zufall));
        return generator.generateKeyPair();
    }

    static byte[] unkomprimiertePunktBytes(ECPublicKeyParameters schluessel) {
        return schluessel.getQ().getEncoded(false);
    }

    /** ECDH nach RFC 8291: das gemeinsame Geheimnis, fest auf die Feldgröße aufgefüllt (32 Bytes). */
    static byte[] ecdh(ECPrivateKeyParameters eigenerPrivat, ECPublicKeyParameters fremdOeffentlich) {
        ECDHBasicAgreement agreement = new ECDHBasicAgreement();
        agreement.init(eigenerPrivat);
        BigInteger geheimnis = agreement.calculateAgreement(fremdOeffentlich);
        return aufFesteLaenge(geheimnis, FELD_BYTES);
    }

    static byte[] aufFesteLaenge(BigInteger zahl, int laenge) {
        byte[] roh = zahl.toByteArray();
        if (roh.length == laenge) {
            return roh;
        }
        byte[] ergebnis = new byte[laenge];
        if (roh.length > laenge) {
            // Vorzeichen-Byte (0x00) einer zu langen zweierkomplement-Darstellung abschneiden.
            System.arraycopy(roh, roh.length - laenge, ergebnis, 0, laenge);
        } else {
            System.arraycopy(roh, 0, ergebnis, laenge - roh.length, roh.length);
        }
        return ergebnis;
    }
}
