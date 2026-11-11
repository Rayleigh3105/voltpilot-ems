package com.voltpilot.api.geraetesuche;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Die Bereichsregel der Gerätesuche ({@code docs/contracts/v2/mqtt-geraetesuche.md} §4): die Privat-Ziel-Regel von
 * {@code lan-host-vectors.json}, erweitert von EINEM Host auf Adressbereiche. Java-Zwilling von Go
 * {@code edge-app/core/internal/probe/bereich.go}; beide lesen {@code docs/contracts/lan-range-vectors.json}.
 *
 * <p>Die Box bildet ihre Suchnetze selbst und glaubt der Cloud nichts; die API glaubt der Box auch nicht blind: sie
 * nimmt nur Netze an, die nach dieser Regel ein Suchnetz sein können, und speichert nur Funde, deren Adresse darin ein
 * erlaubtes Ziel ist. Ein Bereich ist RFC1918-IPv4 mit Präfix 24 bis 30; ein Ziel ist eine Host-Adresse darin, nie die
 * Box selbst (damit auch nie ihre Ports), nie Netz- oder Broadcast-Adresse. Die Schnittstellen-Regeln (Tunnel,
 * Container) kennt nur die Box.
 */
public final class Suchbereich {

    public static final String KEINE_ADRESSE = "keine_adresse";
    public static final String NICHT_PRIVAT = "nicht_privat";
    public static final String ZU_GROSS = "zu_gross";
    public static final String ZU_KLEIN = "zu_klein";
    public static final String KEINE_HOSTADRESSE = "keine_hostadresse";
    public static final String KEINE_NETZADRESSE = "keine_netzadresse";
    public static final String BOX_AUSSERHALB = "box_ausserhalb";
    public static final String BOX_KEINE_HOSTADRESSE = "box_keine_hostadresse";
    public static final String BOX_SELBST = "box_selbst";
    public static final String AUSSERHALB = "ausserhalb";
    public static final String NETZADRESSE = "netzadresse";
    public static final String BROADCAST = "broadcast";

    static final int MAX_BITS = 24;
    static final int MIN_HOST_BITS = 30;

    private static final Pattern IPV4 = Pattern.compile(
            "((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])");
    private static final Pattern IPV6 = Pattern.compile("[0-9a-fA-F:]*:[0-9a-fA-F:]*:[0-9a-fA-F:.]*");

    /**
     * Ein Suchnetz und die Adresse der Box darin.
     *
     * @param ausschnitt true = das Netz der Schnittstelle ist größer, gesucht wird das /24 um die Box; null = unbekannt
     */
    public record Bereich(int netz, int bits, int boxAdresse, Boolean ausschnitt) {

        public String netzText() {
            return text(netz) + "/" + bits;
        }

        public String boxText() {
            return text(boxAdresse);
        }

        boolean enthaelt(int adresse) {
            return (adresse & maske(bits)) == netz;
        }

        int broadcast() {
            return netz | ~maske(bits);
        }
    }

    /** Ein Bereich oder der Grund, warum keiner entsteht. */
    public record Urteil(Bereich bereich, String grund) {

        static Urteil nein(String grund) {
            return new Urteil(null, grund);
        }
    }

    private Suchbereich() {
    }

    /**
     * Das Suchnetz aus einer eigenen Adresse der Box: mit Präfix aus der Schnittstelle, ohne Präfix VP_LAN_HOST der
     * Docker-Box (das /24 um die Adresse, Maske unbekannt).
     */
    public static Urteil suchbereich(String adresse) {
        String a = adresse == null ? "" : adresse;
        int bits = -1;
        int schnitt = a.indexOf('/');
        if (schnitt >= 0) {
            String praefix = a.substring(schnitt + 1);
            a = a.substring(0, schnitt);
            if (!praefix.matches("[0-9]{1,3}") || Integer.parseInt(praefix) > 128) {
                return Urteil.nein(KEINE_ADRESSE);
            }
            bits = Integer.parseInt(praefix);
        }
        Integer zahl = ipv4(a);
        if (zahl == null) {
            return Urteil.nein(IPV6.matcher(a).matches() ? NICHT_PRIVAT : KEINE_ADRESSE);
        }
        int ip = zahl;
        if (bits > 32) {
            return Urteil.nein(KEINE_ADRESSE);
        }
        if (!privat(ip)) {
            return Urteil.nein(NICHT_PRIVAT);
        }
        if (bits > MIN_HOST_BITS) {
            return Urteil.nein(ZU_KLEIN);
        }
        Boolean ausschnitt = bits < 0 ? null : bits < MAX_BITS;
        int b = Math.max(bits, MAX_BITS);
        Bereich bereich = new Bereich(ip & maske(b), b, ip, ausschnitt);
        if (ip == bereich.netz() || ip == bereich.broadcast()) {
            return Urteil.nein(KEINE_HOSTADRESSE);
        }
        return new Urteil(bereich, null);
    }

