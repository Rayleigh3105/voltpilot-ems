package com.voltpilot.api.web;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import org.springframework.security.core.Authentication;

/**
 * Ist der Aufrufer ein Kundenkonto ({@code KONTO_benutzer}: gültiges {@code tenant_id}, weder Partner
 * noch Plattform)? Kundenkonten sprechen über das Portal; für sie gelten die engeren Regeln des
 * Anlege-Wegs (Anlage-Flow a1: nur Kennungen einer Box, Standort ausdrücklich wählen). Plattform und
 * Servicekonten (Integrationen, Saat) behalten die offenen Formen.
 */
final class Kundenkonto {

    private Kundenkonto() {
    }

    static boolean ist(Authentication auth) {
        return auth != null && auth.getAuthorities().stream().anyMatch(a ->
                KeycloakRealmRoleConverter.KONTO_BENUTZER.equals(a.getAuthority()));
    }
}
