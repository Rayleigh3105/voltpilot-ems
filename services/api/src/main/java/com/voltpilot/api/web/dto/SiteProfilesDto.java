package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * The Modus-Profile shelf of one Anlage (Portal v3 M3, {@code GET/PUT
 * /api/v1/sites/{id}/profiles}).
 *
 * <p>Every profile is a DIRECT customer toggle - there are exactly two states,
 * {@code an} and {@code aus}, and no "angefragt" anywhere in the UI, the API or
 * the DB (owner decision, M3-profile.md). {@code state} is the STORED intent
 * (null = no row = derived default); {@code derivedActive} is what the
 * derivation says on its own, so the shelf can show both without ever storing
 * the derived value.
 *
 * <p>{@code blockedReason} is the honest German sentence for a profile that is
 * switched ON but cannot fully run yet (no Leistungspreis, no market access) -
 * <b>never</b> a request prompt.
 */
public record SiteProfilesDto(List<Profile> profiles) {

    /**
     * One shelf card.
     *
     * @param id            the profile id (the portal's M0 mode kind)
     * @param label         the customer-facing German name
     * @param state         the stored intent {@code an} | {@code aus}, or null
     * @param derivedActive whether the derivation alone would activate it
     * @param active        the EFFECTIVE state after the intent overlay
     * @param unlocks       what switching it on adds to the surface
     * @param requirements  the honest ✓ / fehlt chips
     * @param blockedReason why it cannot fully run yet, or null
     * @param origin        {@code masterdata} | {@code flow} | null
     * @param flowRef       the flow carrying its strategy, or null
     * @param gatedNodeTypes the node types the toggle opens (may be empty)
     * @param gatedNodesEnabled whether those types are enabled for the site
     */
    public record Profile(String id, String label, String state, boolean derivedActive,
            boolean active, Unlocks unlocks, List<Requirement> requirements, String blockedReason,
            String origin, FlowRef flowRef, List<String> gatedNodeTypes,
            boolean gatedNodesEnabled) {}

    /** What a profile contributes to the surface (views · widgets · money). */
    public record Unlocks(List<String> views, List<String> widgets, String moneyStream) {}

    /** One prerequisite chip. */
    public record Requirement(String label, boolean met) {}

    /** The flow that carries this profile's strategy, when there is one. */
    public record FlowRef(String flowId, String name) {}
}
