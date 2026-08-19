package com.voltpilot.api.registerwrite;

import java.util.Locale;
import java.util.Optional;

/**
 * Das REGISTER-WISSEN der Cloud - Schutz durch INFORMATION, nicht durch Sperren
 * (Konzept {@code vp-reg-schreib-konzept-p8} §2.3).
 *
 * <p>Es beantwortet drei Fragen, die eine Oberfläche stellen muss, bevor ein
 * Mensch auf „Jetzt schreiben" klickt: wie heißt dieses Register im Klartext,
 * welcher WARNKLASSE gehört es an, und was bedeutet der Rohwert in einer
 * Einheit, die jemand nachrechnen kann. Es entscheidet ausdrücklich NICHT, ob
 * geschrieben werden darf: WAS eine Box ausführt, prüft die Box selbst
 * ({@code edge-app/core/internal/installerwrite}). Eine zweite Politik hier
 * wäre eine zweite Wahrheit, die auseinanderlaufen kann.
 *
 * <p><b>Die EINE Regel, die aus einer Klasse eine Pflicht macht (Captain-
 * Entscheid D5, 19.08.2026):</b> bei {@link #CLASS_NETZ_COMPLIANCE} ist die
 * Notiz PFLICHT - für jede Herkunft, auch für VoltPilot. Sie bleibt eine reine
 * WARNUNG plus ein Textfeld: es gibt bewusst kein Bestätigungs-Häkchen (D3),
 * denn der Klick auf den voll ausformulierten Bestätigen-Knopf IST die bewusste
 * Handlung.
 *
 * <p><b>⚠ STUFE 1 IST HART VERDRAHTET, UND ZWAR NUR AUF DIE ADRESSE.</b> Der
 * einzige Schreibpfad dieser Stufe ist das Deye-Installateur-Register
 * {@code 0x00E7}; die volle Warnklassen-Taxonomie (ein kuratiertes DATEN-
 * Verzeichnis nach dem {@code entitytypes/catalog.json}-Muster) kommt in Stufe 2.
 * Sie muss dann JE FAMILIE sprechen, nie pauschal: auf {@code hybrid_1p} ist die
 * Einspeisegrenze ein ANDERES Register mit ANDERER Skala ({@code 0x00F5}, Skala
 * 1) - und genau dieses schreibt dort unser eigener Steuerpfad. Bis dahin ist
 * die Ungenauigkeit folgenlos, weil die Box eine Familie, auf der {@code 0x00E7}
 * nicht die eigenständige Einspeisegrenze ist, ohnehin ablehnt: die falsche
 * Klasse erschiene neben einer Vorschau, die „wird abgelehnt" sagt.
 */
public final class RegisterKnowledge {

    /** Die Klasse, die eine Notiz erzwingt: Register der Netz-Anmeldung. */
    public static final String CLASS_NETZ_COMPLIANCE = "netz_compliance";
    /** VoltPilot kennt das Register: Name, Skala und Einheit werden gezeigt. */
    public static final String CLASS_BEKANNT = "bekannt";
    /** Alles andere - nur Rohwert, mit der deutlichsten Warnung. */
    public static final String CLASS_UNBEKANNT = "unbekannt";

    /** Deye „Grid Max Export power" - die Einspeisegrenze am Netzanschluss. */
    public static final int DEYE_EXPORT_LIMIT_ADDR = 0x00e7;

    private RegisterKnowledge() {
    }

    /**
     * Was die Plattform über ein Register weiß.
     *
     * @param label     der Klartext-Name, oder {@code null} bei einem unbekannten
     *                  Register - nie ein erfundener Name.
     * @param clazz     eine der drei {@code CLASS_*}-Konstanten.
     * @param scaleUnit die Einheit des SKALIERTEN Werts ({@code null} = keine
     *                  bekannte Skala, dann wird auch nichts umgerechnet).
     * @param scale     Rohwert × {@code scale} = Wert in {@code scaleUnit}.
     */
    public record Known(String label, String clazz, Double scale, String scaleUnit) {

        /** Ob die Klasse eine PFLICHT-Notiz erzwingt (D5). */
        public boolean noteRequired() {
            return CLASS_NETZ_COMPLIANCE.equals(clazz);
        }

