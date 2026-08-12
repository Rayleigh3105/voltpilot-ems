package com.voltpilot.api.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

/**
 * Was „Jetzt lesen" fragt (Einheitsmodell Stufe 3): lies GENAU DIESEN einen
 * Kanal an DIESEM Gerät, einmal.
 *
 * <p>Der Kanal reist in derselben Form wie beim Speichern - dieselben Felder,
 * dieselben Regeln, dieselbe Ableitung. Eine zweite Form für die Vorschau
 * hieße, dass Vorschau und gespeichertes Soll verschiedene Dinge lesen könnten.
 *
 * @param deviceId optional - die Box, die fragen soll. Leer heißt „die einzige
 *     Box dieser Anlage"; eine Anlage mit mehreren muss eine nennen (der
 *     Probe-Kanal rät nie, welche Box auf dem richtigen Netz-Segment sitzt).
 */
public record SelfBuildReadRequest(
        UUID deviceId,
        @NotNull @Valid SaveSelfBuildRequest.Connection connection,
        @NotNull @Valid SaveSelfBuildRequest.ChannelRequest channel) {
}
