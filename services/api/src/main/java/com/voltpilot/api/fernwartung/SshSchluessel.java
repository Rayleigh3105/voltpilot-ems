package com.voltpilot.api.fernwartung;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Optional;

/**
 * Prüfung des öffentlichen SSH-Schlüssels eines Technikers (Fenster-Schlüssel,
 * Entscheid des Kapitäns vom 09.10.2026). Wie beim WireGuard-Schlüssel kommt
 * hier nur der ÖFFENTLICHE Teil an; der private bleibt auf dem Gerät.
 *
 * <p><b>Nur RSA.</b> Der Dropbear der Boxen (OpenWrt 25.12.5 auf der Mango)
 * nimmt nur {@code ssh-rsa}-Schlüssel an, Ed25519 und ECDSA weist er ab. Ein
 * solcher Schlüssel wird deshalb gleich hier abgelehnt, mit dem Befehl, der
 * einen passenden erzeugt - sonst scheiterte der Techniker erst an der Box.
 *
 * <p><b>Gespeichert wird die Normalform:</b> {@code ssh-rsa <Base64>}, ohne
 * Kommentar, ohne Optionen, der Schlüssel neu und kürzestmöglich kodiert.
 * Dropbear vergleicht die Bytes der Schlüsseldatei mit dem, was der Client
 * anbietet; nur die Normalform passt sicher dazu. Der Fingerabdruck ist der,
 * den {@code ssh-keygen -lf} für dieselbe Datei zeigt.
 *
 * <p>Die grobe Form steht zusätzlich als CHECK in der Migration
 * V20261009074500. Der Tunnel-Dienst und die Box prüfen noch einmal selbst.
 */
public final class SshSchluessel {

    public static final String TYP = "ssh-rsa";
    public static final int MIN_BITS = 2048;
    /** Bis hierher ist die Anmeldung am Dropbear der Mango belegt. */
    public static final int MAX_BITS = 4096;
    /** Der Befehl, den jede Ablehnung wegen Typ oder Länge nennt. */
    public static final String ERZEUGEN = "ssh-keygen -t rsa -b 3072";

    /** Eine Zeile mit Kommentar bleibt weit darunter; alles Längere ist kein Schlüssel. */
    private static final int MAX_EINGABE = 2000;
    /** Größer wird der öffentliche Exponent in der Praxis nie (üblich: 65537). */
    private static final int MAX_EXPONENT_BITS = 32;

    /** Ein geprüfter Schlüssel in Normalform. */
    public record Geprueft(String zeile, String fingerabdruck, int bits) {
    }

