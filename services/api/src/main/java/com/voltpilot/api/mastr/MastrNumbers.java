package com.voltpilot.api.mastr;

import java.util.regex.Pattern;

/**
 * MaStR number validation/normalization. All registry numbers are 3 letters +
 * 12 digits; the customer-facing form asks ONLY for SEE numbers (both PV units
 * AND battery storage units are SEE - verified on real records). The other
 * prefixes get a specific German hint because customers routinely paste the
 * wrong number from their BNetzA confirmation letter.
 */
public final class MastrNumbers {

    private static final Pattern SEE = Pattern.compile("^SEE\\d{12}$");

    private MastrNumbers() {
    }

    /** Trim, uppercase and drop inner whitespace (letters get pasted with gaps). */
    public static String normalize(String raw) {
        return raw == null ? "" : raw.replaceAll("\\s+", "").toUpperCase();
    }

    /**
     * @return the normalized number
     * @throws RegistryLookupException INVALID_NUMBER with a customer-facing hint
     */
    public static String requireSee(String raw) throws RegistryLookupException {
        String cleaned = normalize(raw);
        if (cleaned.isEmpty()) {
            throw invalid("Bitte geben Sie eine MaStR-Nummer ein (SEE gefolgt von 12 Ziffern).");
        }
        String prefix = cleaned.length() >= 3 ? cleaned.substring(0, 3) : cleaned;
        if (!SEE.matcher(cleaned).matches()) {
            throw switch (prefix) {
                case "SES" -> invalid("„SES“-Nummern kennzeichnen keine Einheit. Bitte geben Sie die "
                        + "SEE-Nummer der Einheit ein - auch Batteriespeicher haben eine SEE-Nummer.");
                case "SSE" -> invalid("Das ist die Nummer der Speicher-ANLAGE. Bitte geben Sie die "
                        + "SEE-Nummer der Speicher-EINHEIT ein (steht ebenfalls in Ihrer "
                        + "Registrierungsbestätigung).");
                case "EEG" -> invalid("Das ist die Nummer der EEG-Anlage. Bitte geben Sie die "
                        + "SEE-Nummer der Einheit ein.");
                case "ABR" -> invalid("Das ist Ihre Betreibernummer. Bitte geben Sie die SEE-Nummer "
                        + "der Einheit ein.");
                default -> invalid("Ungültiges Format. Eine Einheitennummer beginnt mit SEE, gefolgt "
                        + "von 12 Ziffern (z. B. SEE966831669444).");
            };
        }
        return cleaned;
    }

    private static RegistryLookupException invalid(String message) {
        return new RegistryLookupException(RegistryLookupException.Reason.INVALID_NUMBER, message);
    }
}
