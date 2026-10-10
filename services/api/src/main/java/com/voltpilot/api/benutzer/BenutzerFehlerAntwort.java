package com.voltpilot.api.benutzer;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class BenutzerFehlerAntwort {
    @ExceptionHandler(BenutzerFehler.class)
    public ResponseEntity<Map<String, String>> antwort(BenutzerFehler e) {
        return ResponseEntity.status(e.status).body(Map.of("code", e.code, "message", e.getMessage()));
    }

    @ExceptionHandler(KeycloakAdminException.class)
    public ResponseEntity<Map<String, String>> keycloak(KeycloakAdminException e) {
        int status = e.status() == 400 || e.status() == 409 ? e.status() : 502;
        return ResponseEntity.status(status).body(Map.of("code", status == 409 ? "konto_vorhanden"
                : status == 400 ? "passwort_regeln" : "konto_nicht_erreichbar", "message", status == 409
                ? "Benutzername oder E-Mail-Adresse ist bereits vergeben." : status == 400
                ? "Die Passwortregeln erlauben dieses Startpasswort nicht. Bitte wenden Sie sich an VoltPilot."
                : "Das Benutzerkonto ist gerade nicht erreichbar. Bitte versuchen Sie es erneut."));
    }
}
