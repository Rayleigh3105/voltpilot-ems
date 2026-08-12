package com.voltpilot.api.components;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Die REINEN Regeln der Geräte-Freigabe (Einheitsmodell Stufe 4, Konzept
 * {@code vp-modbus-baukasten-k6} §2.4). Keine DB, kein Spring, keine Uhr - das
 * {@code SelfBuildDefinition}/{@code Tagesprotokoll}/{@code FleetPflege}-Muster,
 * damit jede Regel, die ein Schalten verhindern kann, ohne einen einzigen
 * Container prüfbar ist.
 *
 * <h2>Die sechs Leitplanken, und wo sie hier stehen</h2>
 *
 * <ol>
 *   <li><b>Begrenzt statt frei.</b> Je Gerät GENAU EIN Schreib-Register mit
 *       fester Schalt-Art. Ein/Aus kennt nur die zwei bei der Freigabe
 *       festgelegten Konstanten; ein Sollwert kennt nur Werte innerhalb der
 *       festgelegten Klemme plus den Sicherheitswert. Diese Klasse ist die
 *       Stelle, an der das zur EIGENSCHAFT der gespeicherten Definition wird -
 *       danach kann kein Aufrufer mehr etwas anderes daraus machen.</li>
 *   <li><b>Die Freigabe ist ein bestandener Test.</b> {@link #requireRelease}
 *       ist die eine Stelle, die das prüft.</li>
 *   <li><b>Totmann.</b> Das optionale Watchdog-Register ist hier nur DATEN; die
 *       drei Ebenen wohnen im Arbiter, im Executor und - ehrlich benannt - im
 *       Freigabe-Dialog.</li>
 *   <li><b>Klemme + Zyklen-Guard laufen VOR dem Executor</b> - über
 *       {@code consumer_profile} → {@code guards.limits} → Arbiter. Diese
 *       Klasse liefert dafür die Nennleistung und die Zyklen-Zeiten.</li>
 *   <li><b>Ein Socket-Gesetz</b> - eine Eigenschaft des generierten Flows.</li>
 *   <li><b>Plattform-Hebel</b> - unverändert der Anlagen-Not-Aus.</li>
 * </ol>
 *
 * <p><b>Der Wortschatz ist bewusst DER DES KUNDEN, nicht der von Modbus:</b>
 * jede Ablehnung ist ein deutscher Satz, der den Weg nennt. Ein Kunde, der eine
 * Adresse aus seinem Handbuch abtippt, soll die Korrektur lesen können, nicht
 * einen Fehlercode.
 */
public final class SwitchDefinition {

    private SwitchDefinition() {
    }

    /** Ein/Aus: der Executor kennt nur die zwei Konstanten. */
    public static final String KIND_ON_OFF = "on_off";
    /** Sollwert: der Executor kennt nur Werte innerhalb der Klemme. */
    public static final String KIND_SETPOINT = "setpoint";

    private static final Set<String> KINDS = Set.of(KIND_ON_OFF, KIND_SETPOINT);
    private static final Set<String> REGISTER_KINDS = Set.of("holding", "coil");

    /** Modbus-Funktionscodes, die geschrieben werden dürfen. */
    public static final int FC_COIL = 5;
    public static final int FC_SINGLE = 6;
    public static final int FC_MULTIPLE = 16;

    /**
     * Die Voreinstellung fürs Register ist FC16, NICHT FC6: ein
     * Einzelregister-Schreibvorgang wird auf mehreren realen Geräten
     * ANGENOMMEN, aber nicht ÜBERNOMMEN (die belegte Fronius-/Deye-Lektion).
     */
    public static final int DEFAULT_REGISTER_FC = FC_MULTIPLE;

    /** Die Obergrenze eines Registerwerts. */
    public static final int MAX_RAW = 65535;

    /** Die Dauer des geführten Tests in Sekunden. */
    public static final int TEST_TTL_S = 30;

    /**
     * Der wörtliche Totmann-Hinweis des Freigabe-Dialogs (Leitplanke 3c). Er
     * steht hier, weil er eine ZUSAGE ist und nicht Oberflächen-Text: ein
     * generisches Modbus-Gerät hat keinen eingebauten Geräte-Totmann, und wer
     * das nicht sagt, verspricht eine Sicherheit, die es nicht gibt.
     */
    public static final String DEADMAN_NOTE =
            "Fällt die VoltPilot-Box aus, bleibt das Gerät im letzten Zustand - geben Sie nur "
                    + "Geräte frei, die dafür unkritisch sind oder eine eigene "
                    + "Sicherheitsabschaltung haben.";

    /** Die Eingabe des Freigabe-Assistenten. */
    public record Switch(String kind, String registerKind, Integer address, Integer writeFc,
            Integer onValue, Integer offValue, Double minValue, Double maxValue, Double safeValue,
            Double scale, Double offset, String unit, Integer readbackAddress,
            Integer watchdogAddress, Integer watchdogValue) {
    }

    /** Die Verbraucher-Eckdaten aus dem Schritt „Schaltbarer Verbraucher". */
    public record Consumer(Double ratedPowerKw, Integer minOnSeconds, Integer minOffSeconds,
            Integer maxStartsPerDay, String powerChannel) {
    }

    /** Die geprüfte, normalisierte Form. Sie ist das, was gespeichert wird. */
    public record NormalizedSwitch(String kind, String registerKind, int address, int writeFc,
            int onValue, int offValue, double minValue, double maxValue, double safeValue,
            double scale, double offset, String unit, Integer readbackAddress,
            Integer watchdogAddress, int watchdogValue) {

        /** Der Rohwert, den ein Sollwert in Einheiten ergibt - geklemmt wie am Gerät. */
        public int rawFor(double value) {
            double clamped = Math.min(Math.max(value, minValue), maxValue);
            return clampRaw(Math.round((clamped - offset) / scale));
        }

        /** Der Rohwert des Sicherheitswerts - OHNE die Betriebsklemme (siehe Executor). */
        public int safeRaw() {
            if (KIND_ON_OFF.equals(kind)) {
                return offValue;
            }
            return clampRaw(Math.round((safeValue - offset) / scale));
        }
    }

    public record Result(List<String> errors, NormalizedSwitch value) {
        public boolean ok() {
            return errors.isEmpty();
        }
    }

    private static int clampRaw(long v) {
        return (int) Math.min(Math.max(v, 0), MAX_RAW);
    }

    /**
     * Prüft und normalisiert eine Schalt-Definition. Sammelt ALLE Fehler
     * (nie fail-fast - der Kunde soll einmal korrigieren, nicht fünfmal).
     */
    public static Result validate(Switch s) {
        List<String> errors = new ArrayList<>();
        if (s == null) {
            errors.add("Es fehlen die Angaben zum Schalten.");
            return new Result(errors, null);
        }
        String kind = trim(s.kind());
        if (!KINDS.contains(kind)) {
            errors.add("Bitte wählen Sie, ob das Gerät ein- und ausgeschaltet oder auf einen "
                    + "Sollwert gestellt wird.");
        }
        String registerKind = trim(s.registerKind());
        if (!REGISTER_KINDS.contains(registerKind)) {
            errors.add("Bitte wählen Sie Register (Holding) oder Relais-Spule (Coil).");
        }
        int address = intOr(s.address(), -1);
        if (address < 0 || address > MAX_RAW) {
            errors.add("Die Registeradresse muss zwischen 0 und 65535 liegen (0-basiert - 40001 "
                    + "aus dem Handbuch ist Adresse 0).");
        }
        boolean coil = "coil".equals(registerKind);
        int fc = s.writeFc() == null ? (coil ? FC_COIL : DEFAULT_REGISTER_FC) : s.writeFc();
        if (coil && fc != FC_COIL) {
            errors.add("Eine Relais-Spule wird mit Funktionscode 5 geschrieben.");
        }
        if (!coil && fc != FC_SINGLE && fc != FC_MULTIPLE) {
            errors.add("Ein Register wird mit Funktionscode 16 (Voreinstellung) oder 6 "
                    + "geschrieben.");
        }
        if (s.readbackAddress() != null
                && (s.readbackAddress() < 0 || s.readbackAddress() > MAX_RAW)) {
            errors.add("Die Adresse des Rücklese-Registers muss zwischen 0 und 65535 liegen.");
        }
        Integer watchdog = s.watchdogAddress();
        int watchdogValue = intOr(s.watchdogValue(), 0);
        if (watchdog != null && (watchdog < 0 || watchdog > MAX_RAW)) {
            errors.add("Die Adresse des Watchdog-Registers muss zwischen 0 und 65535 liegen.");
        }
        if (watchdog != null && (watchdogValue < 0 || watchdogValue > MAX_RAW)) {
            errors.add("Der Watchdog-Wert muss zwischen 0 und 65535 liegen.");
        }

        int on = 0;
        int off = 0;
        double min = 0;
        double max = 0;
        double safe = 0;
        double scale = 1;
        double offset = 0;
        String unit = trim(s.unit());

        if (KIND_ON_OFF.equals(kind)) {
            on = intOr(s.onValue(), Integer.MIN_VALUE);
            off = intOr(s.offValue(), Integer.MIN_VALUE);
            if (!inRaw(on) || !inRaw(off)) {
                errors.add("Bitte tragen Sie den Ein- und den Aus-Wert ein (0 bis 65535).");
            } else if (on == off) {
                errors.add("Ein- und Aus-Wert sind gleich - so ließe sich das Gerät nie wieder "
                        + "ausschalten.");
            } else if (coil && (!isBit(on) || !isBit(off))) {
                errors.add("Eine Relais-Spule kennt nur 0 und 1.");
            }
        } else if (KIND_SETPOINT.equals(kind)) {
            if (coil) {
                errors.add("Ein Sollwert braucht ein Register - eine Relais-Spule kennt nur ein "
                        + "und aus.");
            }
            min = dblOr(s.minValue(), Double.NaN);
            max = dblOr(s.maxValue(), Double.NaN);
            safe = dblOr(s.safeValue(), Double.NaN);
            scale = dblOr(s.scale(), 1);
            offset = dblOr(s.offset(), 0);
            if (Double.isNaN(min) || Double.isNaN(max)) {
                errors.add("Bitte tragen Sie den kleinsten und den größten erlaubten Sollwert "
                        + "ein - außerhalb dieser Klemme schaltet VoltPilot nie.");
            } else if (min >= max) {
                errors.add("Der kleinste Sollwert muss unter dem größten liegen.");
            }
            if (Double.isNaN(safe)) {
                errors.add("Bitte tragen Sie den Sicherheitswert ein - er wird geschrieben, wenn "
                        + "die Steuerung endet oder die Verbindung abbricht.");
            }
            if (scale == 0 || Double.isNaN(scale)) {
                errors.add("Die Skalierung muss eine Zahl ungleich 0 sein.");
            }
            if (Double.isNaN(offset)) {
                errors.add("Der Offset muss eine Zahl sein.");
            }
            if (unit.isEmpty()) {
                errors.add("Bitte wählen Sie die Einheit des Sollwerts.");
            }
            // Die drei Werte müssen sich als Registerwert überhaupt schreiben
            // lassen - sonst wäre die Freigabe eine Zusage über etwas, das das
            // Register gar nicht darstellen kann.
            if (errors.isEmpty()) {
                for (double v : new double[] {min, max, safe}) {
                    long raw = Math.round((v - offset) / scale);
                    if (raw < 0 || raw > MAX_RAW) {
                        errors.add("Mit dieser Skalierung liegt " + fmt(v) + " " + unit
                                + " außerhalb dessen, was ein Register darstellen kann "
                                + "(0 bis 65535). Bitte Skalierung oder Grenzen anpassen.");
                        break;
                    }
                }
            }
        }
        if (!errors.isEmpty()) {
            return new Result(errors, null);
        }
        return new Result(List.of(), new NormalizedSwitch(kind, registerKind, address, fc, on, off,
                min, max, safe, scale, offset, unit, s.readbackAddress(), watchdog, watchdogValue));
    }

    /**
     * Prüft die Verbraucher-Eckdaten (Leitplanke 4). Die Nennleistung ist
     * PFLICHT: aus ihr entsteht {@code guards.limits.max_consumption_kw}, die
     * Klemme, die VOR dem Executor läuft. Ohne sie gäbe es keine.
     */
    public static List<String> validateConsumer(Consumer c) {
        List<String> errors = new ArrayList<>();
        if (c == null || c.ratedPowerKw() == null || !(c.ratedPowerKw() > 0)) {
            errors.add("Bitte tragen Sie die Nennleistung des Geräts ein - aus ihr entsteht die "
                    + "Leistungsgrenze, die VoltPilot nie überschreitet.");
            return errors;
        }
        if (c.ratedPowerKw() > 1000) {
            errors.add("Die Nennleistung sieht zu groß aus (über 1000 kW).");
        }
        errors.addAll(cycleError(c.minOnSeconds(), "Mindestlaufzeit"));
        errors.addAll(cycleError(c.minOffSeconds(), "Mindestpause"));
        if (c.maxStartsPerDay() != null && (c.maxStartsPerDay() < 1 || c.maxStartsPerDay() > 1000)) {
            errors.add("Die maximale Anzahl Starts pro Tag muss zwischen 1 und 1000 liegen.");
        }
        return errors;
    }

    private static List<String> cycleError(Integer v, String what) {
        if (v == null) {
            return List.of();
        }
        if (v < 0 || v > 86400) {
            return List.of("Die " + what + " muss zwischen 0 und 86400 Sekunden liegen.");
        }
        return List.of();
    }

    /**
     * Der Testwert eines Sollwert-Tests: der vom Kunden gewählte Wert MUSS in
     * der freigegebenen Klemme liegen. Er wird bewusst NICHT hineingeklemmt -
     * wer 30 kW eintippt und stillschweigend 10 bekäme, hätte einen anderen
     * Test gefahren als den, den er bestätigt.
     */
    public static String testValueError(NormalizedSwitch s, Double testValue) {
        if (KIND_ON_OFF.equals(s.kind())) {
            return null;
        }
        if (testValue == null || Double.isNaN(testValue)) {
            return "Bitte wählen Sie einen Testwert innerhalb der Klemme.";
        }
        if (testValue < s.minValue() || testValue > s.maxValue()) {
            return "Der Testwert muss zwischen " + fmt(s.minValue()) + " und " + fmt(s.maxValue())
                    + " " + s.unit() + " liegen - außerhalb der Klemme schaltet VoltPilot nie.";
        }
        return null;
    }

    /** Der Rohwert, den ein Test schreibt (Ein-Konstante bzw. der Testwert). */
    public static int testRaw(NormalizedSwitch s, Double testValue) {
        return KIND_ON_OFF.equals(s.kind()) ? s.onValue() : s.rawFor(testValue);
    }

    /**
     * Die eine Stelle, an der „darf freigegeben werden" entschieden wird: ohne
     * bestandenen Test und ohne die Bestätigung der physischen Wirkung gibt es
     * keine Freigabe. Beides zusammen, nie eines allein - der Test beweist,
     * dass das Register erreichbar ist, die Bestätigung beweist, dass das
     * RICHTIGE Gerät reagiert hat.
     */
    public static String requireRelease(boolean testPassed, boolean physicallyConfirmed) {
        if (!testPassed) {
            return "Bitte führen Sie zuerst den Schalt-Test durch - erst danach lässt sich das "
                    + "Schalten freigeben.";
        }
        if (!physicallyConfirmed) {
            return "Bitte bestätigen Sie, dass Sie die Wirkung am Gerät gesehen haben.";
        }
        return null;
    }

    /** Die Folgen einer Rücknahme - eine Aufzählung, kein Fließtext. */
    public static List<String> revokeConsequences() {
        return List.of(
                "VoltPilot schaltet dieses Gerät nicht mehr.",
                "Ihre Regeln für dieses Gerät stoppen.",
                "Die Messwerte des Geräts werden weiter aufgezeichnet.",
                "Sie können das Schalten jederzeit wieder freigeben - mit einem neuen Test.");
    }

    private static boolean inRaw(int v) {
        return v >= 0 && v <= MAX_RAW;
    }

    private static boolean isBit(int v) {
        return v == 0 || v == 1;
    }

    private static int intOr(Integer v, int fallback) {
        return v == null ? fallback : v;
    }

    private static double dblOr(Double v, double fallback) {
        return v == null ? fallback : v;
    }

    private static String trim(String s) {
        return s == null ? "" : s.trim();
    }

    private static String fmt(double v) {
        if (v == Math.rint(v) && !Double.isInfinite(v)) {
            return String.valueOf((long) v);
        }
        return String.format(Locale.GERMAN, "%.2f", v);
    }
}
