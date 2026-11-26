package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.lingala.zip4j.exception.ZipException;
import net.lingala.zip4j.io.inputstream.ZipInputStream;
import net.lingala.zip4j.model.LocalFileHeader;
import org.springframework.stereotype.Component;

/**
 * Öffnet eine Zugangsdatei (ZIP + Passwort, Konzept vp-direktvermarktung-konzept d2 §5.7 "Die
 * Zugangsdatei") AUSSCHLIESSLICH im Speicher - nie ein Byte auf die Platte (ship-scope.md Zeile 13).
 * Übernimmt nur Zertifikat, Schlüssel, CA, optional den TLS-Schlüssel und Gegenstelle/Port aus der
 * mitgelieferten OpenVPN-Konfiguration (das übliche "unified"-Format mit {@code <ca>}/{@code <cert>}/
 * {@code <key>}/{@code <tls-crypt>}/{@code <tls-auth>}-Blöcken und einer {@code remote}-Zeile) - verwirft
 * alles andere und das Passwort selbst. Kein Byte des Inhalts erreicht je ein Log.
 *
 * <p>Die Box erzeugt ihre eigene OpenVPN-Konfiguration aus dem Schlüsselmaterial
 * ({@code script-security 0}, keine {@code up}/{@code down}-Skripte, {@code remote-cert-tls server}) -
 * diese Klasse übernimmt deshalb nie fremde OpenVPN-Direktiven, nur die vier benannten Blöcke und die
 * Gegenstelle.
 */
@Component
public class ZugangsdateiOeffner {

    /** Zip-Bombe/Missbrauch-Schranken: eine Zugangsdatei ist eine Handvoll winziger Textdateien. */
    private static final int MAX_EINTRAEGE = 20;
    private static final long MAX_EINTRAG_BYTES = 64 * 1024;
    private static final long MAX_GESAMT_BYTES = 256 * 1024;

    private static final Pattern SICHERER_EINTRAGSNAME = Pattern.compile("^[A-Za-z0-9_.\\- ]+$");
    private static final Pattern REMOTE_ZEILE =
            Pattern.compile("^\\s*remote\\s+(\\S+)\\s+(\\d+)(?:\\s+(tcp|udp)\\S*)?\\s*$",
                    Pattern.CASE_INSENSITIVE | Pattern.MULTILINE);

    public ZugangsdateiOeffner() {
        this(new ObjectMapper());
    }

    private final ObjectMapper json;

    ZugangsdateiOeffner(ObjectMapper json) {
        this.json = json;
    }

    /** Eine der fünf Fehlerarten aus §5.7 - der Controller/Dienst bildet daraus den Ablehnungs-Code. */
    public enum Fehler { PASSWORT_FALSCH, KEINE_ZUGANGSDATEI, BESCHAEDIGT, ABGELAUFEN }

    public record Geoeffnet(ObjectNode klartext, String fingerabdruck, Instant gueltigBis) {}

    public sealed interface Ergebnis permits Erfolg, Fehlschlag {}
    public record Erfolg(Geoeffnet geoeffnet) implements Ergebnis {}
    public record Fehlschlag(Fehler fehler) implements Ergebnis {}

    /**
     * Öffnet die ZIP mit dem Passwort, prüft Größe/Anzahl/Namen der Einträge, sucht die OpenVPN-
     * Konfiguration und baut daraus das Klartext-JSON für {@link AesGcmPartnerzugangSpeicher}.
     * {@code jetzt} kommt vom Aufrufer (Testbarkeit) - die Ablaufprüfung vergleicht dagegen.
     */
    public Ergebnis oeffne(byte[] zip, String passwort, Instant jetzt) {
        if (zip == null || zip.length == 0 || passwort == null || passwort.isEmpty()) {
            return new Fehlschlag(Fehler.KEINE_ZUGANGSDATEI);
        }
        String konfiguration;
        try {
            konfiguration = findeKonfiguration(zip, passwort.toCharArray());
        } catch (FalschesPasswort e) {
            return new Fehlschlag(Fehler.PASSWORT_FALSCH);
        } catch (Beschaedigt e) {
            return new Fehlschlag(Fehler.BESCHAEDIGT);
        }
        if (konfiguration == null) {
            return new Fehlschlag(Fehler.KEINE_ZUGANGSDATEI);
        }

        String ca = block(konfiguration, "ca");
        String cert = block(konfiguration, "cert");
        String key = block(konfiguration, "key");
        String tlsCrypt = block(konfiguration, "tls-crypt");
        String tlsAuth = tlsCrypt == null ? block(konfiguration, "tls-auth") : null;
        Matcher remote = REMOTE_ZEILE.matcher(konfiguration);
        if (ca == null || cert == null || key == null || !remote.find()) {
            return new Fehlschlag(Fehler.KEINE_ZUGANGSDATEI);
        }

        X509Certificate zertifikat;
        try {
            zertifikat = parseZertifikat(cert);
        } catch (CertificateException | IllegalArgumentException e) {
            return new Fehlschlag(Fehler.BESCHAEDIGT);
        }
        Instant gueltigBis = zertifikat.getNotAfter().toInstant();
        if (gueltigBis.isBefore(jetzt)) {
            return new Fehlschlag(Fehler.ABGELAUFEN);
        }
        String fingerabdruck;
        try {
            fingerabdruck = fingerabdruck(zertifikat);
        } catch (CertificateEncodingException | NoSuchAlgorithmException e) {
            return new Fehlschlag(Fehler.BESCHAEDIGT);
        }

        ObjectNode gegenstelle = json.createObjectNode();
        gegenstelle.put("host", remote.group(1));
        gegenstelle.put("port", Integer.parseInt(remote.group(2)));
        gegenstelle.put("protokoll", remote.group(3) == null ? "udp" : remote.group(3).toLowerCase(Locale.ROOT));

        ObjectNode dateien = json.createObjectNode();
        dateien.put("zertifikat_pem", cert);
        dateien.put("schluessel_pem", key);
        dateien.put("ca_pem", ca);
        if (tlsCrypt != null) dateien.put("tls_schluessel_pem", tlsCrypt);
        else if (tlsAuth != null) dateien.put("tls_schluessel_pem", tlsAuth);

        ObjectNode klartext = json.createObjectNode();
        klartext.set("gegenstelle", gegenstelle);
        klartext.put("tls_schluessel", tlsCrypt != null ? "tls_crypt" : tlsAuth != null ? "tls_auth" : "keine");
        klartext.set("dateien", dateien);

        return new Erfolg(new Geoeffnet(klartext, fingerabdruck, gueltigBis));
    }

