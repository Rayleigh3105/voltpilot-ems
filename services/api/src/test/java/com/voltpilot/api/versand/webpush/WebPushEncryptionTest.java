package com.voltpilot.api.versand.webpush;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
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
import org.junit.jupiter.api.Test;

/**
 * Rundweg-Prüfung von {@link WebPushEncryption} (RFC 8291): diese Klasse spielt die SEITE DES
 * BROWSERS nach - eigenes, von der Produktionsklasse UNABHÄNGIGES HKDF/AES-GCM, das den
 * verschlüsselten Datensatz wieder zum Klartext entschlüsselt. Ein echter Browser/Push-Dienst steht
 * im Testlauf nicht zur Verfügung (§7 "Push-Versand gegen einen lokalen Test-Endpunkt"); dieser Test
 * ist der Beleg, dass die Bytes, die {@link WebPushAdapter} verschickt, tatsächlich das RFC-Format
 * einhalten und mit dem richtigen Schlüssel wieder lesbar sind.
 */
class WebPushEncryptionTest {

    @Test
    void verschluesselterDatensatzLaesstSichMitDemAboSchluesselWiederLesen() {
        SecureRandom zufall = new SecureRandom();
        AsymmetricCipherKeyPair uaSchluesselpaar = P256.neuesSchluesselpaar(zufall);
        ECPrivateKeyParameters uaPrivat = (ECPrivateKeyParameters) uaSchluesselpaar.getPrivate();
        byte[] uaOeffentlich65 = P256.unkomprimiertePunktBytes((ECPublicKeyParameters) uaSchluesselpaar.getPublic());
        byte[] authGeheimnis16 = new byte[16];
        zufall.nextBytes(authGeheimnis16);
        String klartext = "{\"titel\":\"Dringend: Netzbezug Halle 1\",\"text\":\"über 120 kW\"}";

        byte[] datensatz = WebPushEncryption.verschluesseln(uaOeffentlich65, authGeheimnis16,
                klartext.getBytes(StandardCharsets.UTF_8), zufall);

        String entschluesselt = alsBrowserEntschluesseln(datensatz, uaPrivat, uaOeffentlich65, authGeheimnis16);
        assertThat(entschluesselt).isEqualTo(klartext);
    }

    @Test
    void jedeNachrichtBekommtEinNeuesEphemeresSchluesselpaarUndSalz() {
        SecureRandom zufall = new SecureRandom();
        AsymmetricCipherKeyPair uaSchluesselpaar = P256.neuesSchluesselpaar(zufall);
        byte[] uaOeffentlich65 = P256.unkomprimiertePunktBytes((ECPublicKeyParameters) uaSchluesselpaar.getPublic());
        byte[] authGeheimnis16 = new byte[16];
        zufall.nextBytes(authGeheimnis16);
        byte[] klartext = "gleiche Nachricht".getBytes(StandardCharsets.UTF_8);

        byte[] erster = WebPushEncryption.verschluesseln(uaOeffentlich65, authGeheimnis16, klartext, zufall);
        byte[] zweiter = WebPushEncryption.verschluesseln(uaOeffentlich65, authGeheimnis16, klartext, zufall);

        assertThat(erster).isNotEqualTo(zweiter);
    }

    /** Unabhängige Nachbildung der Browser-Seite - teilt KEINEN Code mit {@link WebPushEncryption}. */
    private static String alsBrowserEntschluesseln(byte[] datensatz, ECPrivateKeyParameters uaPrivat,
            byte[] uaOeffentlich65, byte[] authGeheimnis16) {
        ByteBuffer puffer = ByteBuffer.wrap(datensatz);
        byte[] salz = new byte[16];
        puffer.get(salz);
        puffer.getInt(); // Rekordgröße - für eine einzelne Nachricht ohne Belang
        int idLaenge = puffer.get() & 0xFF;
        byte[] asOeffentlich65 = new byte[idLaenge];
        puffer.get(asOeffentlich65);
        byte[] koerper = new byte[puffer.remaining()];
        puffer.get(koerper);

        ECPublicKeyParameters asOeffentlich = P256.schluesselOeffentlich(asOeffentlich65);
        byte[] ecdhGeheimnis = P256.ecdh(uaPrivat, asOeffentlich);

        byte[] infoWebpush = konkat("WebPush: info".getBytes(StandardCharsets.US_ASCII), new byte[] {0},
                uaOeffentlich65, asOeffentlich65);
        byte[] ikm = hkdf(ecdhGeheimnis, authGeheimnis16, infoWebpush, 32);
        byte[] cek = hkdf(ikm, salz, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = hkdf(ikm, salz, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);

        byte[] mitTrennzeichen = aesGcmEntschluesseln(cek, nonce, koerper);
        assertThat(mitTrennzeichen[mitTrennzeichen.length - 1]).isEqualTo((byte) 2);
        return new String(mitTrennzeichen, 0, mitTrennzeichen.length - 1, StandardCharsets.UTF_8);
    }

    private static byte[] hkdf(byte[] ikm, byte[] salz, byte[] info, int laenge) {
        HKDFBytesGenerator generator = new HKDFBytesGenerator(new SHA256Digest());
        generator.init(new HKDFParameters(ikm, salz, info));
        byte[] ausgabe = new byte[laenge];
        generator.generateBytes(ausgabe, 0, laenge);
        return ausgabe;
    }

    private static byte[] aesGcmEntschluesseln(byte[] schluessel16, byte[] nonce12, byte[] chiffretext) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(schluessel16, "AES"),
                    new GCMParameterSpec(128, nonce12));
            return cipher.doFinal(chiffretext);
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
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
