package com.voltpilot.api.uems;

import java.util.Optional;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Der Urheber eines Protokolleintrags im Akteur-Vokabular von AP-03 ({@code actor_sub},
 * {@code actor_name}, {@code actor_rolle}, {@code actor_art}; CHECKs in
 * V20260911140000 an {@code messstelle_aenderung}).
 *
 * <p><b>Die EINE Stelle, die aus dem Aufrufer eine Rolle macht — bis AP-03 Zuweisungen
 * bringt.</b> Heute gibt es nur zwei Prinzipale (Kundenbenutzer mit {@code tenant_id}-Claim,
 * Plattform-Admin mit dem Mandanten-Umschalter {@code X-Tenant-Id}); die Rolle wird deshalb
 * nicht nachgeschlagen, sondern festgelegt:
 * <ul>
 *   <li>Kundenbenutzer → {@code kundenadministrator}, Art {@code kunde} — AP-03 E12: „jeder
 *       heutige Kundenbenutzer wird Kundenadministrator“.</li>
 *   <li>Plattform-Admin → {@code voltpilot_betrieb}, Art {@code voltpilot} — die
 *       Plattform-Rolle. Die Rechte-Matrix gibt ihr {@code messstelle.bearbeiten} NICHT
 *       („-“, AP-03 E8: Admin-Zugriff wird Unterstützung); bis AP-03 durchsetzt, darf sie wie
 *       auf {@code /api/v1/sites/**} und steht dann ehrlich als VoltPilot im Protokoll.</li>
 * </ul>
 * Wer das ändert (AP-03 IP-7 vereinheitlicht die Journale), ändert es HIER.
 */
public record ProtokollAkteur(String sub, String name, String rolle, String art) {

    static final String ART_KUNDE = "kunde";
    static final String ART_VOLTPILOT = "voltpilot";

    /** Dieselbe Realm-Rolle, an der {@code TenantFilter} den Mandanten-Umschalter freigibt. */
    private static final String PLATTFORM_ADMIN = "ROLE_platform-admin";

    /** Der Urheber des angemeldeten Aufrufers; leer ohne JWT (nur bei abgeschaltetem OIDC). */
    public static Optional<ProtokollAkteur> aus(Authentication auth) {
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)
                || jwt.getSubject() == null || jwt.getSubject().isBlank()) {
            return Optional.empty();
        }
        Object name = jwt.getClaims().get("preferred_username");
        if (name == null) {
            name = jwt.getClaims().get("name");
        }
        boolean plattformAdmin = auth.getAuthorities().stream()
                .anyMatch(a -> PLATTFORM_ADMIN.equals(a.getAuthority()));
        return Optional.of(fuer(jwt.getSubject(), name == null ? null : name.toString(), plattformAdmin));
    }

    /**
     * @param sub das JWT-Subject — die maschinenstabile Identität
     * @param anzeigename {@code preferred_username} bzw. {@code name}; leer → das Subject, damit
     *     der Eintrag immer einen Namen trägt
     * @param plattformAdmin trägt der Aufrufer die Realm-Rolle {@code platform-admin}?
     */
    public static ProtokollAkteur fuer(String sub, String anzeigename, boolean plattformAdmin) {
        String name = anzeigename == null || anzeigename.isBlank() ? sub : anzeigename.trim();
        return plattformAdmin
                ? new ProtokollAkteur(sub, name, RechteAbleitung.Rolle.VOLTPILOT_BETRIEB.code(), ART_VOLTPILOT)
                : new ProtokollAkteur(sub, name, RechteAbleitung.Rolle.KUNDENADMINISTRATOR.code(), ART_KUNDE);
    }
}
