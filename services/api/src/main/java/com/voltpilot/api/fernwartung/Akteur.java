package com.voltpilot.api.fernwartung;

import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Wer eine Fernwartungs-Änderung auslöst: das JWT-Subject als stabile
 * Identität, der Anmeldename für Menschen, die das Protokoll lesen.
 */
public record Akteur(String sub, String name) {

    public static Akteur aus(Jwt jwt) {
        if (jwt == null || jwt.getSubject() == null || jwt.getSubject().isBlank()) {
            return new Akteur("unbekannt", null);
        }
        Object name = jwt.getClaims().get("preferred_username");
        if (name == null) {
            name = jwt.getClaims().get("name");
        }
        return new Akteur(jwt.getSubject(), name == null ? null : name.toString());
    }
}
