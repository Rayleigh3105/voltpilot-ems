package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Der Zustand des Prognose-Schalters (Captain-Auftrag 18.08.2026): welches
 * Modell je Prognoseart gerade plant, WOHER diese Wahl kommt, und die
 * append-only Umstellungs-Historie.
 *
 * <p>Alles hier ist PLATTFORM-weit, nicht anlagenbezogen - genau die Semantik
 * der abgelösten Umgebungsvariablen. Die Fläche muss das aussprechen, sonst
 * liest sich ein Klick auf einer Anlagen-Seite wie eine Entscheidung für DIESE
 * Anlage.
 */
public record ForecastModelChoiceDto(List<KindChoiceDto> kinds, List<ChoiceEventDto> history) {

    /** Eine Prognoseart und ihr aktives Modell. */
    public record KindChoiceDto(
            /** 'load' | 'pv'. */
            String kind,
            /** Die Modell-Id, die der Optimierer konsumiert. */
            String activeModel,
            /**
             * Woher sie kommt: {@code portal} (eine Zeile in
             * {@code forecast_model_choice}) oder {@code env} (die
             * Umgebungsvariable bzw. der Registry-Default). Der Unterschied ist
             * die Aussage „das hat jemand entschieden" vs. „so ist es
             * ausgeliefert" - er darf nicht geraten werden.
             */
            String source,
            /** Der Vorgabewert der Umgebung - was ohne Portal-Wahl gälte. */
            String envDefault,
            /** Anzeige-Name des Umstellers; {@code null} = nicht im Token. */
            String setByName,
            /** Wann umgestellt wurde; {@code null} = nie (Quelle {@code env}). */
            Instant setAt,
            /** Alle Modelle dieser Art - die wählbare Menge des Schalters. */
            List<String> selectable) {
    }

    /** Eine Umstellung: von -> zu, wer, wann (eine Zeile des Journals). */
    public record ChoiceEventDto(
            String kind,
            String model,
            /** {@code null} = die erste Umstellung dieser Art. */
            String previousModel,
            String setByName,
            Instant setAt) {
    }
}
