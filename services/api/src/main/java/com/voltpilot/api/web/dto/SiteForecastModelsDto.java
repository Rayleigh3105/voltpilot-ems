package com.voltpilot.api.web.dto;

import com.voltpilot.api.web.dto.ForecastModelChoiceDto.ChoiceEventDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Der Zustand des Prognose-Schalters EINER ANLAGE (Captain-Auftrag 19.08.2026):
 * welches Modell je Prognoseart DIESE Anlage plant, WOHER diese Wahl kommt, und
 * ihre append-only Umstellungs-Historie.
 *
 * <p>Alles hier ist ANLAGENBEZOGEN - das ist der Unterschied zum
 * plattformweiten {@link ForecastModelChoiceDto}, das die VORGABE für Anlagen
 * ohne eigene Wahl trägt. Die Fläche muss beides auseinanderhalten können,
 * sonst liest sich eine Plattform-Vorgabe wie eine Entscheidung für diese
 * Anlage (und umgekehrt) - dafür ist {@link KindChoiceDto#source} da.
 */
public record SiteForecastModelsDto(
        UUID siteId, List<KindChoiceDto> kinds, List<ChoiceEventDto> history) {

    /** Eine Prognoseart und das Modell, das DIESE Anlage damit plant. */
    public record KindChoiceDto(
            /** 'load' | 'pv'. */
            String kind,
            /** Die Modell-Id, die der Optimierer für diese Anlage konsumiert. */
            String activeModel,
            /**
             * Woher sie kommt - die drei Herkünfte der Präzedenz:
             * {@code anlage} (eine Zeile in {@code site_forecast_model_choice}
             * - jemand hat das für DIESE Anlage entschieden), {@code plattform}
             * (die Plattform-Vorgabe aus {@code forecast_model_choice}) oder
             * {@code env} (die Umgebungsvariable bzw. der Registry-Default, also
             * das ausgelieferte Standardmodell). Der Unterschied ist die Aussage
             * „das hat jemand für diese Anlage entschieden" vs. „so ist es
             * vorgegeben" - er darf nicht geraten werden.
             */
            String source,
            /** Was ohne eigene Wahl DIESER Anlage gälte (Plattform bzw. Env). */
            String platformDefault,
            /** Der Vorgabewert der Umgebung - was ohne jede Portal-Wahl gälte. */
            String envDefault,
            /** Anzeige-Name des Umstellers; {@code null} = nicht im Token. */
            String setByName,
            /** Wann für diese Anlage umgestellt wurde; {@code null} = nie. */
            Instant setAt,
            /** Alle Modelle dieser Art - die wählbare Menge des Schalters. */
            List<String> selectable) {
    }
}
