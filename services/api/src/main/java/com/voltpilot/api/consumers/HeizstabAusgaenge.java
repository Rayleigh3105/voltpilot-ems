package com.voltpilot.api.consumers;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Die AUSGANGSMENGE eines Heizstabs an einem Shelly (Heizstab-Konzept V1;
 * docs/contracts/v2/heizstab-shelly.md): welche Ausgänge, welche Leistung je Element, welche
 * Stufen, welche Phasenwahl - und der Anschluss des Stabs. Java-Zwilling von
 * {@code shelly.Config.GroupError} der Box: dieselben Regeln, dieselben Sätze, geprüft gegen
 * dieselben Vektoren ({@code heizstab-stufen-vectors.json} {@code validate}).
 *
 * <p>Zusätzlich die Regel, die nur die Cloud kennt (die Box sieht den Anschluss nicht): der
 * Shelly Pro 3 schaltet höchstens 240 V je Kontakt. Mehrere Ausgänge eines Stabs gehen deshalb
 * nur bei <b>Stern mit N</b> (jedes Element zwischen Phase und Neutralleiter); bei Dreieck oder
 * Stern ohne N lägen beim versetzten Schalten 345-400 V an einem offenen Kontakt - dort gehört
 * ein dreipoliges Schütz hin. „Weiß ich nicht“ ist erlaubt, schaltet aber nichts, bis der
 * Elektriker den Anschluss bestätigt hat.
 */
public final class HeizstabAusgaenge {

    /** Anschluss des Stabs ({@code connection.anschluss}). */
    public static final String STERN_MIT_N = "stern_mit_n";
    public static final String OHNE_N = "ohne_n";
    public static final String DREIECK = "dreieck";
    public static final String UNBEKANNT = "unbekannt";
    public static final Set<String> ANSCHLUESSE = Set.of(STERN_MIT_N, OHNE_N, DREIECK, UNBEKANNT);

    /** Größtes Element, das ohne seine Geschwister laufen darf (Schieflast, VDE-AR-N 4100). */
    static final double MAX_TEILSTUFE_KW = 4.6;

    private HeizstabAusgaenge() {
    }

    /** Eine erlaubte Stufe: so viele Ausgänge zugleich, höchstens so viele kW. */
    public record Stufe(int ausgaenge, BigDecimal kw) {
    }

    /** Ob die Verbindung eine Ausgangsmenge trägt ({@code channels}). */
    public static boolean istMenge(Map<String, Object> connection) {
        return connection != null && connection.get("channels") instanceof List<?> l && !l.isEmpty();
    }

    /**
     * Der deutsche Satz, warum die Menge nicht geht; {@code null} = in Ordnung. Dieselben Regeln
     * und Sätze wie {@code shelly.Config.GroupError} der Box.
     */
    public static String fehler(Map<String, Object> connection) {
        List<Integer> chs = ganzzahlen(connection.get("channels"));
        if (chs == null || chs.isEmpty()) {
            return "Die Ausgänge des Heizstabs fehlen.";
        }
        if (chs.size() > 4) {
            return "Ein Gerät umfasst höchstens vier Ausgänge.";
        }
        Set<Integer> gesehen = new HashSet<>();
        for (int ch : chs) {
            if (ch < 0 || ch > 3) {
                return "Der Schaltkanal muss zwischen 0 und 3 liegen.";
            }
            if (!gesehen.add(ch)) {
                return "Ausgang " + ch + " steht zweimal in der Ausgangsmenge.";
            }
        }
        List<Double> kw = zahlen(connection.get("output_kw"));
        if (kw == null || kw.size() != chs.size()) {
            return "Für jeden Ausgang fehlt die Leistung seines Heizelements (kW).";
        }
        for (double k : kw) {
            if (!Double.isFinite(k) || k <= 0) {
                return "Die Leistung jedes Heizelements muss größer als 0 sein.";
            }
        }
        List<Integer> stufen = stufenOder(connection, chs.size());
        if (stufen == null) {
            return "Die Stufen müssen aufsteigend zwischen 1 und der Zahl der Ausgänge liegen.";
        }
        int vorher = 0;
        for (int st : stufen) {
            if (st < 1 || st > chs.size() || st <= vorher) {
                return "Die Stufen müssen aufsteigend zwischen 1 und der Zahl der Ausgänge liegen.";
            }
            vorher = st;
        }
        if (stufen.get(0) < chs.size()) {
            for (double k : kw) {
                if (k > MAX_TEILSTUFE_KW + 1e-9) {
                    return "Einzelne Phasen gibt es nur mit Heizelementen bis 4,6 kW (Schieflast) - "
                            + "dieser Heizstab schaltet nur alle Ausgänge zusammen.";
                }
            }
        }
        Object rot = connection.get("rotation");
        if (rot != null && !"daily".equals(rot) && !"fixed".equals(rot) && !"".equals(rot)) {
            return "Unbekannte Phasenwahl für Stufe 1.";
        }
        return null;
    }

