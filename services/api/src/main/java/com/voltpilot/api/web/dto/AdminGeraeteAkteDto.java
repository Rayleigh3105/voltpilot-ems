package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Die Geräteakte in EINER Antwort (Lücke L3): Kopf, Software, Verbindung,
 * Einrichtung und Lebenslauf-Herkunft einer Box. Felder sind {@code null},
 * wo der Lebensabschnitt sie nicht hat (eine nie geklaimede Box hat keinen
 * Software-/Verbindungsblock) - fehlend ist keine Null (AGENTS.md).
 */
public record AdminGeraeteAkteDto(
        String externalRef,
        String lebensabschnitt,
        Instant lebensabschnittSeit,
        Kopf kopf,
        Software software,
        Verbindung verbindung,
        Einrichtung einrichtung) {

    public record Kopf(String deviceId, String name, String siteId, String siteName,
            String tenantId, String tenantName, Instant herzschlagAm, Instant messwertAm,
            Instant lastSeenAt, Instant ausgebautAm) {
    }

    public record Software(AdminFleetDto.FleetEdgeDto edge, AdminFleetDto.FleetUpdateDto update,
            List<String> supports, String boxArt) {
    }

    public record Verbindung(String lanHost, Instant lanSeenAt, Boolean tunnelAktiv,
            String tunnelAdresse) {
    }

    public record Einrichtung(Instant zertifikatAusgestelltAm, Instant zertifikatGueltigBis,
            Instant werkstattAngelegtAm) {
    }
}
