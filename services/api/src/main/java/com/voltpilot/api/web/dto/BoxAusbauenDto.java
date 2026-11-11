package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * "Box ausbauen" ohne Mandantensprung (vp-admin-box-ausbauen): derselbe Anlass-Picker wie
 * {@link BoxLoesenDto.AnfrageDto} - ein Dialog, zwei Handlungen.
 */
public final class BoxAusbauenDto {

    private BoxAusbauenDto() {
    }

    /** {@code POST .../ausbauen}: der Anlass ist Pflicht ({@code anlassText} nur bei "anderer_anlass"). */
    public record AnfrageDto(String anlass, String anlassText) {
    }

    /**
     * {@code bereitsAusgebaut}: dieselbe Antwort bei einer Wiederholung (Idempotenz über
     * {@code box_ausbauen_protokoll}) - kein zweiter Eintrag, keine zweite Box.
     */
    public record ErgebnisDto(String externalRef, String deviceId, Instant ausgebautAm, String anlass,
            boolean bereitsAusgebaut) {
    }
}
