package com.voltpilot.api.measurement;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Validation and canonical form of “Eigenen Messwert hinzufügen”. */
public final class CustomMeasurementPoint {

    private static final Set<String> SOURCES = Set.of("modbus_holding", "modbus_input");
    private static final Set<String> ENDIANS = Set.of("big", "word_little_byte_big");
    private static final Pattern UNIT = Pattern.compile("^[^\\p{Cntrl}]{1,32}$");

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
            @Min(400) @Max(2000) Integer estimatedRequestMs) {
        /** Boot normally ignores unknown JSON; free registers must fail closed. */
        @JsonAnySetter
        public void rejectUnknownProperty(String name, Object ignored) {
            throw bad("Unbekanntes Feld „" + name
                    + "“; Schreibparameter sind für eigene Messwerte nicht erlaubt.");
        }
    }

    public record Canonical(String label, String sourceKind, int address, String selector,
            String valueType, int widthBits, boolean signed, String endian, BigDecimal scale,
            String unit, int cadenceS, String retentionClass, boolean readOnly,
            int estimatedRequestMs) {}

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
        int requestMs = d.estimatedRequestMs() == null ? 400 : d.estimatedRequestMs();
        if (requestMs < 400 || requestMs > 2000) {
            throw bad("Die konservative sichere Lesedauer muss zwischen 400 und 2000 ms liegen.");
        }
        return new Canonical(d.label().trim(), source, d.address(), expectedSelector, type,
                expected.width, expected.signed, endian, d.scale().stripTrailingZeros(), unit,
                d.cadenceS(), lower(d.retentionClass()), true, requestMs);
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
