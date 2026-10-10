package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * Der von einem Gerät gemeldete Software-Stand (Admin-Umbau Stufe 1, Spalte
 * „Edge-Stand" der Plattform-Übersicht).
 *
 * <p>{@code coreVersion} ist die laufende {@code vp-edge-core}-Version,
 * {@code paletteVersion} die installierte {@code @voltpilot/node-red-vp-palette}
 * - beide einzeln nullable, weil die Edge ein leeres Feld weglässt (die
 * Palette-Version fehlt z. B., solange die Node-RED-Admin-API nicht
 * konfiguriert ist).
 *
 * <p>{@code coreVersion} wird bevorzugt aus der unabhängig vom Flow-Deployment
 * gesendeten Top-Level-Version gebildet. Der {@code flows}-Block bleibt
 * Fallback und Quelle für {@code paletteVersion}. Kein Eintrag heißt weiterhin
 * „unbekannt", nie „alt".
 */
public record EdgeVersionDto(UUID deviceId, UUID siteId, String coreVersion,
        String paletteVersion, Instant reportedAt,
        // Geräteseiten Stufe 1 (R2a): das URTEIL gegen das Release-Register,
        // additiv. `newestRelease` ist der Soll-Stand (null = leeres Register,
        // also kein Maßstab), `upToDate` DREIWERTIG - null heißt „nicht
        // bewertbar" (nichts gemeldet ODER nicht registriert), NIE „veraltet".
        // Es reist das Urteil, nie das Register (EdgeStandVerdict).
        String newestRelease, Boolean upToDate,
        // Raw report plus the central reported-OR-table result. Null report = legacy box.
        java.util.List<String> supports, java.util.List<String> capabilities) {

    public EdgeVersionDto(UUID deviceId, UUID siteId, String coreVersion, String paletteVersion,
            Instant reportedAt, String newestRelease, Boolean upToDate) {
        this(deviceId, siteId, coreVersion, paletteVersion, reportedAt, newestRelease, upToDate, null, null);
    }

    /** Die Vor-R2a-Form - ohne Urteil, für Aufrufer, die keines bilden. */
    public EdgeVersionDto(UUID deviceId, UUID siteId, String coreVersion, String paletteVersion,
            Instant reportedAt) {
        this(deviceId, siteId, coreVersion, paletteVersion, reportedAt, null, null);
    }
}
