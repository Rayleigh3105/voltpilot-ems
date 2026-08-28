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
         * ⚠ Sie FÜGT NUR HINZU. Ein Eintrag hier lässt eine Säule herein; eine
         * Kennung hier WEGZULASSEN ist kein Löschen - das sagt
         * {@code removedChargePointIds} ausdrücklich. Eine leere Liste ist hier
         * - anders als beim Vorrang - keine Aussage „keine Säule", sondern nur
         * „das Portal hat noch keine eingetragen".
         */
        List<AllowedChargePointDto> chargePoints,
        /*
         * Die ZURÜCKGENOMMENEN Kennungen - die GRABSTEIN-Liste (Captain-Order
         * 24.08.2026).
         *
         * ⚠ Sie reist in JEDEM folgenden Dokument mit, nicht einmal: das
         * retained Dokument wird als Ganzes ersetzt, also hätte eine nur einmal
         * genannte Löschung eine gerade offline gewesene Box nie erreicht. Eine
         * Kennung steht deshalb nie zugleich in {@code chargePoints} - ein
         * erneutes Eintragen belebt sie wieder und nimmt sie hier heraus.
         */
        List<String> removedChargePointIds,
        Instant updatedAt, String updatedBy) {

    /**
     * Eine im Portal eingetragene Ladesäule. Alles außer der Kennung ist das,
     * was der Betreiber zufällig schon weiß - {@code null} heißt „unbekannt",
     * nie 0: die Box entscheidet dann aus dem, was die Säule selbst meldet.
     */
    public record AllowedChargePointDto(String chargePointId, String label, Double ratedKw,
            Integer connectors,
            /*
             * connection = WO diese Saeule haengt (Cockpit Phase 1 / C1):
             * "haus" (hinter dem Hausanschluss) oder "eigen" (eigener
             * Netzanschluss/Zaehler). null = der Kunde hat nichts gesagt, und
             * die Box behaelt, was sie hat - NIE "eigen", denn das naehme eine
             * reale Ladeleistung aus ihrer eigenen Bilanz.
             */
            String connection,
            Instant addedAt, String addedBy) {}
}
