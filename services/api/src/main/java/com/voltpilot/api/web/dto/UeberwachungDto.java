package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;

/**
 * Eine Regel im Reiter "Überwachungen" (Alerting Scheibe 1+2, Konzept §6.8 "Überwachungen ist eine
 * Liste von Sätzen mit Zustand, Empfängern und letzter Meldung"). Scheibe 1 zeigte sie nur lesend;
 * Scheibe 2 fügt {@link Anlegen} hinzu - "Vom Wert zur fertigen Regel: drei Taps" (§6.8) - und den
 * 30-Tage-Probelauf: {@code probelaufBis} ist {@code null}, sobald die Regel scharf ist (ab Werk
 * gesäte Regeln kennen keinen Probelauf; eine eigene endet damit nach 30 Tagen oder per Tipper).
 */
public record UeberwachungDto(String id, String name, String wertart, String schwere, String herkunft,
        boolean aktiv, Instant probelaufBis) {

    public record Liste(List<UeberwachungDto> ueberwachungen) {}

    /** Der Bezug im Anfragekörper - {@code anlage} ODER {@code komponente}+{@code kanal} (§6.3). */
    public record BezugEintrag(String anlage, String komponente, String kanal) {}

    /** {@code person} ODER {@code rolle} (§6.4 "Mehrere Empfänger") - nie beide. */
    public record EmpfaengerEintrag(String person, String rolle) {}

    /**
     * Eine eigene Überwachung anlegen (§6.8). {@code bedingung} bleibt roh (ihre Form hängt von der
     * Bedingungsart ab, §6.4); ohne {@code empfaenger} gilt "nur ich selbst" (die anlegende Person).
     */
    public record Anlegen(String wertart, BezugEintrag bezug, JsonNode bedingung, String schwere,
            List<EmpfaengerEintrag> empfaenger, String name) {}
}
