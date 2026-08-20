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
        Instant updatedAt, String updatedBy) {}