    /**
     * Der Anschluss-Satz (nur Cloud): {@code null} = darf so angelegt werden. Mehrere Ausgänge
     * nur bei Stern mit N; „Weiß ich nicht“ darf angelegt werden, schaltet aber nicht.
     */
    public static String anschlussFehler(Map<String, Object> connection) {
        Object a = connection.get("anschluss");
        if (!(a instanceof String s) || !ANSCHLUESSE.contains(s)) {
            return "Bitte geben Sie an, wie die Heizelemente angeschlossen sind.";
        }
        List<Integer> chs = ganzzahlen(connection.get("channels"));
        if (chs != null && chs.size() > 1 && (OHNE_N.equals(s) || DREIECK.equals(s))) {
            return "Ohne Neutralleiter oder im Dreieck darf der Shelly die Phasen nicht einzeln schalten "
                    + "(höchstens 240 V je Kontakt). Davor gehört ein dreipoliges Schütz.";
        }
        return null;
    }

    /** Ob der Stab automatisch und von Hand geschaltet werden darf (Anschluss bestätigt). */
    public static boolean anschlussBestaetigt(Map<String, Object> connection) {
        return connection != null && STERN_MIT_N.equals(connection.get("anschluss"));
    }

    /**
     * Die erlaubten Stufen mit ihrer Obergrenze (die größten Elemente - dieselbe Regel, nach der
     * die Box einen Sollwert beurteilt). Leer, wenn die Menge nicht gültig ist.
     */
    public static List<Stufe> stufen(Map<String, Object> connection) {
        if (fehler(connection) != null) {
            return List.of();
        }
        List<Double> kw = new ArrayList<>(zahlen(connection.get("output_kw")));
        kw.sort((x, y) -> Double.compare(y, x));
        List<Stufe> out = new ArrayList<>();
        for (int st : stufenOder(connection, kw.size())) {
            double sum = 0;
            for (int i = 0; i < st; i++) {
                sum += kw.get(i);
            }
            out.add(new Stufe(st, BigDecimal.valueOf(sum).setScale(3, RoundingMode.HALF_UP)));
        }
        return out;
    }

    /** Die Ausgänge der Menge (oder der eine {@code channel}). */
    public static List<Integer> ausgaenge(Map<String, Object> connection) {
        List<Integer> chs = ganzzahlen(connection == null ? null : connection.get("channels"));
        if (chs != null && !chs.isEmpty()) {
            return chs;
        }
        Object ch = connection == null ? null : connection.get("channel");
        return List.of(ch instanceof Number n ? n.intValue() : 0);
    }

    private static List<Integer> stufenOder(Map<String, Object> connection, int n) {
        Object raw = connection.get("stages");
        if (raw == null) {
            return List.of(n);
        }
        List<Integer> st = ganzzahlen(raw);
        return st == null || st.isEmpty() ? (raw instanceof List<?> l && l.isEmpty() ? List.of(n) : null) : st;
    }

    private static List<Integer> ganzzahlen(Object raw) {
        if (!(raw instanceof List<?> l)) {
            return null;
        }
        List<Integer> out = new ArrayList<>();
        for (Object o : l) {
            if (!(o instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())) {
                return null;
            }
            out.add(n.intValue());
        }
        return out;
    }

    private static List<Double> zahlen(Object raw) {
        if (!(raw instanceof List<?> l)) {
            return null;
        }
        List<Double> out = new ArrayList<>();
        for (Object o : l) {
            if (!(o instanceof Number n)) {
                return null;
            }
            out.add(n.doubleValue());
        }
        return out;
    }
}
