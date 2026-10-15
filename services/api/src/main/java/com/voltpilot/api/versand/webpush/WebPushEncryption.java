package com.voltpilot.api.versand.webpush;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.generators.HKDFBytesGenerator;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;
import org.bouncycastle.crypto.params.ECPublicKeyParameters;
import org.bouncycastle.crypto.params.HKDFParameters;

/**
 * Nutzlast-Verschlüsselung nach RFC 8291 ("Message Encryption for Web Push") über die
 * Inhaltskodierung {@code aes128gcm} aus RFC 8188: ein frisches ECDH-Schlüsselpaar je Nachricht, das
 * gemeinsame Geheimnis mit dem Auth-Secret des Abos über HKDF (RFC 5869) zu einem Inhalts-
 * Verschlüsselungsschlüssel (CEK) und einer Nonce verdichtet, dann EIN AES-128-GCM-Datensatz.
 *
 * <p>Kein Padding über das Pflicht-Trennzeichen {@code 0x02} hinaus - die Nutzlast (kurze JSON-Texte)
 * braucht keine Verschleierung ihrer Länge.
 */
final class WebPushEncryption {

    private static final byte[] INFO_PRAEFIX = "WebPush: info".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] CEK_INFO = "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] NONCE_INFO = "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII);
    private static final int REKORD_GROESSE = 4096;

    private WebPushEncryption() {
    }

    /**
     * @param uaOeffentlich65 {@code p256dh} des Abos (65 Bytes, unkomprimierter Punkt)
     * @param authGeheimnis16 {@code auth} des Abos (16 Bytes)
     */
    static byte[] verschluesseln(byte[] uaOeffentlich65, byte[] authGeheimnis16, byte[] klartext,
            SecureRandom zufall) {
        AsymmetricCipherKeyPair eigenesSchluesselpaar = P256.neuesSchluesselpaar(zufall);
        ECPrivateKeyParameters eigenerPrivat = (ECPrivateKeyParameters) eigenesSchluesselpaar.getPrivate();
        ECPublicKeyParameters eigenerOeffentlich = (ECPublicKeyParameters) eigenesSchluesselpaar.getPublic();
        byte[] eigenerOeffentlich65 = P256.unkomprimiertePunktBytes(eigenerOeffentlich);

        ECPublicKeyParameters uaSchluessel = P256.schluesselOeffentlich(uaOeffentlich65);
        byte[] ecdhGeheimnis = P256.ecdh(eigenerPrivat, uaSchluessel);

        byte[] infoWebpush = konkat(INFO_PRAEFIX, new byte[] {0}, uaOeffentlich65, eigenerOeffentlich65);
        byte[] ikm = hkdf(ecdhGeheimnis, authGeheimnis16, infoWebpush, 32);

        byte[] salz = new byte[16];
        zufall.nextBytes(salz);
        byte[] cek = hkdf(ikm, salz, CEK_INFO, 16);
        byte[] nonce = hkdf(ikm, salz, NONCE_INFO, 12);

        byte[] mitTrennzeichen = konkat(klartext, new byte[] {2});
        byte[] schnittstelle = aesGcm(cek, nonce, mitTrennzeichen);

        ByteBuffer kopf = ByteBuffer.allocate(16 + 4 + 1 + eigenerOeffentlich65.length);
        kopf.put(salz);
        kopf.putInt(REKORD_GROESSE);
        kopf.put((byte) eigenerOeffentlich65.length);
        kopf.put(eigenerOeffentlich65);
        return konkat(kopf.array(), schnittstelle);
    }

    private static byte[] hkdf(byte[] ikm, byte[] salz, byte[] info, int laenge) {
        HKDFBytesGenerator generator = new HKDFBytesGenerator(new SHA256Digest());
        generator.init(new HKDFParameters(ikm, salz, info));
        byte[] ausgabe = new byte[laenge];
        generator.generateBytes(ausgabe, 0, laenge);
        return ausgabe;
    }

    private static byte[] aesGcm(byte[] schluessel16, byte[] nonce12, byte[] klartext) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(schluessel16, "AES"), new GCMParameterSpec(128, nonce12));
            return cipher.doFinal(klartext);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Web-Push: AES-GCM fehlgeschlagen", e);
        }
    }

    private static byte[] konkat(byte[]... teile) {
        int laenge = 0;
        for (byte[] t : teile) {
            laenge += t.length;
        }
        byte[] ergebnis = new byte[laenge];
        int pos = 0;
        for (byte[] t : teile) {
            System.arraycopy(t, 0, ergebnis, pos, t.length);
            pos += t.length;
        }
        return ergebnis;
    }
}
