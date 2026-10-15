package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * "Was lässt sich hier überwachen?" (Alerting Scheibe 2, Konzept §6.3): ein Wertverweis mit
 * Name, Einheit und dem letzten Wert, den der Fragende sehen darf - die Grundlage der Auswahl
 * "+ Überwachung" im Meldungs-Center und der Vorschläge ab Werk.
 */
public record WertverweisDto(String wertart, String name, String satzname, List<String> bedingungen,
        String bezugJson, Boolean bekannt, Double zahlenwert, String zustandswort, String einheit) {

    public record Liste(List<WertverweisDto> werte) {}
}