    /** Die Eingabe ist kein annehmbarer Schlüssel; die Meldung sagt, warum. */
    public static final class Ungueltig extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        Ungueltig(String meldung) {
            super(meldung);
        }
    }

    private SshSchluessel() {
    }

    /**
     * Prüft die Zeile aus einer {@code .pub}-Datei und liefert die Normalform.
     *
     * @throws Ungueltig mit einer Meldung für den Menschen am Portal. Die
     *                   Meldung wiederholt die Eingabe nie: es könnte ein
     *                   privater Schlüssel sein.
     */
    public static Geprueft pruefe(String eingabe) {
        String text = eingabe == null ? "" : eingabe.strip();
        if (text.isEmpty()) {
            throw new Ungueltig("Der SSH-Schlüssel fehlt.");
        }
        if (text.contains("PRIVATE KEY")) {
            throw new Ungueltig("Das ist ein privater Schlüssel. Er gehört nie ins Portal. Bitte die Zeile aus "
                    + "der Datei mit der Endung .pub eintragen.");
        }
        if (text.length() > MAX_EINGABE) {
            throw new Ungueltig("Das ist kein öffentlicher SSH-Schlüssel: die Eingabe ist zu lang.");
        }
        if (text.chars().anyMatch(c -> c == '\n' || c == '\r')) {
            throw new Ungueltig("Der SSH-Schlüssel muss genau eine Zeile sein: der Inhalt der .pub-Datei, "
                    + "ohne Zeilenumbruch.");
        }
        if (text.chars().anyMatch(c -> c != '\t' && Character.isISOControl(c))) {
            throw new Ungueltig(KEIN_SCHLUESSEL);
        }
        String[] teile = text.split("[ \\t]+");
        String typ = teile[0];
        String fremd = fremderTyp(typ);
        if (fremd != null) {
            throw new Ungueltig("Das ist " + fremd + ". Die Boxen nehmen nur RSA an. Bitte einen "
                    + "RSA-Schlüssel erzeugen: " + ERZEUGEN);
        }
        if (!TYP.equals(typ)) {
            for (int i = 1; i < teile.length; i++) {
                if (TYP.equals(teile[i])) {
                    throw new Ungueltig("Vor dem Schlüssel dürfen keine Optionen stehen: die Zeile muss mit "
                            + "„ssh-rsa\" beginnen.");
                }
            }
            throw new Ungueltig(KEIN_SCHLUESSEL);
        }
        if (teile.length < 2) {
            throw new Ungueltig(BESCHAEDIGT);
        }
        byte[] blob;
        try {
            blob = Base64.getDecoder().decode(teile[1]);
        } catch (IllegalArgumentException e) {
            throw new Ungueltig(BESCHAEDIGT);
        }
        BigInteger e;
        BigInteger n;
        try {
            ByteBuffer b = ByteBuffer.wrap(blob);
            if (!TYP.equals(new String(feld(b), StandardCharsets.US_ASCII))) {
                throw new Ungueltig(BESCHAEDIGT);
            }
            e = new BigInteger(feld(b));
            n = new BigInteger(feld(b));
            if (b.hasRemaining()) {
                throw new Ungueltig(BESCHAEDIGT);
            }
        } catch (java.nio.BufferUnderflowException | NumberFormatException ex) {
            throw new Ungueltig(BESCHAEDIGT);
        }
        // Kein echter RSA-Schlüssel: der Modulus ist ungerade und positiv, der
        // Exponent ungerade und mindestens 3.
        if (n.signum() <= 0 || !n.testBit(0) || e.compareTo(BigInteger.TWO) <= 0 || !e.testBit(0)
                || e.bitLength() > MAX_EXPONENT_BITS) {
            throw new Ungueltig(BESCHAEDIGT);
        }
        int bits = n.bitLength();
        if (bits < MIN_BITS) {
            throw new Ungueltig("Der RSA-Schlüssel hat nur " + bits + " Bit, verlangt sind mindestens " + MIN_BITS
                    + ". Bitte einen neuen erzeugen: " + ERZEUGEN);
        }
        if (bits > MAX_BITS) {
            throw new Ungueltig("Der RSA-Schlüssel hat " + bits + " Bit, die Boxen sind nur bis " + MAX_BITS
                    + " Bit geprüft. Bitte einen neuen erzeugen: " + ERZEUGEN);
        }
        byte[] normal = kodiere(e, n);
        return new Geprueft(TYP + " " + Base64.getEncoder().encodeToString(normal), fingerabdruck(normal), bits);
    }

    /**
     * Ein gespeicherter Schlüssel, wie ihn Portal und Soll-Stand zeigen. Leer,
     * wenn keiner hinterlegt ist - oder wenn der gespeicherte Wert die Prüfung
     * nicht (mehr) besteht oder nicht in Normalform ist: dann geht er weder an
     * den Tunnel-Dienst noch erscheint er im Portal als hinterlegt.
     */
    public static Optional<Geprueft> gespeichert(String zeile) {
        if (zeile == null) {
            return Optional.empty();
        }
        try {
            Geprueft g = pruefe(zeile);
            return g.zeile().equals(zeile) ? Optional.of(g) : Optional.empty();
        } catch (Ungueltig e) {
            return Optional.empty();
        }
    }

    private static final String KEIN_SCHLUESSEL = "Das ist kein öffentlicher SSH-Schlüssel. Erwartet wird die "
            + "eine Zeile aus der .pub-Datei; sie beginnt mit „ssh-rsa AAAA\".";
    private static final String BESCHAEDIGT = "Der SSH-Schlüssel ist beschädigt oder unvollständig. Bitte die "
            + "ganze Zeile aus der .pub-Datei kopieren.";

    /** Ein Schlüsseltyp, den OpenSSH kennt und die Box nicht annimmt, als Satzteil - sonst null. */
    private static String fremderTyp(String typ) {
        if (typ.startsWith("sk-")) {
            return "ein FIDO-Sicherheitsschlüssel";
        }
        if (typ.startsWith("ssh-ed25519")) {
            return "ein Ed25519-Schlüssel";
        }
        if (typ.startsWith("ecdsa-sha2-")) {
            return "ein ECDSA-Schlüssel";
        }
        if (typ.startsWith("ssh-dss")) {
            return "ein DSA-Schlüssel";
        }
        return null;
    }

    /** Ein Feld des SSH-Formats: vier Byte Länge, dann die Bytes. */
    private static byte[] feld(ByteBuffer b) {
        int laenge = b.getInt();
        if (laenge < 0 || laenge > b.remaining()) {
            throw new java.nio.BufferUnderflowException();
        }
        byte[] feld = new byte[laenge];
        b.get(feld);
        return feld;
    }

    private static byte[] kodiere(BigInteger e, BigInteger n) {
        ByteArrayOutputStream aus = new ByteArrayOutputStream();
        for (byte[] feld : new byte[][] {TYP.getBytes(StandardCharsets.US_ASCII), e.toByteArray(),
                n.toByteArray()}) {
            aus.writeBytes(ByteBuffer.allocate(4).putInt(feld.length).array());
            aus.writeBytes(feld);
        }
        return aus.toByteArray();
    }

    /** Wie {@code ssh-keygen -lf}: SHA-256 über den Schlüssel, Base64 ohne Füllzeichen. */
    private static String fingerabdruck(byte[] blob) {
        try {
            return "SHA256:" + Base64.getEncoder().withoutPadding()
                    .encodeToString(MessageDigest.getInstance("SHA-256").digest(blob));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
