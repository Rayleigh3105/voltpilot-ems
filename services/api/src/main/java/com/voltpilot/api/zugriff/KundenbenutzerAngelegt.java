package com.voltpilot.api.zugriff;

import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import java.util.UUID;

/**
 * Ein Kundenbenutzer ist in Keycloak angelegt — über die Selbstregistrierung oder die Admin-Konsole. Bis die
 * Benutzerverwaltung des Kunden eine Rolle vergibt (AP-03 IP-13/IP-14), ist jeder Kundenbenutzer
 * Kundenadministrator (E12): {@link ZugriffBestand#beiAnlage} spiegelt das Konto und trägt die Zuweisung ein,
 * damit kein Konto, das nach dem letzten Start entsteht, bis zum nächsten Start ohne sie bleibt.
 *
 * <p>Diese Zuweisung ist AUSDRÜCKLICH: eine echte Zeile in {@code zugriff}, protokolliert und entziehbar — nicht
 * die Regel E12 in der Anfrage, die der Stichtag ({@code V20260916060000}) begrenzt.
 *
 * @param tenantId der Kundenbereich, in dem das Konto angelegt wurde
 * @param konto das angelegte Konto (sein {@code id} ist das Subject des Tokens)
 * @param neuerKundenbereich der Kundenbereich ist mit diesem Konto ENTSTANDEN (Selbstregistrierung) — er hat keinen
 *     Bestand, also setzt die Übernahme seinen Stichtag sofort: ab Geburt gilt „nur mit ausdrücklicher Zuweisung"
 */
public record KundenbenutzerAngelegt(UUID tenantId, KeycloakUser konto, boolean neuerKundenbereich) {

    /** Ein Konto in einem BESTEHENDEN Kundenbereich (Admin-Konsole): am Stichtag ändert sich nichts. */
    public KundenbenutzerAngelegt(UUID tenantId, KeycloakUser konto) {
        this(tenantId, konto, false);
    }
}