        /**
         * Der Anzeige-Satz für einen Rohwert („3300 (33,0 kW)"), oder nur die
         * rohe Zahl, wenn keine Skala bekannt ist. Ein Register ohne bekannte
         * Skala bekommt NIE eine erfundene Einheit.
         */
        public String render(Integer raw) {
            if (raw == null) {
                return null;
            }
            if (scale == null || scaleUnit == null) {
                return String.valueOf(raw);
            }
            return raw + " (" + kw(raw * scale) + " " + scaleUnit + ")";
        }

        /** Der Skalen-Vermerk, wie er als Schnappschuss ins Journal wandert. */
        public String scaleNote(Integer raw) {
            if (scale == null || scaleUnit == null || raw == null) {
                return null;
            }
            return "Rohwert × " + trimScale(scale) + " = " + kw(raw * scale) + " " + scaleUnit;
        }

        /** Der skalierte Wert, oder {@code null} ohne bekannte Skala. */
        public Double scaled(Integer raw) {
            return raw == null || scale == null ? null : raw * scale;
        }
    }

    /**
     * Das Wissen zu einer Adresse. Ein unbekanntes Register bekommt die Klasse
     * {@link #CLASS_UNBEKANNT} und KEINEN Namen - „VoltPilot kennt dieses
     * Register nicht" ist eine Aussage, ein erfundener Name wäre eine Lüge.
     */
    public static Known of(int address) {
        if (address == DEYE_EXPORT_LIMIT_ADDR) {
            return new Known("Einspeisegrenze am Netzanschluss (Grid Max Export power)",
                    CLASS_NETZ_COMPLIANCE, 0.01, "kW");
        }
        return new Known(null, CLASS_UNBEKANNT, null, null);
    }

    /**
     * Die vom Menschen getippte Adresse als Zahl - hexadezimal ({@code 0x00E7})
     * ODER dezimal ({@code 231}), beides akzeptiert. Die Zeichenkette selbst
     * wandert VERBATIM ins Journal; hier entsteht nur die normalisierte Zahl.
     *
     * <p>Ein nacktes {@code E7} wird bewusst NICHT als Hex geraten: „231" wäre
     * dann mehrdeutig, und ein geratenes Register ist genau der Fehler, gegen
     * den die ganze Zwei-Schritt-Strecke gebaut ist.
     */
    public static Optional<Integer> parseAddress(String input) {
        return parseNumber(input, 0, 0xffff);
    }

    /**
     * Der vom Menschen getippte Wert als Rohwort - dieselbe Regel wie bei der
     * Adresse (dezimal oder {@code 0x}-Hex, 0..65535). Es ist der ROHE
     * Registerwert, keine kW: der Mensch schaut auf das Register, also ist die
     * Zahl, die er tippt, die Zahl, die landet.
     */
    public static Optional<Integer> parseValue(String input) {
        return parseNumber(input, 0, 0xffff);
    }

    private static Optional<Integer> parseNumber(String input, int min, int max) {
        if (input == null) {
            return Optional.empty();
        }
        String t = input.trim().toLowerCase(Locale.ROOT).replace("_", "");
        if (t.isEmpty()) {
            return Optional.empty();
        }
        try {
            int v = t.startsWith("0x")
                    ? Integer.parseInt(t.substring(2), 16)
                    : Integer.parseInt(t, 10);
            return v < min || v > max ? Optional.empty() : Optional.of(v);
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
    }

    /**
     * Die Adresse in der Schreibweise, die der Bestätigungs-Token benutzt
     * ({@code 0X00E7}) - er nennt Register UND Wert, damit eine Bestätigung aus
     * einem früheren, anderen Versuch diesen nicht autorisiert.
     */
    public static String confirmToken(int address, int value) {
        return String.format(Locale.ROOT, "0X%04X=%d", address, value);
    }

    /** Die kanonische Anzeige-Schreibweise einer Adresse ({@code 0x00e7}). */
    public static String hex(int address) {
        return String.format(Locale.ROOT, "0x%04x", address);
    }

    private static String kw(double v) {
        return String.format(Locale.GERMANY, "%.1f", v);
    }

    private static String trimScale(double scale) {
        String s = String.format(Locale.ROOT, "%.4f", scale);
        s = s.replaceAll("0+$", "").replaceAll("\\.$", "");
        return s.replace('.', ',');
    }
}
