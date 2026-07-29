package com.voltpilot.api.profile;

import java.util.Set;

/**
 * The pure AE7 Nutzungsprofil deriver + emphasis map (contract
 * docs/contracts/v2/usage-profile.md; spec adaptive-ems-ui-v1-spec.md §2/§3).
 *
 * <p>The usage profile ({@code arbitrage} | {@code peak} | {@code private}) is
 * the SECOND adaptation axis: it steers the <em>emphasis</em> of the portal/edge
 * (money-/peak-/flow-centric). It is DERIVED from the site's strategy nodes +
 * entity mix + money master data (plant_kind, Leistungspreis) and can be
 * explicitly overridden - ONE truth, not a competing concept.
 *
 * <p>Byte-identical twin of {@code frontend/portal/src/usageProfile.ts}; both
 * are pinned by {@code docs/contracts/v2/usage-profile-vectors.json}. Change the
 * rules on both sides + the vectors together.
 */
public final class UsageProfileDeriver {

    public static final String ARBITRAGE = "arbitrage";
    public static final String PEAK = "peak";
    public static final String PRIVATE = "private";

    /** Strategy node types that mark a peak/grid-contract use (spec §3). */
    public static final String NODE_MARKET = "vp.strategy.market";
    public static final String NODE_PEAKSHAVING = "vp.strategy.peakshaving";
    public static final String NODE_ATYPICAL_GRID = "vp.strategy.atypical-grid";

    private UsageProfileDeriver() {}

    /**
     * The signals gathered per site (see the contract). {@code override} is the
     * explicit {@code site.usage_profile_override} (null = derive).
     */
    public record Signals(boolean hasStorage, boolean hasPv, boolean hasControllableConsumer,
            Set<String> activeStrategyNodeTypes, String plantKind, boolean hasLeistungspreis,
            String override) {

        public Signals {
            activeStrategyNodeTypes =
                    activeStrategyNodeTypes == null ? Set.of() : Set.copyOf(activeStrategyNodeTypes);
        }
    }

    /** Which surfaces a profile makes prominent | secondary | minimal | hidden. */
    public record Emphasis(String money, String peak, String flow, String devices) {}

    /** The derived default profile, ignoring any override. */
    public static String deriveDefault(Signals s) {
        boolean peak = s.hasLeistungspreis()
                || s.activeStrategyNodeTypes().contains(NODE_PEAKSHAVING)
                || s.activeStrategyNodeTypes().contains(NODE_ATYPICAL_GRID);
        if (peak) {
            return PEAK;
        }
        boolean arbitrage = s.activeStrategyNodeTypes().contains(NODE_MARKET)
                || "direktvermarktung".equals(s.plantKind());
        if (arbitrage) {
            return ARBITRAGE;
        }
        return PRIVATE;
    }

    /**
     * The effective profile: a valid SETTABLE override wins, else the derived
     * default. {@code private} is derived-only (a household default), never a
     * settable override, so {@link #isProfile} rejects it and a stored/legacy
     * {@code private} override falls through to {@link #deriveDefault}.
     */
    public static String effectiveProfile(Signals s) {
        return isProfile(s.override()) ? s.override() : deriveDefault(s);
    }

    /** The emphasis map for a profile (the ONE contract AE2/AE3/AE4/AE6 consult). */
    public static Emphasis emphasisFor(String profile) {
        switch (profile == null ? "" : profile) {
            case ARBITRAGE:
                return new Emphasis("prominent", "hidden", "secondary", "secondary");
            case PEAK:
                return new Emphasis("secondary", "prominent", "secondary", "secondary");
            case PRIVATE:
            default:
                return new Emphasis("minimal", "hidden", "prominent", "prominent");
        }
    }

    /**
     * Whether {@code value} is a SETTABLE usage-profile override. {@code private}
     * is deliberately NOT settable (it is the derived household default); only
     * {@code arbitrage} and {@code peak} may be chosen.
     */
    public static boolean isProfile(String value) {
        return ARBITRAGE.equals(value) || PEAK.equals(value);
    }
}
