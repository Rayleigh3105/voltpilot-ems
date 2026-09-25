package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
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
 */
public record RegistrationRequest(
        @NotBlank @Size(max = 200) String name,
        @NotBlank @Email @Size(max = 254) String email,
        @NotBlank @Size(min = 12, max = 128) String password) {

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
