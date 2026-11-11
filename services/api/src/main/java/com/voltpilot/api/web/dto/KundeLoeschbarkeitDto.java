package com.voltpilot.api.web.dto;

import java.util.List;
import java.util.UUID;

/**
 * Die Löschbarkeit eines Kundenbereichs (vp-kunde-sofort-loeschen): sofort (keine Daten) oder nach
 * der Frist. {@code daten} sind die gefundenen Datenarten aus {@code KundeDatenBestand} (leer =
 * sofort löschbar); {@code beendetAm}/{@code loeschungFruehestens} sind Kalendertage (ISO,
 * Europe/Berlin) oder {@code null} für einen aktiven Kunden; {@code folgen} trägt nur die
 * Einzel-Route ({@code GET /tenants/{id}/loeschbarkeit}), die Liste lässt sie weg.
 */
public record KundeLoeschbarkeitDto(
        UUID tenantId,
        boolean sofortLoeschbar,
        List<String> daten,
        String beendetAm,
        String loeschungFruehestens,
        boolean fristAbgelaufen,
        FolgenDto folgen) {

    /** Was das Löschen umfasst: Anlagen, nie ausgebaute Boxen (Kennungen werden wieder anmeldbar), Personen. */
    public record FolgenDto(int anlagen, List<String> boxen, int personen) {
    }
}
