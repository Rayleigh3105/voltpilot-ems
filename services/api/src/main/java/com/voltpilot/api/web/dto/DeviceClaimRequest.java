package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * Request body for claiming an edge device into one of the caller's sites.
 * "Onboarding = one insert" (architecture §14.1).
 *
 * <p>{@code externalRef} is capped at the provisioning contract's 64-char ref
 * limit (plus room for surrounding whitespace, which the controller trims); the
 * charset itself is validated post-canonicalization against
 * {@code ProvisioningTopics.isValidRef} in the controller.
 *
 * <p>{@code ersetzt} (Box verbinden S4, "Andere Kennung", Vertrag Abschnitt 3.5): die ID einer Box,
 * die der Assistent zugunsten von {@code externalRef} loslassen soll, in derselben Transaktion -
 * nur, solange sie sich nie gemeldet UND ihren Schlüssel nie abgeholt hat ({@code BoxLoesenRegel},
 * {@code adminWeg = false}). Additiv, {@code null} heißt ein normales Verbinden wie heute.
 */
public record DeviceClaimRequest(
        @NotNull UUID siteId,
        @NotBlank @Size(max = 80) String externalRef,
        String kind,
        UUID ersetzt) {
}
