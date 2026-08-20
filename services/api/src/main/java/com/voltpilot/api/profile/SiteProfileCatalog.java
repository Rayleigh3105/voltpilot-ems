package com.voltpilot.api.profile;

import com.voltpilot.api.flows.FlowCatalog;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The Modus-Profile shelf catalog (Portal v3 M3): which profiles exist, which
 * strategy node type each one is built on, and which AE7 starter template it
 * seeds.
 *
 * <p><b>The gated node types of a profile are DERIVED from the flow catalog,
 * never hand-kept</b> (M3-profile.md gotcha): a profile opens exactly the node
 * types ITS strategy is made of, and only those that the catalog actually marks
 * {@code gated}. A blanket "enable every gated node for this site" would hand a
 * customer the atypical-grid strategy (whose economics are not built) as a side
 * effect of switching Marktoptimierung on.
 *
 * <p>The profile ids are the portal's M0 mode kinds ({@code surface.ts}), so the
 * shelf, the nav groups and the cockpit all speak one vocabulary.
 */
public final class SiteProfileCatalog {

    public static final String MARKTVERMARKTUNG = "marktvermarktung";
    public static final String LASTSPITZENKAPPUNG = "lastspitzenkappung";
    public static final String ATYPISCHE_NETZNUTZUNG = "atypische-netznutzung";
    /**
     * Das Ladepark-Profil (Lastmanagement Stufe 3, Konzept §5.2). Es hat
     * bewusst KEINEN Strategie-Knoten: Lastmanagement ist SCHUTZ, keine
     * Marktteilnahme - es gibt also nichts freizuschalten und nichts zu säen,
     * und {@link #gatedNodeTypes} liefert für dieses Profil leer.
     */
    public static final String LASTMANAGEMENT = "lastmanagement";

    /**
     * One shelf profile.
     *
     * @param id             the M0 mode kind (the portal's vocabulary)
     * @param label          the customer-facing German name
     * @param strategyType   the {@code vp.strategy.*} node its flows are built
     *                       on, or null for a profile that has no strategy node
     *                       at all (Lastmanagement: protection, not trading)
     * @param usageProfile   the AE7 profile whose starter template it seeds, or
     *                       null when no starter flow exists for it
     */
    public record Profile(String id, String label, String strategyType, String usageProfile) {}

    private static final List<Profile> PROFILES = List.of(
            new Profile(MARKTVERMARKTUNG, "Marktoptimierung", UsageProfileDeriver.NODE_MARKET,
                    UsageProfileDeriver.ARBITRAGE),
            new Profile(LASTSPITZENKAPPUNG, "Lastspitzenkappung",
                    UsageProfileDeriver.NODE_PEAKSHAVING, UsageProfileDeriver.PEAK),
            // No starter template: the atypical-grid economics (E5b) are not
            // built, so nothing is seeded and nothing is claimed. The node type
            // is still openable, so a customer may build with it in the editor.
            new Profile(ATYPISCHE_NETZNUTZUNG, "Atypische Netznutzung",
                    UsageProfileDeriver.NODE_ATYPICAL_GRID, null),
            // Kein Strategie-Knoten und kein Starter: der Verteiler läuft auf
            // der BOX und schützt den Anschluss, sobald eine Säule da ist. Das
            // Regal-Profil ist der An/Aus-Ort des MODUS (die Fläche), nie sein
            // Wirk-Mechanismus - genau deshalb kann es hier nichts freischalten.
            new Profile(LASTMANAGEMENT, "Ladepark-Lastmanagement", null, null));

    private SiteProfileCatalog() {}

    /** The shelf, in its canonical order. */
    public static List<Profile> profiles() {
        return PROFILES;
    }

    /** The profile with this id, or null. */
    public static Profile find(String id) {
        for (Profile p : PROFILES) {
            if (p.id().equals(id)) {
                return p;
            }
        }
        return null;
    }

    /**
     * The gated node types this profile opens - catalog-derived: its own
     * strategy node, kept only when the catalog marks it gated. A profile whose
     * strategy node is not gated opens nothing at all.
     */
    public static Set<String> gatedNodeTypes(Profile profile, FlowCatalog catalog) {
        Set<String> types = new LinkedHashSet<>();
        if (profile != null && profile.strategyType() != null
                && catalog.isGated(profile.strategyType())) {
            types.add(profile.strategyType());
        }
        return types;
    }
}
