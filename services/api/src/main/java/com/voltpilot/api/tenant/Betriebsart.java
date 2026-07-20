package com.voltpilot.api.tenant;

/**
 * The U0 Kontotyp/Betriebsart frame (design vp-ems-ui-overhaul §2): the coarse,
 * tenant-level knob that picks the portal's navigation SHELL - {@code endkunde}
 * (single-object cockpit, never fleet chrome) vs {@code betreiber} (fleet /
 * portfolio shell). Everything below the shell stays derived per Standort
 * (AE1 topology + AE7 profile).
 *
 * <p>This class is the ONE authoritative derivation of the EFFECTIVE
 * Betriebsart: the explicit {@code tenant.betriebsart} override wins; without
 * one it derives from the existing {@code tenant.segment} ({@code B2C} ->
 * endkunde, {@code CI} -> betreiber). Every consumer - the admin tenant DTOs,
 * the customer tenant-context echo, and (via that echo) the portal shell -
 * reads the resolved value from here; the portal never re-derives.
 */
public final class Betriebsart {

    public static final String ENDKUNDE = "endkunde";
    public static final String BETREIBER = "betreiber";

    private Betriebsart() {
    }

    /**
     * The effective Betriebsart: the stored override when set, else the
     * segment-derived default. {@code B2C} (self-registered households) ->
     * {@code endkunde}; anything else (the {@code CI} commercial segment -
     * the only other value the segment CHECK allows) -> {@code betreiber}.
     */
    public static String effective(String betriebsartOverride, String segment) {
        if (ENDKUNDE.equals(betriebsartOverride) || BETREIBER.equals(betriebsartOverride)) {
            return betriebsartOverride;
        }
        return "B2C".equals(segment) ? ENDKUNDE : BETREIBER;
    }
}
