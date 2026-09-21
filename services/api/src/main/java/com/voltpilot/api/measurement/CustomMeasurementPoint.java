package com.voltpilot.api.measurement;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.voltpilot.api.uems.MessstelleRegeln;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Validation and canonical form of “Eigenen Messwert hinzufügen”. */
public final class CustomMeasurementPoint {

    private static final Set<String> SOURCES = Set.of("modbus_holding", "modbus_input");
    private static final Set<String> ENDIANS = Set.of("big", "word_little_byte_big");
    private static final Pattern UNIT = Pattern.compile("^[^\\p{Cntrl}]{1,32}$");

    /**
     * Was ein eigener Messwert messen darf, damit er eine Messstelle trägt (Schnitt 2 der
     * Untersuchung „Portal-Weg Messkunde“, 21.09.2026): Katalogwort {@code quantity} → die
     * einzige Wertart ({@code aggregation_kind}), die dazu passt. Genau die Kombinationen, die
     * {@code MessstelleRegeln} als Fluss vorschlägt (Wirkgröße mit Richtung) — nichts, was
     * danach doch keine Messstelle bekommt.
     */
    public static final Map<String, String> MESSGROESSEN = Map.of(
            "active_energy", "counter",
            "active_power", "gauge");

    /** Die Richtungen (Katalogwort {@code direction}), die einen Fluss des Vorschlags tragen. */
    public static final List<String> RICHTUNGEN = List.of("import", "export", "generation", "charge", "discharge");

    /**
     * Die Aufbewahrungsklasse, aus der der Writer die Wertart eines eigenen Messwerts liest
     * ({@code MeasurementWriteRepository.metadata}: {@code energy_counter} → counter, jede andere
     * gemessene Klasse → gauge). Die Angabe muss dazu passen, sonst trüge der Kanal eine andere
     * Wertart als seine gespeicherten Werte.
     */
    private static final Map<String, Set<String>> AUFBEWAHRUNG = Map.of(
            "counter", Set.of("energy_counter"),
            "gauge", Set.of("live_power", "phase_mppt_string", "thermal_bms"));

    private CustomMeasurementPoint() {}

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record Definition(
            @NotBlank @Size(max = 120) String label,
            @NotBlank String sourceKind,
            @NotNull @Min(0) @Max(65535) Integer address,
            @NotBlank @Size(max = 80) String selector,
            @NotBlank String valueType,
            @NotNull Integer widthBits,
            @NotNull Boolean signed,
            @NotBlank String endian,
            @NotNull BigDecimal scale,
            @NotBlank @Size(max = 32) String unit,
            @NotNull @Min(1) @Max(86400) Integer cadenceS,
            @NotBlank String retentionClass,
            @NotNull Boolean readOnly,
            @Valid Measures measures) {
        /** Ohne Angabe, was der Wert misst — die Form von vor Schnitt 2. */
        public Definition(String label, String sourceKind, Integer address, String selector,
                String valueType, Integer widthBits, Boolean signed, String endian, BigDecimal scale,
                String unit, Integer cadenceS, String retentionClass, Boolean readOnly) {
            this(label, sourceKind, address, selector, valueType, widthBits, signed, endian, scale,
                    unit, cadenceS, retentionClass, readOnly, null);
        }

        /** Boot normally ignores unknown JSON; free registers must fail closed. */
        @JsonAnySetter
        public void rejectUnknownProperty(String name, Object ignored) {
            throw bad("Unbekanntes Feld „" + name
                    + "“; Schreibparameter sind für eigene Messwerte nicht erlaubt.");
        }
    }

    /**
     * Was der eigene Messwert misst — in den Wörtern des Katalogs, wie ein Katalog-Kanal sie trägt
     * ({@code quantity}, {@code direction}, {@code aggregation_kind}); {@link MesskanalService} bildet
     * sie über {@link MesskanalAbbildung} auf Größe, Richtung und Wertart ab. Wohnt nur in der Cloud:
     * {@link MeasurementConfigPublisher} gibt sie der Box nie mit ({@code mqtt-measurement-config}
     * ist geschlossen, {@code additionalProperties: false}).
     */
    public record Measures(String quantity, String direction, String aggregationKind) {
        @JsonAnySetter
        public void rejectUnknownProperty(String name, Object ignored) {
            throw bad("Unbekanntes Feld „" + name + "“ in der Angabe, was der Wert misst.");
        }
    }

    /**
     * Die gespeicherte Form. {@code measures} fehlt im JSON, wenn es keine Angabe gibt — dann ist
     * die Zeile Zeichen für Zeichen die von vor Schnitt 2.
     */
    public record Canonical(String label, String sourceKind, int address, String selector,
            String valueType, int widthBits, boolean signed, String endian, BigDecimal scale,
            String unit, int cadenceS, String retentionClass, boolean readOnly,
            int requestCostMs, @JsonInclude(JsonInclude.Include.NON_NULL) Measures measures) {
        public Canonical(String label, String sourceKind, int address, String selector,
                String valueType, int widthBits, boolean signed, String endian, BigDecimal scale,
                String unit, int cadenceS, String retentionClass, boolean readOnly,
                int requestCostMs) {
            this(label, sourceKind, address, selector, valueType, widthBits, signed, endian, scale,
                    unit, cadenceS, retentionClass, readOnly, requestCostMs, null);
        }
    }

