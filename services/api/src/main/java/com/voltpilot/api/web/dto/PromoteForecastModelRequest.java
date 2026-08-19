package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * „Kandidat übernehmen": welches Modell ab dem nächsten Planungslauf plant.
 *
 * <p>Bewusst NUR diese zwei Felder - der Schalter kann per Konstruktion nichts
 * anderes umstellen. Insbesondere trägt er KEINE Anlagen-Id: die steht im
 * PFAD, also kann ein Aufrufer nicht eine andere Anlage umstellen als die, die
 * der RLS-Zaun geprüft hat. Die inhaltliche Prüfung (Art bekannt, Modell
 * bekannt, Modell gehört zur Art, kein No-op, und je Anlage die zwei
 * Beleg-Sperren) macht {@code ForecastModelService} mit deutschen Gründen;
 * hier steht nur die Form. Geteilt von der Anlagen- und der Plattform-Route.
 */
public record PromoteForecastModelRequest(
        @NotBlank(message = "Prognoseart fehlt.") String kind,
        @NotBlank(message = "Modell fehlt.") String model) {
}
