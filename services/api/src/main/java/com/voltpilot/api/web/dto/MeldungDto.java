package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Eine Meldung im Meldungs-Center (Alerting Scheibe 1, Konzept §6.8 Entwurf 2/3/5) - die
 * Portal-Form von {@code UeberwachungRepository.AlarmZeile}, mit der Anlage aufgelöst.
 */
public record MeldungDto(String id, String kennzeichen, String wertart, String schwere, String anlageId,
        String anlageName, String standortId, Instant ausgeloestAm, String zustand, Instant wiederNormalAm,
        String gesehenVon, Instant gesehenAm, Instant erledigtAm) {

    public record Liste(List<MeldungDto> meldungen) {}

    public record Zahl(long ungesehen, boolean dringend) {}
}