    private static final class FalschesPasswort extends RuntimeException {}
    private static final class Beschaedigt extends RuntimeException {}

    /**
     * Liest jeden Eintrag unter den Schranken, sucht eine Text-Konfiguration ({@code .ovpn}/{@code .conf})
     * mit den erwarteten Blöcken. {@code null} = geöffnet, aber keine passende Datei gefunden.
     */
    private String findeKonfiguration(byte[] zip, char[] passwort) {
        int eintraege = 0;
        long gesamt = 0;
        String gefunden = null;
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(zip), passwort)) {
            LocalFileHeader eintrag;
            while ((eintrag = zis.getNextEntry()) != null) {
                if (++eintraege > MAX_EINTRAEGE) throw new Beschaedigt();
                String name = eintrag.getFileName();
                if (name == null || name.isBlank() || name.endsWith("/")) continue;
                String basisname = name.contains("/") ? name.substring(name.lastIndexOf('/') + 1) : name;
                if (!SICHERER_EINTRAGSNAME.matcher(basisname).matches() || name.contains("..")) {
                    throw new Beschaedigt();
                }
                ByteArrayOutputStream inhalt = new ByteArrayOutputStream();
                byte[] puffer = new byte[4096];
                int n;
                long eintragGroesse = 0;
                while ((n = zis.read(puffer)) != -1) {
                    eintragGroesse += n;
                    gesamt += n;
                    if (eintragGroesse > MAX_EINTRAG_BYTES || gesamt > MAX_GESAMT_BYTES) throw new Beschaedigt();
                    inhalt.write(puffer, 0, n);
                }
                String unten = basisname.toLowerCase(Locale.ROOT);
                if (gefunden == null && (unten.endsWith(".ovpn") || unten.endsWith(".conf"))) {
                    gefunden = inhalt.toString(java.nio.charset.StandardCharsets.UTF_8);
                }
            }
        } catch (Beschaedigt | FalschesPasswort e) {
            throw e;
        } catch (ZipException e) {
            if (e.getType() == ZipException.Type.WRONG_PASSWORD) throw new FalschesPasswort();
            throw new Beschaedigt();
        } catch (IOException e) {
            throw new Beschaedigt();
        }
        return gefunden;
    }

    /** Der Inhalt eines {@code <tag>...</tag>}-Blocks (OpenVPN-"unified"-Format), getrimmt; {@code null} ohne ihn. */
    private static String block(String konfiguration, String tag) {
        Matcher m = Pattern.compile("<" + tag + ">(.*?)</" + tag + ">", Pattern.DOTALL).matcher(konfiguration);
        if (!m.find()) return null;
        String inhalt = m.group(1).strip();
        return inhalt.isEmpty() ? null : inhalt;
    }

    private static X509Certificate parseZertifikat(String certPem) throws CertificateException {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        return (X509Certificate) cf.generateCertificate(
                new ByteArrayInputStream(certPem.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    /** SHA-256 über die DER-Kodierung, klein geschrieben und mit Doppelpunkt getrennt (Muster der Admin-Akte). */
    private static String fingerabdruck(X509Certificate zertifikat)
            throws CertificateEncodingException, NoSuchAlgorithmException {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(zertifikat.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
            if (sb.length() > 0) sb.append(':');
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
