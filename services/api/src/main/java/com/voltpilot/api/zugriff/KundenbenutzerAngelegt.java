package com.voltpilot.api.zugriff;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import java.util.UUID;

/**
 * Ein Kundenbenutzer ist in Keycloak angelegt — über die Selbstregistrierung oder die Admin-Konsole. Bis die
 * Benutzerverwaltung des Kunden eine Rolle vergibt (AP-03 IP-13/IP-14), ist jeder Kundenbenutzer
 * Kundenadministrator (E12): {@link ZugriffBestand#beiAnlage} spiegelt das Konto und trägt die Zuweisung ein,
 * damit kein Konto, das nach dem letzten Start entsteht, bis zum nächsten Start ohne sie bleibt.
 *
 * @param tenantId der Kundenbereich, in dem das Konto angelegt wurde
 * @param konto das angelegte Konto (sein {@code id} ist das Subject des Tokens)
 */
public record KundenbenutzerAngelegt(UUID tenantId, KeycloakUser konto) {}
