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
 * <p><b>Kein Eintrag heißt „unbekannt", nicht „alt".</b> Die Edge baut den
 * {@code flows}-Herzschlag-Block erst, nachdem sie einen Deployment-Satz
 * gesehen hat, ein Gerät ohne ausgerollte Automation meldet also gar keine
 * Version. Die Oberfläche muss das aussprechen und darf daraus nie eine
 * Veraltet-Aussage machen.
 */
public record EdgeVersionDto(UUID deviceId, UUID siteId, String coreVersion,
        String paletteVersion, Instant reportedAt) {
}
