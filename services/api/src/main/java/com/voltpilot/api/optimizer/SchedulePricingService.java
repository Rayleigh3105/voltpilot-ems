package com.voltpilot.api.optimizer;

import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Fills a customer Fahrplan's slots with THE PRICE THE OPTIMIZER DECIDED WITH
 * (P0 "Textwahrheit", report vp-netzbezug-nacht-s3 §6).
 *
 * <p>The {@code schedule} hypertable persists only the bare SPOT price
 * ({@code price_eur_mwh}, domain.py), while the solver's objective runs on the
 * site's REAL import price and export value (pricing.py P1). A customer
 * sentence built on spot therefore contradicts itself in the normal case
 * ("Börsenpreis 21,2 wäre teurer als der Speicherwert 21,5" - while the real
 * grid price was 32,5). This service closes that gap WITHOUT a second price
 * rule: it reuses the existing {@link SlotEconomics} recomposition the admin
 * diagnostics already runs (the pricing.py twin), per slot, and passes the
 * numbers through on the DTO.
 *
 * <p>Honesty discipline: a slot without a persisted spot price stays null
 * (except the flat {@code fest} tariff, which needs none) - the portal then
 * degrades to a number-free sentence rather than labeling spot as "Netzstrom".
 * A site RLS hides (or that has no plan) is returned unchanged.
 */
@Service
public class SchedulePricingService {

    /** ct/kWh scale - one digit more than the portal renders, so no double rounding. */
    private static final int CT_SCALE = 3;

    private final OptimizerDiagnosticsService diagnostics;

    public SchedulePricingService(OptimizerDiagnosticsService diagnostics) {
        this.diagnostics = diagnostics;
    }

    /** The plan with {@code importPriceCtKwh}/{@code exportValueCtKwh}/
     * {@code importPriceSource} filled in; unchanged when not computable. */
    public SchedulePlanDto priced(UUID siteId, SchedulePlanDto plan) {
        if (plan == null || plan.slots() == null || plan.slots().isEmpty()) {
            return plan;
        }
        List<ScheduleSlotDto> slots = plan.slots();
        SlotEconomics economics = diagnostics.economicsFor(
                siteId, slots.get(0).start(), slots.get(slots.size() - 1).start());
        if (economics == null) {
            return plan;
        }
        String source = economics.importPriceSource();
        List<ScheduleSlotDto> priced = new ArrayList<>(slots.size());
        for (ScheduleSlotDto slot : slots) {
            Double spot = slot.priceEurMwh() == null ? null : slot.priceEurMwh().doubleValue();
            priced.add(slot.withPrices(
                    ct(economics.importPriceCtKwh(spot)),
                    ct(economics.exportValueCtKwh(spot, slot.start())),
                    source));
        }
        return new SchedulePlanDto(plan.planId(), plan.deviceId(), plan.generatedAt(),
                plan.slotMinutes(), plan.savingsEur(), plan.bankedValueEur(), plan.socStartPct(),
                plan.socEndPct(), plan.peakTargetKw(), plan.fallback14a(), priced);
    }

    private static BigDecimal ct(Double value) {
        return value == null ? null
                : BigDecimal.valueOf(value).setScale(CT_SCALE, RoundingMode.HALF_UP);
    }
}
