package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Die Ladepunkt-Sicht EINER Anlage (Lastmanagement Stufe 3): das Budget, das
 * sich alle Säulen teilen, und je Säule ihre Stecker.
 *
 * <p>⚠ Jede Zahl und jeder deutsche Satz hierin stammt aus der BOX
 * ({@code internal/lastmgmt}) und wird nur weitergereicht. Zwei Renderings
 * desselben Urteils könnten es sonst verschieden sagen, und nur die Box kennt
 * die Zahlen dahinter - dieselbe Regel wie beim Einspeise-Wächter.
 *
 * <p>{@code budget == null} und eine leere Säulenliste sind der ehrliche
 * Zustand einer Anlage ohne Ladesäulen (oder mit einer älteren Box, die den
 * Block noch nicht sendet) - nie ein Budget von 0.
 */
public record SiteChargingDto(ChargingBudgetDto budget, List<ChargePointDto> chargers) {

    /**
     * Das Standort-Budget. Alle {@code *Kw}-Felder sind NULLABLE: kein Messwert
     * ist NIE eine 0 (die drop-don't-fabricate-Regel des Hauses).
     */
    public record ChargingBudgetDto(UUID deviceId, boolean enabled, boolean controlEnabled,
            String controlNote, Double gridLimitKw, Double marginPct, Double minPowerKw,
            Double budgetKw, Double allocatedKw, Double reservedKw, Double measuredKw,
            Double siteLoadKw, Double siteGridKw, String budgetMode, String budgetNote,
            boolean budgetBlind, Double effLimitKw, Double safeDefaultKw, String safeDefaultNote,
            Boolean safeDefaultHolds, Double safeWorstCaseKw, Double maxHouseLoadKw,
            int connectorCount, Instant reportedAt) {}

    /**
     * Eine Ladesäule. {@code entityId} ist die Komponente, die die Plattform für
     * sie komponiert hat (null = noch keine); Hersteller/Modell/Firmware sind
     * SELBSTAUSKUNFT der Station und ausschließlich zur Anzeige da.
     */
    public record ChargePointDto(UUID deviceId, String chargePointId, String label,
            boolean priority, boolean connected, String vendor, String model, String firmware,
            boolean ready, String note, Instant lastSeen, UUID entityId, Instant reportedAt,
            List<ChargeConnectorDto> connectors) {}

    /** Ein Stecker: ein Fahrzeug, ein Anspruch auf das Budget. */
    public record ChargeConnectorDto(int connectorId, String status, boolean charging,
            Double allocatedKw, String reason, String reasonText, Instant nextTurn, Double powerKw,
            Double energyKwh, Double socPct, String commandStatus, String readback,
            String readbackNote, Instant sessionSince) {}
}
