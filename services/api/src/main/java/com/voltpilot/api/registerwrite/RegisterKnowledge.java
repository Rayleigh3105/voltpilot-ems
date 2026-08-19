package com.voltpilot.api.registerwrite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

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
 * <p><b>⚠ SEIT STUFE 2 IST ES EIN DATEN-VERZEICHNIS UND SPRICHT JE FAMILIE.</b>
 * Die Register liegen als Ressource im api-Jar
 * ({@code registerknowledge/catalog.json}, das
 * {@code entitytypes/catalog.json}-Muster), und die FAMILIE ist Teil des
 * Schlüssels - nie pauschal die Adresse: auf {@code hybrid_1p} ist die
 * Einspeisegrenze ein ANDERES Register mit ANDERER Skala ({@code 0x00F5},
 * Skala 1) als auf {@code hybrid_3p} ({@code 0x00E7}, Skala 10), und genau
 * jenes schreibt dort unser eigener Steuerpfad. Eine adress-pauschale Aussage
 * wäre auf der Hälfte der Flotte schlicht falsch.
 *
 * <p><b>⚠ DIE REGISTER-FAKTEN GEHÖREN DEM REPO, NICHT DIESER DATEI.</b> Sie
 * stammen aus {@code edge-app/nodered/inverter-control-routing.js}
 * ({@code DEYE_CONTROL_REG}) und {@code DEYE.md}; wer sie dort ändert, ändert
 * sie hier mit - sonst behauptet das Portal einen Namen, den das Gerät nicht
 * trägt. Ein Register, das das Verzeichnis nicht kennt, bekommt KEINEN
 * erfundenen Namen, sondern die Klasse {@link #CLASS_UNBEKANNT}.
 *
 * <p><b>Es entscheidet weiterhin NICHTS.</b> Ob geschrieben werden darf, prüft
 * die Box ({@code edge-app/core/internal/installerwrite}); dieses Verzeichnis
 * beantwortet nur, was ein Mensch vor dem Klick wissen sollte.
 */
@Component
public class RegisterKnowledge {

    /** Die Klasse, die eine Notiz erzwingt: Register der Netz-Anmeldung. */
    public static final String CLASS_NETZ_COMPLIANCE = "netz_compliance";
    /** VoltPilot kennt das Register: Name, Skala und Einheit werden gezeigt. */
    public static final String CLASS_BEKANNT = "bekannt";
    /** Alles andere - nur Rohwert, mit der deutlichsten Warnung. */
    public static final String CLASS_UNBEKANNT = "unbekannt";

    /** Deye „Grid Max Export power" - die Einspeisegrenze am Netzanschluss. */
    public static final int DEYE_EXPORT_LIMIT_ADDR = 0x00e7;

    private static final Logger log = LoggerFactory.getLogger(RegisterKnowledge.class);
    private static final String RESOURCE = "registerknowledge/catalog.json";

    /** Was die Plattform über EINE Familie weiß, nach Adresse. */
    private final Map<String, Map<Integer, Known>> byFamily;
    /** Die Familien in der Reihenfolge des Verzeichnisses (für die Betreiber-Sicht). */
    private final List<FamilyView> families;
    /**
     * Die Adressen, die in IRGENDEINER bekannten Familie zur Netz-Anmeldung
     * gehören - die Grundlage der Vorsichts-Warnung unten.
     */
    private final Set<Integer> complianceAddresses;

    public RegisterKnowledge(ObjectMapper mapper) {
        Map<String, Map<Integer, Known>> known = new HashMap<>();
        List<FamilyView> views = new java.util.ArrayList<>();
        try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
            JsonNode root = mapper.readTree(in);
            for (JsonNode f : root.path("families")) {
                String family = f.path("family").asText("");
                if (family.isBlank()) {
                    continue;
                }
                Map<Integer, Known> regs = new HashMap<>();
                List<RegisterView> list = new java.util.ArrayList<>();
                for (JsonNode r : f.path("registers")) {
                    int address = r.path("address").asInt(-1);
                    if (address < 0 || address > 0xffff) {
                        continue;
                    }
                    Known k = new Known(text(r, "label"), clazz(text(r, "class")),
                            r.has("scale") ? r.path("scale").asDouble() : null,
                            text(r, "unit"), text(r, "note"));
                    regs.put(address, k);
                    list.add(new RegisterView(address, hex(address), k.label(), k.clazz(),
                            k.scale(), k.scaleUnit(), k.note()));
                }
                known.put(family, Map.copyOf(regs));
                views.add(new FamilyView(family, text(f, "brand"), text(f, "label"),
                        List.copyOf(list)));
            }
        } catch (IOException e) {
            // Ein fehlendes Verzeichnis darf die api nie am Start hindern: dann
            // ist JEDES Register „unbekannt" - die ehrlichste Degradation, die
            // dieser Pfad kennt (und die sicherste: sie warnt am deutlichsten).
            log.error("register knowledge {} could not be read - every register reads as unknown",
                    RESOURCE, e);
        }
        this.byFamily = Map.copyOf(known);
        this.families = List.copyOf(views);
        Set<Integer> compliance = new java.util.HashSet<>();
        known.values().forEach(regs -> regs.forEach((addr, k) -> {
            if (CLASS_NETZ_COMPLIANCE.equals(k.clazz())) {
                compliance.add(addr);
            }
        }));
        this.complianceAddresses = Set.copyOf(compliance);
    }

    /** Eine Register-Zeile des Verzeichnisses, wie eine Betreiber-Sicht sie zeigt. */
    public record RegisterView(int address, String addressHex, String label, String clazz,
            Double scale, String unit, String note) {
    }

    /** Eine Familie des Verzeichnisses. */
    public record FamilyView(String family, String brand, String label,
            List<RegisterView> registers) {
    }

    /** Das ganze Verzeichnis - reine Anzeige, entscheidet nichts. */
    public List<FamilyView> catalog() {
        return families;
    }

    private static String text(JsonNode n, String field) {
        String v = n.path(field).asText(null);
        return v == null || v.isBlank() ? null : v;
    }

    /** Ein Klassen-Wort außerhalb des Vokabulars wird VERWORFEN, nie übernommen. */
    private static String clazz(String raw) {
        if (CLASS_NETZ_COMPLIANCE.equals(raw) || CLASS_BEKANNT.equals(raw)) {
            return raw;
        }
        return CLASS_UNBEKANNT;
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
    public record Known(String label, String clazz, Double scale, String scaleUnit, String note) {

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

        /** Ob dieses Register überhaupt bekannt ist. */
        public boolean known() {
            return !CLASS_UNBEKANNT.equals(clazz);
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
     * Das Wissen zu einem Register EINER Familie. Ein unbekanntes Register
     * bekommt die Klasse {@link #CLASS_UNBEKANNT} und KEINEN Namen - „VoltPilot
     * kennt dieses Register nicht" ist eine Aussage, ein erfundener Name wäre
     * eine Lüge.
     *
     * <p><b>⚠ EINE UNBEKANNTE FAMILIE IST NICHT DIESELBE FRAGE WIE EIN
     * UNBEKANNTES REGISTER, und beide werden gleich behandelt - absichtlich:</b>
     * ohne Familie (die Box hat ihren Wechselrichter noch nicht gemeldet, oder
     * es ist ein fremdes Gerät im LAN) weiß die Plattform NICHTS über die
     * Adresse. Sie dann mit einer Deye-Bedeutung zu beschriften, wäre die
     * gefährlichste Auskunft dieses ganzen Pfades.
     */
    public Known of(String family, int address) {
        Map<Integer, Known> regs = family == null ? null
                : byFamily.get(family.trim().toLowerCase(Locale.ROOT));
        Known k = regs == null ? null : regs.get(address);
        if (k != null) {
            return k;
        }
        // ⚠ DIE WARNUNG VERALLGEMEINERT, DER NAME NICHT - die eine Asymmetrie
        // dieser Klasse, und sie ist bewusst:
        //
        //   * Eine Adresse, die auf IRGENDEINER bekannten Baureihe zur
        //     Netz-Anmeldung gehört, behält ihre Klasse (und damit die
        //     Notiz-PFLICHT aus D5) auch ohne gemeldete Familie. Sonst
        //     verschwände die Pflicht genau auf den Anlagen, deren Box ihre
        //     Einrichtung (noch) nicht meldet - eine Regel, die sich still
        //     selbst abschaltet, ist keine.
        //   * Ein NAME und eine SKALA werden dabei NICHT übernommen: welches
        //     Gerät hier wirklich antwortet, weiß niemand, und ein Deye-Name auf
        //     einem fremden Modbus-Gerät wäre die gefährlichste Auskunft dieses
        //     ganzen Pfades.
        //
        // Eine unnötige Notiz kostet einen Satz; eine fehlende Warnung kostet
        // eine Netz-Anmeldung.
        if (complianceAddresses.contains(address)) {
            return new Known(null, CLASS_NETZ_COMPLIANCE, null, null,
                    "Auf mindestens einer bekannten Wechselrichter-Baureihe ist dies ein "
                            + "Register der Netz-Anmeldung. Welches Gerät hier antwortet, ist "
                            + "VoltPilot nicht bekannt - deshalb ohne Namen und ohne "
                            + "Umrechnung.");
        }
        return new Known(null, CLASS_UNBEKANNT, null, null, null);
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
