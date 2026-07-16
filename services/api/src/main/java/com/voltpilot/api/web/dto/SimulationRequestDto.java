package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * The Ersparnis-Simulation request (design report §6). For the CUSTOMER route
 * every field is an optional what-if OVERRIDE - absent fields come from the
 * site's master data; for the ADMIN/prospect route plant + consumption +
 * battery must be given (the simulation service validates and answers with
 * customer-facing German messages the api relays).
 *
 * <p>The Speicherschonung preset is mapped onto the wear ct/kWh server-side
 * via the ONE constant ({@code web/Speicherschonung}) - no raw wear input.
 */
public record SimulationRequestDto(
        Integer year,
        String zone,
        Plant plant,
        Consumption consumption,
        Tariff tariff,
        Battery battery,
        List<BigDecimal> sizeSweep) {

    public record Plant(
            BigDecimal pvKwp,
            BigDecimal latitude,
            BigDecimal longitude,
            BigDecimal azimuthDeg,
            BigDecimal tiltDeg) {
    }

    public record Consumption(BigDecimal annualKwh, String profile) {
    }

    public record Tariff(
            String plantKind,
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            BigDecimal anzulegenderWertCtKwh,
            LocalDate commissionedOn,
            Boolean netzladenErlaubt) {
    }

    public record Battery(
            BigDecimal capacityKwh,
            BigDecimal maxChargeKw,
            BigDecimal maxDischargeKw,
            BigDecimal roundtripEfficiencyPct,
            String speicherschonung) {
    }
}
