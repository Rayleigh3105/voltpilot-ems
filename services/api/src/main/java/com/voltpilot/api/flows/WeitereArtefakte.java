package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.UUID;

/**
 * Eine weitere Quelle von Edge-Artefakten für den vollständigen Satz einer Anlage auf {@code …/v2/flows} neben den
 * aktiven Flow-Versionen - heute die mitlaufenden Steuerlogiken ({@code steuerlogik/SteuerlogikAuslieferung}). Der
 * Satz bleibt vollständiger Sollbestand: jede Veröffentlichung fragt alle Quellen.
 */
public interface WeitereArtefakte {

    /** Die Artefakte dieser Quelle für die führende Box {@code gateway} der Anlage; leer, wenn keine. */
    List<JsonNode> artefakte(UUID siteId, UUID gateway);
}
