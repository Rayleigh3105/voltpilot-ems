package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * The Modus-Profile shelf of one Anlage (Portal v3 M3, {@code GET/PUT
 * /api/v1/sites/{id}/profiles}).
 *
 * <p><b>ZWEI Listen, und sie sind eine Teilung, keine zweite Wahrheit</b>
 * (Steuerung Stufe 0 „Entwirrung"): {@code profiles} ist das REGAL — seit
 * Stufe 0 genau die vier BETRIEBSMODELLE, server-seitig gefiltert über das
 * Katalog-Feld {@code regal}; {@code weitere} sind die sichtbaren
 * Anwendungen, die NICHT im Regal stehen (Basis- und Regel-Anwendungen).
 *
 * <p>Sie mussten mitreisen, weil zwei bestehende Flächen sie LESEN und ein
 * blosses Weglassen dort eine stille Regression wäre: das Cockpit-Tor „ist
 * Eigene Auswertung an?" (Anwendungs-Programm Stufe 5) und das
 * Willens-Overlay der M0-Projektion, das ein gespeichertes {@code aus} sonst
 * verlöre und einen abgeschalteten Modus wiederbelebte. Stufe 0 blendet aus,
 * sie löscht nicht — deshalb wird jeder Zustand weiter beantwortet.
 *
 * <p>Ein ÄLTERES Portal liest nur {@code profiles} und sieht damit genau das
 * Regal; das Feld ist additiv.
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
public record SiteProfilesDto(List<Profile> profiles, List<Profile> weitere) {

    /**
     * Die Antwort einer Anlage, deren Regal LEER ist — sie sagt über nichts
     * etwas aus.
     */
    public static SiteProfilesDto leer() {
        return new SiteProfilesDto(List.of(), List.of());
    }

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
