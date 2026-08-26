package com.voltpilot.api.measurement;

import java.util.LinkedHashSet;
import java.util.Set;

/** Maps binding-family names from builtin.json to canonical catalog families. */
public final class MeasurementCatalogFamilies {

    private MeasurementCatalogFamilies() {}

    public static Set<String> expand(Set<String> configured, Set<String> catalogFamilies) {
        Set<String> result = new LinkedHashSet<>();
        for (String family : configured) {
            if (family == null) continue;
            if (family.equals("sunspec") || family.equals("sunspec_live")) {
                catalogFamilies.stream().filter(f -> f.startsWith("sunspec.model_"))
                        .forEach(result::add);
            } else if (family.equals("goe_http_api")) {
                result.add("goe.api_v2");
            } else if (family.equals("shelly_http")) {
                catalogFamilies.stream().filter(f -> f.startsWith("shelly."))
                        .forEach(result::add);
            } else if (family.startsWith("ocpp")) {
                result.add("ocpp.1_6");
            } else {
                result.add(family);
            }
        }
        result.retainAll(catalogFamilies);
        return Set.copyOf(result);
    }
}