    /** Ein gemeldetes Paar (netz, box_adresse) prüfen; das Paar allein sagt nichts über den Ausschnitt. */
    public static Urteil pruefe(String netz, String boxAdresse) {
        if (netz == null || netz.indexOf('/') < 0) {
            return Urteil.nein(KEINE_ADRESSE);
        }
        String[] teile = netz.split("/", 2);
        Integer netzAdresse = ipv4(teile[0]);
        Integer boxAdresseZahl = ipv4(boxAdresse);
        if (netzAdresse == null || boxAdresseZahl == null || !teile[1].matches("[0-9]{1,2}")
                || Integer.parseInt(teile[1]) > 32) {
            return Urteil.nein(KEINE_ADRESSE);
        }
        int n = netzAdresse;
        int box = boxAdresseZahl;
        int bits = Integer.parseInt(teile[1]);
        if (!privat(n)) {
            return Urteil.nein(NICHT_PRIVAT);
        }
        if (bits < MAX_BITS) {
            return Urteil.nein(ZU_GROSS);
        }
        if (bits > MIN_HOST_BITS) {
            return Urteil.nein(ZU_KLEIN);
        }
        Bereich bereich = new Bereich(n, bits, box, null);
        if ((n & maske(bits)) != n) {
            return Urteil.nein(KEINE_NETZADRESSE);
        }
        if (!bereich.enthaelt(box)) {
            return Urteil.nein(BOX_AUSSERHALB);
        }
        if (box == n || box == bereich.broadcast()) {
            return Urteil.nein(BOX_KEINE_HOSTADRESSE);
        }
        return new Urteil(bereich, null);
    }

    /** Darf {@code ip} angesprochen werden bzw. als Fund gelten? null = erlaubt, sonst der Grund. */
    public static String ziel(String ip, List<Bereich> bereiche) {
        Integer zahl = ipv4(ip);
        if (zahl == null) {
            return KEINE_ADRESSE;
        }
        int a = zahl;
        for (Bereich b : bereiche) {
            if (b.boxAdresse() == a) {
                return BOX_SELBST;
            }
        }
        for (Bereich b : bereiche) {
            if (!b.enthaelt(a)) {
                continue;
            }
            if (a == b.netz()) {
                return NETZADRESSE;
            }
            return a == b.broadcast() ? BROADCAST : null;
        }
        return AUSSERHALB;
    }

    /** Eine IPv4-Adresse in Punktschreibweise ohne führende Nullen, sonst null. */
    static Integer ipv4(String s) {
        if (s == null || !IPV4.matcher(s).matches()) {
            return null;
        }
        int wert = 0;
        for (String teil : s.split("\\.")) {
            wert = (wert << 8) | Integer.parseInt(teil);
        }
        return wert;
    }

    private static boolean privat(int ip) {
        int a = (ip >>> 24) & 0xff;
        int b = (ip >>> 16) & 0xff;
        return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
    }

    private static int maske(int bits) {
        return bits == 0 ? 0 : -1 << (32 - bits);
    }

    private static String text(int ip) {
        return ((ip >>> 24) & 0xff) + "." + ((ip >>> 16) & 0xff) + "." + ((ip >>> 8) & 0xff) + "." + (ip & 0xff);
    }
}
