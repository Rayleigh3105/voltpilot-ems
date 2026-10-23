package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.Locale;

/**
 * Self-service registration: a new customer creates their own tenant + login in
 * one step. {@code name} is the person or company name and becomes the tenant's
 * display name; {@code email} doubles as the login username.
 *
 * <p>Password rule (AP-20 E12, same as the hardened realm): at least 12
 * characters and not the username - here the email - nor the name, compared
 * trimmed and case-insensitively. The portal checks the same before sending.
 *
 * <p>{@code zweck} (additiv, Anlage-Flow a1, Entscheid D2): die eine Frage der Registrierung -
 * {@code zuhause} („Für mein Zuhause“) oder {@code unternehmen} („Für ein Unternehmen“). Sie setzt
 * Segment und Betriebsart des neuen Kundenbereichs ({@link #segment()}, {@link #betriebsart()}),
 * und der Anlege-Weg liest sie über {@code /api/v1/tenant-context}. Fehlt sie (ältere Portale),
 * bleibt alles wie bisher: Segment B2C, keine Betriebsart.
 */
public record RegistrationRequest(
        @NotBlank @Size(max = 200) String name,
        @NotBlank @Email @Size(max = 254) String email,
        @NotBlank @Size(min = 12, max = 128) String password,
        @Pattern(regexp = "zuhause|unternehmen", message = "zweck must be zuhause or unternehmen") String zweck) {

    /** Zwei Felder wie bisher - ohne Antwort auf die Frage. */
    public RegistrationRequest(String name, String email, String password) {
        this(name, email, password, null);
    }

    /** Das Segment: ein Unternehmen ist {@code CI}, sonst wie bisher {@code B2C}. */
    @JsonIgnore
    public String segment() {
        return "unternehmen".equals(zweck) ? "CI" : "B2C";
    }

    /** Die Betriebsart aus der Antwort ({@code endkunde}/{@code betreiber}); ohne Antwort keine. */
    @JsonIgnore
    public String betriebsart() {
        return zweck == null ? null : "unternehmen".equals(zweck) ? "betreiber" : "endkunde";
    }

    @JsonIgnore
    @AssertTrue(message = "password must not equal the email or the name")
    public boolean isPasswordNotName() {
        return !sameIgnoringCase(password, email) && !sameIgnoringCase(password, name);
    }

    private static boolean sameIgnoringCase(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        String x = a.trim().toLowerCase(Locale.ROOT);
        return !x.isEmpty() && x.equals(b.trim().toLowerCase(Locale.ROOT));
    }
}
