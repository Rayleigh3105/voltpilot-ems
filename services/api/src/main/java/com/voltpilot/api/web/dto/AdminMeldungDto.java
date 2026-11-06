package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Eine Meldung plattformweit (Lücke L5) - dieselben Felder wie {@code MeldungDto}, plus Mandant. */
public record AdminMeldungDto(String id, String kennzeichen, String tenantId, String tenantName,
        String standortId, String bezugKennung, String wertart, String schwere, Instant ausgeloestAm,
        String zustand, Instant wiederNormalAm, String gesehenVon, Instant gesehenAm, Instant erledigtAm) {

    public record Liste(List<AdminMeldungDto> meldungen) {
    }

    public record Zahl(long ungesehen) {
    }
}
