package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * Eine Regel im Reiter "Überwachungen" (Alerting Scheibe 1, Konzept §6.8 "Überwachungen ist eine
 * Liste von Sätzen mit Zustand, Empfängern und letzter Meldung"). Scheibe 1 zeigt sie nur lesend -
 * eine eigene Regel am Wert bauen ist Scheibe 2 ("Ausdrücklich NICHT" in dieser Scheibe, §7).
 */
public record UeberwachungDto(String id, String name, String wertart, String schwere, String herkunft,
        boolean aktiv) {

    public record Liste(List<UeberwachungDto> ueberwachungen) {}
}
