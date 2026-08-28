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
            int connectorCount,
            // --- Stufe 4: die QUELLEN-Bahn (PV-Überschussladen) ---
            //
            // Sie ist die WIRTSCHAFTLICHE Wahl des Kunden und kann nur
            // VERENGEN, was der Anschluss ohnehin erlaubt. Beide Zahlen reisen,
            // damit eine Fläche sie ZUSAMMEN zeigen kann: eine Drosselung an
            // einem freien Anschluss läse sich sonst wie ein Defekt.
            String surplusPolicy, String storagePriority, boolean surplusActive,
            Double surplusKw, String surplusMode, String surplusNote, boolean surplusBlind,
            Double surplusTotalKw, Double surplusBatteryKw, Double sourceAllocatedKw,
            // --- Wo eine Saeule die Box anwaehlt ------------------------------
            //
            // Port und Pfad des OCPP-Servers. Die Adresse selbst kennt das
            // Portal seit D5 aus der Geraete-Zeile; diese zwei fehlten, also
            // musste der Anbinde-Assistent eine Vorgabe hinschreiben statt den
            // echten Endpunkt zu zeigen.
            //
            // ⚠ DREIWERTIG: null heisst "eine aeltere Box meldet es nicht" ODER
            // "der Server lauscht gerade nicht" - nie Port 0. Die Flaeche faellt
            // dann auf ihren ehrlichen Vorgabe-Satz zurueck.
            Integer ocppPort, String ocppUrlPath,
            Instant reportedAt) {}

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
            String readbackNote, Instant sessionSince,
            /*
             * sessionKwh = die Bilanz DIESES Ladevorgangs (Cockpit Phase 1 /
             * E2). energyKwh daneben ist ein KUMULATIVES Register - was in der
             * laufenden Sitzung geflossen ist, weiss nur die Box, weil nur sie
             * den Registerstand bei StartTransaction kennt. null = kein
             * Ladevorgang / kein Register / ein rueckwaerts gesprungenes
             * Register, nie eine erfundene 0.
             *
             * meteredAt = wann die Saeule zuletzt MeterValues gemeldet hat, also
             * das ALTER von powerKw/energyKwh/socPct. Ohne es kann keine Flaeche
             * ein stehengebliebenes Kilowatt von einem lebenden unterscheiden;
             * null = nie gemessen bzw. ein aelterer Edge-Stand, und dann darf
             * eine Flaeche die Werte NICHT als aktuell ausgeben.
             */
            Double sessionKwh, Instant meteredAt,
            /*
             * boost = an diesem Stecker läuft „Jetzt voll laden". Der Wert kam
             * damit OHNE die Quellen-Bahn zustande und darf Netzstrom
             * enthalten; die Fläche SAGT das - eine volle Ladung, die niemand
             * angefordert hat, wäre ein stiller Bruch der eigenen Priorität
             * des Kunden.
             */
            boolean boost) {}
}
