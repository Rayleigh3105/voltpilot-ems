package com.voltpilot.api.uems;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Die EINE Darstellung der Adresse einer Datenquelle (Vertrag
 * {@code docs/contracts/v2/data-source-assignment.md} §3 Nr. 5: „Die Regeln vergleichen die
 * Adresse so, wie sie gespeichert ist. Die Normalisierung — Host klein, ohne Leerzeichen, Port
 * immer ausgeschrieben — ist Sache des Endpunkts“). Rein, ohne Spring.
 *
 * <p>Ohne sie wären „192.168.20.10“, „ 192.168.20.10:502“ und „192.168.20.10 : 502“ drei Wege an
 * derselben Box — und die Eindeutigkeit je Box (§3 Nr. 2) sähe keinen davon.
 *
 * <ul>
 *   <li>Modbus TCP / SunSpec-Modbus: {@code host:port}, Host klein, ohne Leerzeichen, Port
 *       fehlend = 502 (der Modbus-TCP-Port); IPv6 nur in eckigen Klammern.</li>
 *   <li>HTTP-Auskunft: {@code schema://host:port/pfad?anfrage}, Schema und Host klein, Port
 *       fehlend = 80 bzw. 443; Zugangsdaten in der Adresse werden abgelehnt (ein Geheimnis
 *       reist nie in einem gespeicherten Dokument).</li>
 *   <li>MQTT-Themen und OCPP-Station: nur ohne Randleerzeichen — Themen und Stations-Kennungen
 *       unterscheiden Groß- und Kleinschreibung.</li>
 * </ul>
 */
public final class DatenquelleAdresse {

    private DatenquelleAdresse() {}

    /** Der Standard-Port von Modbus TCP. */
    public static final int MODBUS_PORT = 502;

    private static final Pattern HOSTNAME =
            Pattern.compile("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$");
    private static final Pattern IPV6 = Pattern.compile("^[0-9a-f:.]+$");
    private static final Pattern PORT = Pattern.compile("^[0-9]{1,5}$");

    /** Host und Port einer Modbus-Adresse, der Host ohne Klammern. */
    public record HostPort(String host, int port) {}

    /** Warum eine Adresse nicht angenommen wird — der Satz geht an den Kunden. */
    public static final class Ungueltig extends IllegalArgumentException {
        Ungueltig(String satz) {
            super(satz);
        }
    }

    /**
     * Die gespeicherte Form der Adresse für ein Protokoll (Code des Vertrags-Vokabulars).
     *
     * @throws Ungueltig mit dem deutschen Satz, wenn die Adresse keine Form hat
     */
    public static String normalisiere(String protokoll, String adresse) {
        if (adresse == null || adresse.isBlank()) {
            throw new Ungueltig("Unter welcher Adresse erreicht die Box die Quelle?");
        }
        return switch (protokoll) {
            case "modbus_tcp", "sunspec_modbus" -> modbus(adresse);
            case "http" -> http(adresse.strip());
            default -> adresse.strip();
        };
    }

    /** Host und Port einer gespeicherten Modbus-Adresse (für den Lese-Schritt der Prüfung). */
    public static HostPort hostPort(String gespeichert) {
        String a = modbus(gespeichert);
        int trenner = a.lastIndexOf(':');
        String host = a.substring(0, trenner);
        if (host.startsWith("[")) {
            host = host.substring(1, host.length() - 1);
        }
        return new HostPort(host, Integer.parseInt(a.substring(trenner + 1)));
    }

    private static String modbus(String roh) {
        String a = roh.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
        String host;
        String port;
        if (a.startsWith("[")) {
            int zu = a.indexOf(']');
            if (zu < 0) {
                throw new Ungueltig("Die IPv6-Adresse braucht ihre schließende Klammer, z. B. [fd00::10]:502.");
            }
            host = a.substring(1, zu);
            String rest = a.substring(zu + 1);
            if (!rest.isEmpty() && !rest.startsWith(":")) {
                throw new Ungueltig("Nach der IPv6-Adresse folgt nur noch „:Port“, z. B. [fd00::10]:502.");
            }
            port = rest.isEmpty() ? "" : rest.substring(1);
            if (host.isEmpty() || !IPV6.matcher(host).matches()) {
                throw new Ungueltig("Diese IPv6-Adresse hat keine gültige Form.");
            }
            return "[" + host + "]:" + port(port);
        }
        int doppelpunkte = a.length() - a.replace(":", "").length();
        if (doppelpunkte > 1) {
            throw new Ungueltig("Eine IPv6-Adresse bitte in eckigen Klammern angeben, z. B. [fd00::10]:502.");
        }
        int trenner = a.indexOf(':');
        host = trenner < 0 ? a : a.substring(0, trenner);
        port = trenner < 0 ? "" : a.substring(trenner + 1);
        if (!HOSTNAME.matcher(host).matches()) {
            throw new Ungueltig("Die Adresse braucht Host und Port, z. B. 192.168.20.10:502.");
        }
        return host + ":" + port(port);
    }

    private static int port(String port) {
        if (port.isEmpty()) {
            return MODBUS_PORT;
        }
        int p = PORT.matcher(port).matches() ? Integer.parseInt(port) : -1;
        if (p < 1 || p > 65535) {
            throw new Ungueltig("Der Port liegt zwischen 1 und 65535.");
        }
        return p;
    }

    private static String http(String roh) {
        URI uri;
        try {
            uri = new URI(roh);
        } catch (URISyntaxException e) {
            throw new Ungueltig("Die Adresse ist keine gültige Web-Adresse, z. B. http://192.168.30.20/api.");
        }
        String schema = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ((!schema.equals("http") && !schema.equals("https")) || uri.getHost() == null) {
            throw new Ungueltig("Die Adresse beginnt mit http:// oder https:// und nennt einen Host.");
        }
        if (uri.getRawUserInfo() != null) {
            throw new Ungueltig("Zugangsdaten gehören nicht in die Adresse.");
        }
        int port = uri.getPort() > 0 ? uri.getPort() : schema.equals("https") ? 443 : 80;
        String pfad = uri.getRawPath() == null ? "" : uri.getRawPath();
        String anfrage = uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery();
        return schema + "://" + uri.getHost().toLowerCase(Locale.ROOT) + ":" + port + pfad + anfrage;
    }
}
