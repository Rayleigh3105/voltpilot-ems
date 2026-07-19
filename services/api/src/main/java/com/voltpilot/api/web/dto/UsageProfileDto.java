package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * The AE7 Nutzungsprofil read-model (contract docs/contracts/v2/usage-profile.md):
 * the EFFECTIVE profile ({@code arbitrage} | {@code peak} | {@code private}), the
 * derived default (ignoring any override), the raw override, the emphasis map
 * (which surfaces AE2/AE3/AE4/AE6 make prominent), and the signals it was
 * derived from (for transparency in the portal/admin).
 */
public record UsageProfileDto(String usageProfile, String derivedProfile, String override,
        Emphasis emphasis, Signals signals) {

    /** prominent | secondary | minimal | hidden per surface. */
    public record Emphasis(String money, String peak, String flow, String devices) {}

    public record Signals(boolean hasStorage, boolean hasPv, boolean hasControllableConsumer,
            List<String> activeStrategyNodeTypes, String plantKind, boolean hasLeistungspreis) {}
}
