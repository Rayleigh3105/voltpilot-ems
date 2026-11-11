package com.voltpilot.api.werkstatt;

import com.voltpilot.api.fernwartung.Ipv4Netz;
import java.util.List;

/**
 * Das LAN der Box nach Entscheid 6a (26.10.2026): in der Werkstatt auf ein
 * unübliches Netz gestellt, damit es nicht mit dem Router des Kunden
 * zusammenfällt. Die Box steht ab Werk auf {@code 192.168.1.1/24}; hat der
 * Router dasselbe Netz, kommt sie nicht ins Internet.
 *
 * <p>Geschrieben wie in OpenWrt: die Adresse der Box mit Präfix,
 * {@code 10.213.0.1/24}.
 */
public record LanNetz(int adresse, int praefix) {

    /** Privat nach RFC 1918. */
    private static final List<Ipv4Netz> PRIVAT = List.of(
            Ipv4Netz.parse("10.0.0.0/8"), Ipv4Netz.parse("172.16.0.0/12"), Ipv4Netz.parse("192.168.0.0/16"));

    /**
     * Netze, die Heimrouter ab Werk verteilen: der Grund für Entscheid 6a.
     * Die Liste ist nicht vollständig; sie fängt die häufigen.
     */
    static final List<Ipv4Netz> UEBLICH = List.of(
            Ipv4Netz.parse("192.168.0.0/24"),
            Ipv4Netz.parse("192.168.1.0/24"),
            Ipv4Netz.parse("192.168.2.0/24"),
            Ipv4Netz.parse("192.168.8.0/24"),
            Ipv4Netz.parse("192.168.178.0/24"),
            Ipv4Netz.parse("10.0.0.0/24"));

    /** Der Vorschlag der Werkstatt-Seite, wie an der Labor-Mango seit dem 07.10.2026. */
    public static final String VORSCHLAG = "10.213.0.1/24";

    /**
     * Prüft Form und Lage; die Meldung der Ausnahme ist für Menschen.
     * {@code belegt}: Netze, mit denen sich das LAN nicht überschneiden darf
     * (Box- und Techniker-Netz des Wartungsservers).
     */
    public static LanNetz parse(String text, List<Ipv4Netz> belegt) {
        String roh = text == null ? "" : text.trim();
        String[] teile = roh.split("/", -1);
        int adresse;
        int praefix;
        try {
            if (teile.length != 2) {
                throw new IllegalArgumentException();
            }
            adresse = Ipv4Netz.adresse(teile[0]);
            praefix = Integer.parseInt(teile[1]);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("„" + roh + "“ ist keine Adresse mit Präfix, etwa " + VORSCHLAG + ".");
        }
        if (praefix < 16 || praefix > 28) {
            throw new IllegalArgumentException("Das Präfix muss zwischen /16 und /28 liegen, etwa " + VORSCHLAG + ".");
        }
        LanNetz lan = new LanNetz(adresse, praefix);
        Ipv4Netz netz = lan.netz();
        int host = adresse & ~maske(praefix);
        if (host == 0 || host == ~maske(praefix)) {
            throw new IllegalArgumentException(Ipv4Netz.text(adresse)
                    + " ist die Netz- oder Rundrufadresse; die Box braucht eine Host-Adresse, etwa "
                    + VORSCHLAG + ".");
        }
        if (PRIVAT.stream().noneMatch(p -> p.enthaelt(adresse) && p.enthaelt(adresse | ~maske(praefix)))) {
            throw new IllegalArgumentException(netz + " ist kein privates Netz (10/8, 172.16/12, 192.168/16).");
        }
        for (Ipv4Netz b : belegt) {
            if (b.ueberschneidet(netz)) {
                throw new IllegalArgumentException(netz + " überschneidet sich mit " + b
                        + ", einem Netz des Wartungsservers.");
            }
        }
        for (Ipv4Netz u : UEBLICH) {
            if (u.ueberschneidet(netz)) {
                throw new IllegalArgumentException(netz + " enthält " + u
                        + ", ein übliches Netz von Heimroutern. Bitte ein unübliches wählen, etwa " + VORSCHLAG
                        + ".");
            }
        }
        return lan;
    }

    /** Das Netz, in dem die Box steht. */
    public Ipv4Netz netz() {
        return new Ipv4Netz(adresse & maske(praefix), praefix);
    }

    /** Die Adresse der Box, unter der sie im LAN erreichbar ist. */
    public String boxAdresse() {
        return Ipv4Netz.text(adresse);
    }

    public String text() {
        return Ipv4Netz.text(adresse) + "/" + praefix;
    }

    private static int maske(int praefix) {
        return -1 << (32 - praefix);
    }
}
