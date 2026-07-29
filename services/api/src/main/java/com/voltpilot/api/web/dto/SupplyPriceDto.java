package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;

/**
 * One Anlage's structured supply-price sheet (the {@code site_supply_price}
 * row, report vp-nacht-bezug-e7 §3.1) as the portal-maintenance surface reads
 * it - the operator's Preisblatt components in ct/kWh NETTO, all nullable
 * (null = unknown, contributes nothing to the composition).
 *
 * <p>{@code present} says whether a row exists at all (false = the site has
 * never had a sheet, so the portal prefills the researched suggestions);
 * {@code hasComponents} is the load-bearing activation gate - true when at
 * least one component is maintained, i.e. when the optimizer prices import as
 * {@code (spot + Σ Komponenten) × (1+USt)} instead of bare spot (mirrors
 * {@link com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice#hasComponents}).
 * A row with only {@code ustPct}/{@code komponentenStand} maintained still has
 * {@code hasComponents == false} - it behaves exactly like no row.
 */
public record SupplyPriceDto(
        boolean present,
        boolean hasComponents,
        BigDecimal netzentgeltArbeitspreisCt,
        BigDecimal stromsteuerCt,
        BigDecimal konzessionsabgabeCt,
        BigDecimal umlagenCt,
        BigDecimal vertriebsaufschlagCt,
        BigDecimal ustPct,
        LocalDate komponentenStand,
        Instant updatedAt) {

    /** The empty sheet a site without a row reports (portal prefills suggestions). */
    public static SupplyPriceDto empty() {
        return new SupplyPriceDto(false, false, null, null, null, null, null,
                null, null, null);
    }
}
