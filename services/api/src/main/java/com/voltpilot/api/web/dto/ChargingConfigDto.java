package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Die im Portal gepflegte Lastmanagement-Konfiguration einer Anlage
 * (Lastmanagement Stufe 3).
 *
 * <p>{@code gridLimitKw == null} heißt „noch nicht gepflegt" - und dann ist das
 * Budget der Box 0 und es lädt nichts. Das ist der ehrliche Zustand einer
 * Anlage, die niemand eingerichtet hat, nie eine erfundene Grenze.
 */
public record ChargingConfigDto(Double gridLimitKw, List<String> priorityChargePointIds,
        /*
         * Die QUELLEN-Wahl des Kunden (Stufe 4): woher der Ladestrom kommen
         * soll. Sie ändert KEINE Grenze - die zwei Bahnen komponieren
         * most-restrictive-wins, und keine kann die andere aufweichen.
         *
         * ⚠ null = der Kunde hat nichts gewählt und die Box behält ihre eigene
         * Einstellung. Es heißt NIE „schnell": das wäre eine eigene Aussage.
         */
        String surplusPolicy, String storagePriority,
        /*
         * Die ALLOWLIST: die Kennungen, unter denen die Box eine Säule
         * überhaupt annimmt.
         *
         * ⚠ Sie FÜGT NUR HINZU. Ein Eintrag hier lässt eine Säule herein; einen
         * zu ENTFERNEN wirft sie beim nächsten Verbindungsaufbau vom Broker und
         * bleibt deshalb bewusst eine ausdrückliche Handlung am Gerät. Eine
         * leere Liste ist hier - anders als beim Vorrang - keine Aussage
         * „keine Säule", sondern nur „das Portal hat noch keine eingetragen".
         */
        List<AllowedChargePointDto> chargePoints,
        Instant updatedAt, String updatedBy) {

    /**
     * Eine im Portal eingetragene Ladesäule. Alles außer der Kennung ist das,
     * was der Betreiber zufällig schon weiß - {@code null} heißt „unbekannt",
     * nie 0: die Box entscheidet dann aus dem, was die Säule selbst meldet.
     */
    public record AllowedChargePointDto(String chargePointId, String label, Double ratedKw,
            Integer connectors, Instant addedAt, String addedBy) {}
}
