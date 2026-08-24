package com.voltpilot.api.components;

import java.util.Map;

/**
 * Die zwei Eckpunkte des Speichers für die spannungsbasierte
 * Ladestand-SCHÄTZUNG - die Regel, die sagt, was ÜBERHAUPT eine Batterie sein
 * kann (Live-Fall Mühlfeldweg 2: ein Deye-Hybrid mit Eigenbau-Batterie, deren
 * BMS nicht am Wechselrichter hängt, meldet dauerhaft exakt 0 %).
 *
 * <p><b>Was sie ist.</b> Der Betreiber trägt die Klemmenspannung bei 0 % und
 * bei 100 % aus dem Datenblatt des Speichers ein; der Decoder auf der Box
 * interpoliert die GEMESSENE Spannung linear dazwischen. Sie greift
 * AUSSCHLIESSLICH im Fall „das BMS meldet nichts" und überschreibt nie einen
 * echten Wert.
 *
 * <p><b>⚠ Sie ist eine SCHÄTZUNG, und bei LiFePO4 eine grobe</b> - die
 * Zellkennlinie ist zwischen etwa 20 % und 90 % nahezu flach, und unter Last
 * verschiebt der Innenwiderstand die Klemmenspannung zusätzlich. Deshalb bleibt
 * sie ein ANZEIGE-Wert: der Verbindungstest weist den fehlenden Kanal
 * unverändert aus, die Komponente behält damit ihren
 * {@code reading_override}-Stempel und die Anlage bleibt für die
 * Batterie-Steuerung gesperrt ({@code ControlCertificationService}) - die
 * SoC-Klemme von {@code guards.Clamp} wird nie auf einer Schätzung
 * scharfgeschaltet.
 *
 * <p><b>⚠ Die Regel lebt DREIMAL, und das ist Absicht</b> (das Muster der
 * LAN-Regel): hier mit deutschem Satz für den Kunden, auf der Box in
 * {@code inverter.SocFromVoltage.validate} (sie glaubt einer Anweisung von
 * aussen nichts) und im Decoder als letzte Verteidigung (ein unsinniges Paar
 * schätzt schlicht nichts). <b>Wer die Zahlen ändert, ändert alle drei.</b>
 *
 * <p>Das Band ist bewusst WEIT: es muss einen 48-V-Speicher (~40..60 V) und
 * einen Hochvolt-Strang (~100..1000 V) mit DERSELBEN Regel tragen, denn weder
 * die api noch die Box kennt die Bauart besser als der Kunde, der sie eingibt.
 * Gefangen wird nur, was gar keine Batterie sein kann - eine Einheiten-
 * Verwechslung (Millivolt, ein Prozentwert) oder eine Ziffer zu viel.
 */
final class SocFromVoltageBounds {

    /** Der Schlüssel in der gespeicherten Verbindung (Vertrag mit der Box). */
    static final String KEY = "soc_from_voltage";
    static final String KEY_EMPTY = "v_empty";
    static final String KEY_FULL = "v_full";

    static final double MIN_VOLT = 10.0;
    static final double MAX_VOLT = 1000.0;

    /**
     * Der kleinste brauchbare Abstand. Darunter wird die Interpolation zur
     * Stufenfunktion (und bei 0 zur Division durch null), ein Prozentwert
     * daraus wäre Rauschen im Gewand eines Ladestands.
     */
    static final double MIN_SPAN = 0.5;

    private SocFromVoltageBounds() {
    }

    /**
     * Prüft den Eintrag in der Verbindung, falls einer da ist.
     *
     * @return der deutsche Grund einer Ablehnung, oder {@code null} wenn nichts
     *     zu beanstanden ist. Ein FEHLENDER Eintrag ist der Normalfall fast
     *     jeder Anlage und damit in Ordnung.
     */
    static String refusal(Map<String, Object> connection) {
        Object raw = connection == null ? null : connection.get(KEY);
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> m)) {
            return "Die Spannungs-Eckpunkte des Speichers sind unvollständig. Bitte "
                    + "die Spannung bei 0 % und bei 100 % angeben.";
        }
        Double empty = number(m.get(KEY_EMPTY));
        Double full = number(m.get(KEY_FULL));
        if (empty == null || full == null) {
            return "Bitte geben Sie die Spannung bei 0 % UND bei 100 % an - aus einer "
                    + "allein lässt sich der Ladestand nicht schätzen.";
        }
        if (outOfBand(empty) || outOfBand(full)) {
            return String.format(java.util.Locale.GERMANY,
                    "Die Spannungen müssen zwischen %.0f und %.0f Volt liegen. Bitte "
                            + "prüfen Sie die Angaben aus dem Datenblatt Ihres Speichers.",
                    MIN_VOLT, MAX_VOLT);
        }
        if (full - empty < MIN_SPAN) {
            return String.format(java.util.Locale.GERMANY,
                    "Die Spannung bei 100 %% muss mindestens %.1f Volt über der bei 0 %% "
                            + "liegen.", MIN_SPAN);
        }
        return null;
    }

    private static boolean outOfBand(double v) {
        return !Double.isFinite(v) || v < MIN_VOLT || v > MAX_VOLT;
    }

    /** Zahl oder Zahl-als-Text; alles andere ist keine Spannung. */
    private static Double number(Object o) {
        if (o instanceof Number n) {
            double d = n.doubleValue();
            return Double.isFinite(d) ? d : null;
        }
        if (o instanceof String s && !s.isBlank()) {
            try {
                double d = Double.parseDouble(s.trim().replace(',', '.'));
                return Double.isFinite(d) ? d : null;
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }
}
