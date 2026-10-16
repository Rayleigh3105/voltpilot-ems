package com.voltpilot.api.versand.webhook;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;

/**
 * Der SSRF-Schutz für ein kundenseitig frei eingetragenes Webhook-Ziel (Alerting Scheibe 6, Konzept
 * §7 Scheibe 6): anders als {@code SelfBuildDefinition.isPrivateHost} (die GEGENTEILIGE Frage für
 * ein LAN-Zielgerät: "ist dieser String NACHWEISBAR privat") muss hier das AUFGELÖSTE Ziel geprüft
 * werden - ein Kunde trägt einen öffentlichen Hostnamen ein, kein Adress-Literal, und genau dessen
 * tatsächliche Adresse(n) entscheiden, ob der Versand ein internes Ziel träfe.
 *
 * <p>Nur https, nur ein auflösbarer Host, und KEINE der aufgelösten Adressen darf privat, loopback,
 * link-local (schließt die Cloud-Metadaten-Adresse 169.254.169.254 ein) oder Multicast sein. Geprüft
 * wird bei JEDEM Versand neu (nicht nur beim Anlegen), weil sich die Auflösung eines Hostnamens
 * zwischen Anlegen und Versand ändern kann (DNS-Rebinding) - ein Restrisiko bleibt dabei: zwischen
 * dieser Prüfung und dem tatsächlichen Verbindungsaufbau des HTTP-Clients liegt noch eine zweite,
 * eigene Auflösung, die dieser Code nicht auf dieselbe Adresse zwingen kann (die Standard-API von
 * {@code java.net.http.HttpClient} bietet dafür keinen Auflöser-Austausch) - ein knapper Zeitraum
 * bleibt also offen, wie bei den meisten Webhook-Implementierungen dieser Art.
 */
public final class WebhookZielPruefung {

    private WebhookZielPruefung() {
    }

    /** Das Ziel ist kein zulässiges Webhook-Ziel - nie erneut versucht, siehe {@code WebhookException}. */
    public static final class UnsicheresZielException extends RuntimeException {
        public UnsicheresZielException(String message) {
            super(message);
        }
    }

    /** @throws UnsicheresZielException wenn die URL kein zulässiges, öffentliches https-Ziel ist. */
    public static URI pruefenUndAufloesen(String url) {
        URI ziel;
        try {
            ziel = new URI(url == null ? "" : url);
        } catch (URISyntaxException e) {
            throw new UnsicheresZielException("ungültige URL");
        }
        if (!"https".equals(ziel.getScheme())) {
            throw new UnsicheresZielException("nur https ist als Webhook-Ziel erlaubt");
        }
        String host = ziel.getHost();
        if (host == null || host.isBlank()) {
            throw new UnsicheresZielException("die URL hat keinen Host");
        }
        InetAddress[] adressen;
        try {
            adressen = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            throw new UnsicheresZielException("der Host ist nicht auflösbar");
        }
        if (adressen.length == 0) {
            throw new UnsicheresZielException("der Host ist nicht auflösbar");
        }
        for (InetAddress adresse : adressen) {
            if (gesperrt(adresse)) {
                throw new UnsicheresZielException(
                        "das aufgelöste Ziel " + adresse.getHostAddress() + " liegt in einem gesperrten Adressbereich");
            }
        }
        return ziel;
    }

    /** Loopback, Link-Local (deckt die Cloud-Metadaten-Adresse 169.254.169.254 ab), privat, Multicast, CGNAT, ULA. */
    private static boolean gesperrt(InetAddress adresse) {
        if (adresse.isLoopbackAddress() || adresse.isLinkLocalAddress() || adresse.isAnyLocalAddress()
                || adresse.isMulticastAddress() || adresse.isSiteLocalAddress()) {
            return true;
        }
        byte[] b = adresse.getAddress();
        if (b.length == 4) {
            int a = b[0] & 0xff;
            int c = b[1] & 0xff;
            // CGNAT 100.64.0.0/10 - nicht öffentlich routbar.
            return a == 100 && c >= 64 && c <= 127;
        }
        if (b.length == 16) {
            if (istIpv4Gemapped(b)) {
                try {
                    return gesperrt(InetAddress.getByAddress(
                            new byte[] {b[12], b[13], b[14], b[15]}));
                } catch (UnknownHostException e) {
                    return true; // sollte für 4 Bytes nie werfen - im Zweifel sperren
                }
            }
            // Unique Local Address fc00::/7 (IPv6-Entsprechung von RFC 1918).
            return (b[0] & 0xfe) == 0xfc;
        }
        return false;
    }

    private static boolean istIpv4Gemapped(byte[] b) {
        for (int i = 0; i < 10; i++) {
            if (b[i] != 0) {
                return false;
            }
        }
        return (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff;
    }
}
