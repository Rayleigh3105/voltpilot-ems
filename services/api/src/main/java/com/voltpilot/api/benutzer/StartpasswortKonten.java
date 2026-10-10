package com.voltpilot.api.benutzer;

import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import java.util.UUID;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Gemeinsamer Pflichtwechsel für Kunden, den ersten Administrator und neue Partner. */
@Service
public class StartpasswortKonten {
    private final KeycloakAdminClient keycloak;

    public StartpasswortKonten(KeycloakAdminClient keycloak) { this.keycloak = keycloak; }

    public record Angelegt(KeycloakUser konto, Startpasswort startpasswort) {}

    public Angelegt kunde(UUID tenant, String username, String email, String vorname, String nachname) {
        Startpasswort passwort = Startpasswort.erzeugen();
        KeycloakUser konto = keycloak.createCustomerUser(tenant, username, email, vorname, nachname,
                passwort.wert(), true);
        kompensation(konto.id());
        return new Angelegt(konto, passwort);
    }

    public Angelegt partner(String email) {
        Startpasswort passwort = Startpasswort.erzeugen();
        KeycloakUser konto = keycloak.createPartnerUser(email, email, null, null, passwort.wert(), true);
        kompensation(konto.id());
        return new Angelegt(konto, passwort);
    }

    public Startpasswort neu(String sub) {
        Startpasswort passwort = Startpasswort.erzeugen();
        keycloak.resetPassword(sub, passwort.wert(), true);
        return passwort;
    }

    private void kompensation(String sub) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) return;
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCompletion(int status) {
                if (status != STATUS_COMMITTED) {
                    try { keycloak.deleteUser(sub); }
                    catch (RuntimeException ex) {
                        LoggerFactory.getLogger(StartpasswortKonten.class)
                                .warn("Konto {} nach abgebrochener Anlage nicht entfernt", sub);
                    }
                }
            }
        });
    }
}
