package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.time.Instant;
import java.util.UUID;

/** Standortwechsel: kein Mandant im Rumpf, keine neue Claim-Referenz. */
public record MoveDeviceRequest(
        @NotNull UUID targetSiteId,
        @Positive int expectedRevision,
        @NotNull Instant effectiveAt) {}
