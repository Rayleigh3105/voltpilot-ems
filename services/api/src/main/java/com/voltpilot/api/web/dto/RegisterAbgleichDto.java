package com.voltpilot.api.web.dto;

import java.util.List;
import java.util.UUID;

/**
 * S5 (vp-mastr-mehrere-einheiten-konzept §6/§8): der Plattform-Admin
 * "Register-Abgleich" - vier Hinweis-Kategorien über alle Anlagen hinweg,
 * cross-tenant, read-only.
 */
public record RegisterAbgleichDto(List<Zeile> messungUeberSumme, List<Zeile> registerGeaendert,
        List<Zeile> nummerAnZweiAnlagen, List<Zeile> ohneRegister) {

    public record Zeile(UUID siteId, String siteName, UUID tenantId, String tenantName, String hinweis) {
    }
}
