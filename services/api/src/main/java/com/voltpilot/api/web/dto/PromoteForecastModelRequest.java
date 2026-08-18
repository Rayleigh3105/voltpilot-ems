package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * „Kandidat übernehmen": welches Modell ab dem nächsten Planungslauf plant.
 *
 * <p>Bewusst NUR diese zwei Felder - der Schalter kann per Konstruktion nichts
 * anderes umstellen. Die inhaltliche Prüfung (Art bekannt, Modell bekannt,
 * Modell gehört zur Art, kein No-op) macht {@code ForecastModelService} mit
 * deutschen Gründen; hier steht nur die Form.
 */
public record PromoteForecastModelRequest(
        @NotBlank(message = "Prognoseart fehlt.") String kind,
        @NotBlank(message = "Modell fehlt.") String model) {
}
