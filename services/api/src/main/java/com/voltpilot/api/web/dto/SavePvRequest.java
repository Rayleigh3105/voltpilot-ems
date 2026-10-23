package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.math.BigDecimal;

/**
 * Die Leistung der Solarmodule, vom Kunden eingetragen (der Weg ohne MaStR-Nummer, Anlage-Flow a1
 * Paket 2: „Was gehört zu Ihrer Anlage?“). Die Grenzen folgen der Spalte {@code asset.pv_capacity_kwp}
 * und der Übernahme eines Erzeugers ({@code capacityKwp} höchstens 100.000).
 */
public record SavePvRequest(
        @NotNull @Positive @DecimalMax("100000") @Digits(integer = 6, fraction = 2) BigDecimal capacityKwp) {
}
