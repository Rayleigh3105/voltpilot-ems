package com.voltpilot.api.fernwartung;

import java.util.Optional;
import java.util.Set;

/**
 * Ein IPv4-Teilnetz des Wartungsservers ({@code 10.10.16.0/20} für Boxen,
 * {@code 10.10.32.0/24} für Techniker-Zugänge).
 *
 * <p>Die erste Host-Adresse ({@code .1} im Netz) gehört dem Server selbst; die
 * Vergabe beginnt danach. Adressen mit {@code .0} oder {@code .255} im letzten
 * Oktett sind in einem /20 zwar gültige Hosts, werden aber übersprungen - in
 * einer Techniker-Konfiguration oder einer {@code known_hosts}-Zeile sehen sie
 * wie ein Tippfehler aus.
 */
public record Ipv4Netz(int netzadresse, int praefix) {

    public Ipv4Netz {
        if (praefix < 8 || praefix > 30) {
            throw new IllegalArgumentException("Präfix " + praefix + " liegt nicht zwischen /8 und /30");
        }
        if ((netzadresse & ~maske(praefix)) != 0) {
            throw new IllegalArgumentException(text(netzadresse) + "/" + praefix
                    + " ist keine Netzadresse (Host-Bits gesetzt)");
        }
    }

    /** {@code "10.10.16.0/20"} → Netz; wirft bei jeder Abweichung. */
    public static Ipv4Netz parse(String cidr) {
        if (cidr == null) {
            throw new IllegalArgumentException("Netz fehlt");
        }
        String[] teile = cidr.trim().split("/", -1);
        if (teile.length != 2) {
            throw new IllegalArgumentException("kein Netz in CIDR-Schreibweise: " + cidr);
        }
        int praefix;
        try {
            praefix = Integer.parseInt(teile[1]);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("kein Präfix: " + cidr, e);
        }
        return new Ipv4Netz(adresse(teile[0]), praefix);
    }

    /** {@code "10.10.16.2"} → 32-Bit-Wert; wirft bei allem, was keine IPv4-Adresse ist. */
    public static int adresse(String text) {
        String[] o = text == null ? new String[0] : text.trim().split("\\.", -1);
        if (o.length != 4) {
            throw new IllegalArgumentException("keine IPv4-Adresse: " + text);
        }
        int wert = 0;
        for (String teil : o) {
            if (teil.isEmpty() || teil.length() > 3 || !teil.chars().allMatch(Character::isDigit)) {
                throw new IllegalArgumentException("keine IPv4-Adresse: " + text);
            }
            int oktett = Integer.parseInt(teil);
            if (oktett > 255) {
                throw new IllegalArgumentException("keine IPv4-Adresse: " + text);
            }
            wert = (wert << 8) | oktett;
        }
        return wert;
    }

    public static String text(int adresse) {
        return ((adresse >>> 24) & 0xff) + "." + ((adresse >>> 16) & 0xff) + "."
                + ((adresse >>> 8) & 0xff) + "." + (adresse & 0xff);
    }

    private static int maske(int praefix) {
        return praefix == 0 ? 0 : -1 << (32 - praefix);
    }

    public boolean enthaelt(int adresse) {
        return (adresse & maske(praefix)) == netzadresse;
    }

    public boolean ueberschneidet(Ipv4Netz anderes) {
        int gemeinsam = Math.min(praefix, anderes.praefix);
        return (netzadresse & maske(gemeinsam)) == (anderes.netzadresse & maske(gemeinsam));
    }

    /** Die Adresse des Wartungsservers in diesem Netz. */
    public int serverAdresse() {
        return netzadresse + 1;
    }

    private int broadcast() {
        return netzadresse | ~maske(praefix);
    }

    /** Die kleinste freie Host-Adresse, oder leer, wenn das Netz voll ist. */
    public Optional<Integer> freieAdresse(Set<Integer> belegt) {
        for (int a = serverAdresse() + 1; a != broadcast(); a++) {
            int letztes = a & 0xff;
            if (letztes == 0 || letztes == 255 || belegt.contains(a)) {
                continue;
            }
            return Optional.of(a);
        }
        return Optional.empty();
    }

    @Override
    public String toString() {
        return text(netzadresse) + "/" + praefix;
    }
}
