package com.voltpilot.api.tenant;

/**
 * The U0 Kontotyp/Betriebsart frame (design vp-ems-ui-overhaul §2): the coarse,
 * tenant-level knob that picks the portal's navigation SHELL - {@code endkunde}
 * (single-object cockpit, never fleet chrome) vs {@code betreiber} (fleet /
 * portfolio shell). Everything below the shell stays derived per Standort
 * (AE1 topology + AE7 profile).
 *
 * <p>This class is the ONE authoritative derivation of the EFFECTIVE
 * Betriebsart: the explicit {@code tenant.betriebsart} override wins, and
 * WITHOUT one the frame is deliberately {@code null} = UNKNOWN. It is NOT
 * derived from {@code tenant.segment}: that column defaults to {@code CI} for
 * every admin-console-provisioned tenant, so a segment derivation would have
 * silently flipped every existing single-plant customer from their cockpit to
 * the operator Portfolio shell on the U0 deploy (pre-deploy audit HIGH-1). An
 * unknown frame falls back to the pre-U0 {@code sites.length >= 2} heuristic in
 * the portal ({@code src/betriebsart.ts}), i.e. zero change for existing
 * tenants; the Portfolio shell appears ONLY once an admin explicitly stores
 * {@code betriebsart = 'betreiber'}.
 *
 * <p>Every consumer - the admin tenant DTOs, the customer tenant-context echo,
 * and (via that echo) the portal shell - reads the resolved value from here;
 * the portal never re-derives.
 */
public final class Betriebsart {

    public static final String ENDKUNDE = "endkunde";
    public static final String BETREIBER = "betreiber";

    private Betriebsart() {
    }

    /**
     * The effective Betriebsart: the stored override when set, else
     * {@code null} = unknown frame (the consumer falls back to deriving from
     * scale - the pre-U0 site-count heuristic). {@code segment} is accepted for
     * call-site symmetry and deliberately NOT used (see the class javadoc).
     */
    public static String effective(String betriebsartOverride, String segment) {
        if (ENDKUNDE.equals(betriebsartOverride) || BETREIBER.equals(betriebsartOverride)) {
            return betriebsartOverride;
        }
        return null;
    }
}
