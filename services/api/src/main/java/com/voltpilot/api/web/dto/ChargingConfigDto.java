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
        Instant updatedAt, String updatedBy) {}
