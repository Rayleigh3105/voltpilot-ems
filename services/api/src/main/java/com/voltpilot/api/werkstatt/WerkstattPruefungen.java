package com.voltpilot.api.werkstatt;

import java.util.Collection;
import java.util.List;

/**
 * Die Prüfungen der Werkstatt-Regel als geschlossene Liste - die Kennungen,
 * die eine Abnahme vollständig abgehakt tragen muss. Zwilling des Portals
 * ({@code frontend/portal/src/werkstatt.ts}); beide Tests lesen
 * {@code docs/contracts/werkstatt-pruefungen.json}.
 */
public final class WerkstattPruefungen {

    /** In der Reihenfolge der Regel. */
    public static final List<String> ALLE = List.of(
            "root_passwort",
            "notfall_schluessel",
            "tunnel_status",
            "anmeldeprobe",
            "host_schluessel",
            "fenster_zu",
            "lan_netz",
            "neustart");

    private WerkstattPruefungen() {
    }

    /** Was in {@code abgehakt} fehlt, in der Reihenfolge der Regel. */
    public static List<String> fehlend(Collection<String> abgehakt) {
        return ALLE.stream().filter(p -> !abgehakt.contains(p)).toList();
    }

    /** Kennungen, die es in der Liste nicht gibt. */
    public static List<String> unbekannt(Collection<String> abgehakt) {
        return abgehakt.stream().filter(p -> !ALLE.contains(p)).distinct().sorted().toList();
    }
}
