package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonRawValue;
import java.time.Instant;

/**
 * Eine PRIVATE Geräte-Vorlage einer Anlage (Einheitsmodell Stufe 3,
 * „Duplizieren" - Konzept vp-modbus-baukasten-k6 Captain-Scope 4).
 *
 * <p>Sie ist bewusst NICHT {@code ComponentTemplateDto}: jene beschreibt ein
 * PRODUKT (global, geprüft oder eingebaut), diese die Kopie EINER
 * Kundendefinition. Zwei Fragen, zwei Formen - und die hier trägt ihre Kanäle
 * als PFLICHT, weil die Kanal-Liste die Vorlage IST.
 *
 * <p>{@code connection} und {@code channels} reisen als rohes JSON: sie sind
 * genau die Bytes, die der Assistent beim Duplizieren wieder einsetzt.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SiteComponentTemplateDto(
        String templateRef,
        int version,
        String label,
        String communication,
        @JsonRawValue String connection,
        @JsonRawValue String channels,
        String note,
        Instant createdAt) {
}
