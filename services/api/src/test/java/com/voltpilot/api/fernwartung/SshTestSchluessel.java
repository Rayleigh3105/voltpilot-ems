package com.voltpilot.api.fernwartung;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.interfaces.RSAPublicKey;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Öffentliche SSH-Schlüssel für Tests, zur Laufzeit erzeugt: der private Teil
 * verlässt die Methode nie und steht in keiner Datei.
 *
 * <p>Die Kodierung hier ist bewusst eine ZWEITE, von {@link SshSchluessel}
 * unabhängige Fassung des SSH-Formats, damit die Tests nicht die Prüfung mit
 * sich selbst vergleichen.
 */
public final class SshTestSchluessel {

    private static final Map<Integer, RSAPublicKey> RSA = new ConcurrentHashMap<>();

    private SshTestSchluessel() {
    }

    /** {@code ssh-rsa <Base64>} eines frisch erzeugten Schlüssels dieser Länge (je Länge einmal je Testlauf). */
    public static String rsa(int bits) {
        RSAPublicKey k = RSA.computeIfAbsent(bits, SshTestSchluessel::erzeuge);
        return rsa(k.getPublicExponent(), k.getModulus());
    }

    /** Ein weiterer, anderer Schlüssel derselben Länge. */
    public static String rsaNeu(int bits) {
        RSAPublicKey k = erzeuge(bits);
        return rsa(k.getPublicExponent(), k.getModulus());
    }

    /** Eine {@code ssh-rsa}-Zeile aus beliebigen Zahlen - auch aus solchen, die kein Schlüssel sind. */
    public static String rsa(BigInteger e, BigInteger n) {
        return zeile("ssh-rsa", "ssh-rsa".getBytes(StandardCharsets.US_ASCII), e.toByteArray(), n.toByteArray());
    }

    /** {@code ssh-ed25519 <Base64>} eines frisch erzeugten Schlüssels. */
    public static String ed25519() {
        try {
            byte[] x509 = KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic().getEncoded();
            byte[] roh = java.util.Arrays.copyOfRange(x509, x509.length - 32, x509.length);
            return zeile("ssh-ed25519", "ssh-ed25519".getBytes(StandardCharsets.US_ASCII), roh);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code <typ> <Base64 der Felder>}: jedes Feld mit vier Byte Länge davor. */
    public static String zeile(String typ, byte[]... felder) {
        ByteArrayOutputStream aus = new ByteArrayOutputStream();
        for (byte[] feld : felder) {
            aus.writeBytes(ByteBuffer.allocate(4).putInt(feld.length).array());
            aus.writeBytes(feld);
        }
        return typ + " " + Base64.getEncoder().encodeToString(aus.toByteArray());
    }

    /** Der Fingerabdruck, wie {@code ssh-keygen -lf} ihn zeigt, aus dem Base64-Teil der Zeile. */
    public static String fingerabdruck(String zeile) {
        try {
            byte[] blob = Base64.getDecoder().decode(zeile.split(" ")[1]);
            return "SHA256:" + Base64.getEncoder().withoutPadding()
                    .encodeToString(MessageDigest.getInstance("SHA-256").digest(blob));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static RSAPublicKey erzeuge(int bits) {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
            g.initialize(bits);
            return (RSAPublicKey) g.generateKeyPair().getPublic();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
