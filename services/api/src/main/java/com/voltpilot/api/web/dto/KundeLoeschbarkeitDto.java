package com.voltpilot.api.web.dto;

import java.util.List;
import java.util.UUID;

/**
 * Die Datenauskunft eines Kundenbereichs für den Bestätigungs-Dialog „Kunde endgültig löschen"
 * (vp-kunde-sofort-loeschen-mit-daten): JEDER Kunde ist sofort löschbar, mit oder ohne
 * Datenbestand - dieser Befund trägt nur noch, was dabei verloren geht. {@code daten} sind die
 * gefundenen Datenarten aus {@code KundeDatenBestand} (leer = keine Daten); {@code beendetAm} ist
 * ein Kalendertag (ISO, Europe/Berlin) oder {@code null} für einen aktiven Kunden; {@code folgen}
 * trägt nur die Einzel-Route ({@code GET /tenants/{id}/loeschbarkeit}).
 */
public record KundeLoeschbarkeitDto(
        UUID tenantId,
        List<String> daten,
        String beendetAm,
        FolgenDto folgen) {

    /** Was das Löschen umfasst: Anlagen, nie ausgebaute Boxen (Kennungen werden wieder anmeldbar), Personen. */
    public record FolgenDto(int anlagen, List<String> boxen, int personen) {
    }
}
