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
import java.util.List;
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

    /**
     * Ein DNS-Name wie RFC 1035/1123 ihn formt: Labels aus Buchstaben, Ziffern und inneren Bindestrichen,
     * je 1-63 Zeichen, insgesamt höchstens 253 - mehr Zeichenvorrat gibt es nicht. Ein IPv4-Literal hat
     * dieselbe Form (nur Ziffern-Labels) und ist damit mit abgedeckt; IPv6 prüft {@link #istIpv6Literal}.
     * Geprüft wird immer die kleingeschriebene Form.
     */
    private static final Pattern DNS_NAME = Pattern.compile(
            "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$");

    /** Der eingebettete IPv4-Schwanz eines IPv6-Literals ("::ffff:192.0.2.1"): strikt 0-255, keine führende Null. */
    private static final Pattern IPV4_LITERAL = Pattern.compile(
            "^(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$");

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

    /** Wie {@link #oeffne(byte[], String, Instant, List)} ohne Gegenstellen-Schranke (Partner ohne Liste). */
    public Ergebnis oeffne(byte[] zip, String passwort, Instant jetzt) {
        return oeffne(zip, passwort, jetzt, List.of());
    }

    /**
     * Öffnet die ZIP mit dem Passwort, prüft Größe/Anzahl/Namen der Einträge, sucht die OpenVPN-
     * Konfiguration und baut daraus das Klartext-JSON für {@link AesGcmPartnerzugangSpeicher}.
     * {@code jetzt} kommt vom Aufrufer (Testbarkeit) - die Ablaufprüfung vergleicht dagegen.
     *
     * <p>Die Gegenstelle der {@code remote}-Zeile wird geprüft, BEVOR irgendetwas gespeichert wird: der
     * Host nur als DNS-Name oder IPv4-/IPv6-Literal (kein anderes Zeichen, Länge begrenzt), der Port als
     * 1-65535, das Protokoll nur wörtlich {@code tcp} oder {@code udp}. Trägt das Partnerprofil
     * {@code zugang.vpn.gegenstellen} (eine Liste erlaubter Host-Muster,
     * {@code catalog/direktvermarkter/vectors/gegenstellen.json}), muss der Host zusätzlich einem Muster
     * entsprechen. Es zählt die ERSTE {@code remote}-Zeile - eine ungültige erste Zeile lehnt die Datei
     * ab, statt still auf eine spätere auszuweichen.
     */
    public Ergebnis oeffne(byte[] zip, String passwort, Instant jetzt, List<String> erlaubteGegenstellen) {
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
        GepruefteGegenstelle gegenstelleZeile = gegenstelleAusKonfiguration(konfiguration);
        if (ca == null || cert == null || key == null || gegenstelleZeile == null) {
            return new Fehlschlag(Fehler.KEINE_ZUGANGSDATEI);
        }
        if (!gegenstelleErlaubt(gegenstelleZeile.host(), erlaubteGegenstellen)) {
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
        gegenstelle.put("host", gegenstelleZeile.host());
        gegenstelle.put("port", gegenstelleZeile.port());
        gegenstelle.put("protokoll", gegenstelleZeile.protokoll());

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

    /** Die geprüfte Gegenstelle der ersten {@code remote}-Zeile: Host kleingeschrieben, Protokoll aufgelöst. */
    private record GepruefteGegenstelle(String host, int port, String protokoll) {}

    /**
     * Die ERSTE {@code remote}-Zeile der Konfiguration, streng geprüft ({@code remote <host> <port> [proto]},
     * das Format des OpenVPN-"unified"-Pakets). Eine ungültige erste Zeile liefert {@code null} (Ablehnung) -
     * nie ein stilles Ausweichen auf eine spätere Zeile. Direktiven, die nur mit "remote" BEGINNEN
     * ({@code remote-cert-tls}, {@code remote-random}), zählen nicht.
     */
    private static GepruefteGegenstelle gegenstelleAusKonfiguration(String konfiguration) {
        for (String zeile : konfiguration.split("\\r?\\n")) {
            String s = zeile.strip();
            if (s.length() < 7 || !s.regionMatches(true, 0, "remote", 0, 6)
                    || !Character.isWhitespace(s.charAt(6))) {
                continue;
            }
            String[] token = s.split("\\s+");
            if (token.length < 3 || token.length > 4) return null;
            String host = token[1].toLowerCase(Locale.ROOT);
            if (!istGueltigerHost(host)) return null;
            if (token[2].length() > 5 || !token[2].chars().allMatch(Character::isDigit)) return null;
            int port = Integer.parseInt(token[2]);
            if (port < 1 || port > 65535) return null;
            String protokoll = token.length == 4 ? token[3].toLowerCase(Locale.ROOT) : "udp";
            if (!protokoll.equals("tcp") && !protokoll.equals("udp")) return null;
            return new GepruefteGegenstelle(host, port, protokoll);
        }
        return null;
    }

    /** Ein gültiger Host: DNS-Name (deckt IPv4-Literale mit ab) oder IPv6-Literal; immer kleingeschrieben prüfen. */
    private static boolean istGueltigerHost(String host) {
        if (host.isEmpty() || host.length() > 253) return false;
        if (host.indexOf(':') >= 0) return istIpv6Literal(host);
        return DNS_NAME.matcher(host).matches();
    }

    /**
     * Ein IPv6-Literal (RFC 4291, ohne Klammern und ohne Zone - so steht es in einer OpenVPN-remote-Zeile):
     * höchstens ein {@code ::}, Gruppen aus 1-4 Hexziffern, am Ende optional ein IPv4-Schwanz, der als zwei
     * Gruppen zählt; ohne {@code ::} genau 8 Gruppen, mit höchstens 7. Zwilling der Python-Prüfung in
     * {@code catalog/direktvermarkter/tools/profilelib.py}, belegt über
     * {@code catalog/direktvermarkter/vectors/gegenstellen.json}.
     */
    private static boolean istIpv6Literal(String s) {
        if (s.length() < 2 || s.length() > 45) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != ':' && c != '.' && Character.digit(c, 16) < 0) return false;
        }
        int doppelt = s.indexOf("::");
        if (doppelt >= 0 && s.indexOf("::", doppelt + 1) >= 0) return false;
        String vorn = doppelt >= 0 ? s.substring(0, doppelt) : null;
        String hinten = doppelt >= 0 ? s.substring(doppelt + 2) : s;
        int gruppen = 0;
        if (vorn != null && !vorn.isEmpty()) {
            for (String g : vorn.split(":", -1)) {
                if (!istHexGruppe(g)) return false;
                gruppen++;
            }
        }
        if (!hinten.isEmpty()) {
            String[] teile = hinten.split(":", -1);
            for (int i = 0; i < teile.length; i++) {
                if (i == teile.length - 1 && teile[i].indexOf('.') >= 0) {
                    if (!IPV4_LITERAL.matcher(teile[i]).matches()) return false;
                    gruppen += 2;
                } else {
                    if (!istHexGruppe(teile[i])) return false;
                    gruppen++;
                }
            }
        }
        return doppelt >= 0 ? gruppen <= 7 : gruppen == 8;
    }

    private static boolean istHexGruppe(String g) {
        if (g.isEmpty() || g.length() > 4) return false;
        for (int i = 0; i < g.length(); i++) {
            if (Character.digit(g.charAt(i), 16) < 0) return false;
        }
        return true;
    }

    /**
     * Die Gegenstellen-Schranke des Partnerprofils ({@code zugang.vpn.gegenstellen}): eine leere Liste
     * heißt "keine Schranke" (so steht luox heute da, F1 offen); sonst muss der Host einem Muster
     * entsprechen. Ein Muster ist ein exakter Host (Vergleich kleingeschrieben, IP-Literale nach Wortlaut)
     * oder {@code *.domain} (jeder Host, der auf {@code .domain} endet, mindestens ein weiteres Label).
     * Ein ungültiges Muster passt NIE (geschlossen scheitern) - die Autorenseite weist es schon
     * {@code catalog/direktvermarkter/tools/validate.py} ab. Semantik belegt in
     * {@code catalog/direktvermarkter/vectors/gegenstellen.json}.
     */
    static boolean gegenstelleErlaubt(String host, List<String> muster) {
        if (muster == null || muster.isEmpty()) return true;
        String h = host.toLowerCase(Locale.ROOT);
        for (String eintrag : muster) {
            if (eintrag == null) continue;
            String m = eintrag.strip().toLowerCase(Locale.ROOT);
            if (!istGueltigesMuster(m)) continue;
            if (m.startsWith("*.")) {
                String endung = m.substring(1); // ".domain"
                if (h.length() > endung.length() && h.endsWith(endung)) return true;
            } else if (h.equals(m)) {
                return true;
            }
        }
        return false;
    }

    /** Ein gültiges Gegenstellen-Muster: ein gültiger Host, optional mit führendem {@code *.} vor einem DNS-Namen. */
    static boolean istGueltigesMuster(String muster) {
        if (muster == null || muster.isEmpty()) return false;
        String m = muster.toLowerCase(Locale.ROOT);
        if (m.startsWith("*.")) {
            String rest = m.substring(2);
            return rest.indexOf(':') < 0 && istGueltigerHost(rest);
        }
        return istGueltigerHost(m);
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
