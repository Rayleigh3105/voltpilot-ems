package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/** Eine Box im Lebenslauf (Lücke L7) - die eine Geräte-Liste über alle Lebensabschnitte. */
public record AdminGeraeteListeDto(String externalRef, String lebensabschnitt, Instant seit,
        String deviceId, String siteId, String tenantId, String tenantName, String name) {

    public record Liste(List<AdminGeraeteListeDto> geraete) {
    }
}