    public static Canonical validate(Definition d) {
        if (d == null) {
            throw bad("Die Definition des eigenen Messwerts fehlt.");
        }
        if (d.label() == null || d.label().isBlank() || d.label().trim().length() > 120) {
            throw bad("Bitte eine Bezeichnung mit höchstens 120 Zeichen angeben.");
        }
        String source = lower(d.sourceKind());
        if (!SOURCES.contains(source)) {
            throw bad("Eigene Messwerte dürfen nur lesbare Modbus-Holding- oder Input-Register sein.");
        }
        if (!Boolean.TRUE.equals(d.readOnly())) {
            throw bad("Eigene Messwerte sind ausschließlich lesbar; eine Schreibfunktion ist nicht erlaubt.");
        }
        if (d.address() == null || d.address() < 0 || d.address() > 0xffff) {
            throw bad("Die Registeradresse muss zwischen 0 und 65535 liegen.");
        }
        String expectedSelector = ("modbus_holding".equals(source) ? "holding:" : "input:")
                + String.format(Locale.ROOT, "0x%04x", d.address());
        if (d.selector() == null || !expectedSelector.equals(lower(d.selector().trim()))) {
            throw bad("Selektor und Registeradresse widersprechen sich; erwartet wird „"
                    + expectedSelector + "“.");
        }
        String type = lower(d.valueType());
        Type expected = Type.of(type);
        if (expected == null || d.widthBits() == null || d.widthBits() != expected.width
                || d.signed() == null || d.signed() != expected.signed) {
            throw bad("Datentyp, Breite und Vorzeichen passen nicht zusammen.");
        }
        int words = Math.max(1, expected.width / 16);
        if (d.address() + words > 65536) {
            throw bad("Das Mehrwortfeld reicht über das Ende des Modbus-Adressraums hinaus.");
        }
        String endian = lower(d.endian());
        if (!ENDIANS.contains(endian)) {
            throw bad("Byte-/Wortreihenfolge muss „big“ oder „word_little_byte_big“ sein.");
        }
        if (d.scale() == null || d.scale().compareTo(BigDecimal.ZERO) == 0
                || d.scale().abs().compareTo(new BigDecimal("1000000000")) > 0) {
            throw bad("Die Skala muss ungleich 0 und betragsmäßig höchstens 1.000.000.000 sein.");
        }
        String unit = d.unit() == null ? "" : d.unit().trim();
        if (!UNIT.matcher(unit).matches()) {
            throw bad("Die Einheit fehlt oder enthält unzulässige Steuerzeichen.");
        }
        if (d.cadenceS() == null || d.cadenceS() < 1 || d.cadenceS() > 86400) {
            throw bad("Die Kadenz muss zwischen 1 Sekunde und 24 Stunden liegen.");
        }
        MeasurementRetention.ofCustomClass(d.retentionClass());
        Measures measures = measures(d.measures(), unit, lower(d.retentionClass()));
        return new Canonical(d.label().trim(), source, d.address(), expectedSelector, type,
                expected.width, expected.signed, endian, d.scale().stripTrailingZeros(), unit,
                d.cadenceS(), lower(d.retentionClass()), true,
                MeasurementBudget.customRegisterRequestCostMs(), measures);
    }

    /**
     * Die Angabe, was der Wert misst: leer bleibt leer; sonst alle drei Wörter, eine Kombination
     * aus {@link #MESSGROESSEN} × {@link #RICHTUNGEN}, eine Einheit, die die Messstelle umrechnen
     * kann ({@link MessstelleRegeln#KANAL_EINHEITEN}), und eine Aufbewahrungsklasse mit derselben
     * Wertart.
     */
    private static Measures measures(Measures m, String unit, String retentionClass) {
        if (m == null) {
            return null;
        }
        String quantity = lower(m.quantity());
        String direction = lower(m.direction());
        String kind = lower(m.aggregationKind());
        String erwartet = MESSGROESSEN.get(quantity);
        if (erwartet == null || !RICHTUNGEN.contains(direction) || !erwartet.equals(kind)) {
            throw bad("Diese Angabe, was der Wert misst, kennt VoltPilot nicht. Möglich sind ein "
                    + "Energie-Zählerstand oder eine Leistung, jeweils mit Bezug, Abgabe, Erzeugung, "
                    + "Laden oder Entladen.");
        }
        List<String> einheiten = MessstelleRegeln.KANAL_EINHEITEN.get(MesskanalAbbildung.groesse(quantity));
        if (einheiten == null || !einheiten.contains(unit)) {
            throw bad(("counter".equals(kind) ? "Ein Energie-Zählerstand" : "Eine Leistung")
                    + " braucht die Einheit " + String.join(", ", einheiten.subList(0, einheiten.size() - 1))
                    + " oder " + einheiten.get(einheiten.size() - 1) + ".");
        }
        if (!AUFBEWAHRUNG.get(kind).contains(retentionClass)) {
            throw bad("counter".equals(kind)
                    ? "Ein Energie-Zählerstand wird als Zählerstand aufbewahrt (Aufbewahrungsklasse energy_counter)."
                    : "Eine Leistung wird als Momentanwert aufbewahrt, nicht als „" + retentionClass + "“.");
        }
        return new Measures(quantity, direction, kind);
    }

    private record Type(int width, boolean signed) {
        static Type of(String value) {
            return switch (value) {
                case "uint16" -> new Type(16, false);
                case "int16" -> new Type(16, true);
                case "uint32" -> new Type(32, false);
                case "int32" -> new Type(32, true);
                case "float32" -> new Type(32, true);
                case "float64" -> new Type(64, true);
                default -> null;
            };
        }
    }

    private static IllegalArgumentException bad(String message) {
        return new IllegalArgumentException(message);
    }

    private static String lower(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
