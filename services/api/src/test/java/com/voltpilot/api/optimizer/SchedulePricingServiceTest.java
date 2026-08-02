package com.voltpilot.api.optimizer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics;
import com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice;
import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * P0 "Textwahrheit" (report vp-netzbezug-nacht-s3 §6): the customer Fahrplan
 * must carry THE PRICE THE OPTIMIZER DECIDED WITH, not only the bare spot the
 * {@code schedule} table persists. These are pure unit tests over the
 * pass-through - the price rules themselves are pinned by
 * {@link SlotEconomicsTest} and must not be re-implemented here.
 */
class SchedulePricingServiceTest {

    private static final UUID SITE = UUID.randomUUID();
    private static final Instant SLOT = Instant.parse("2026-07-30T19:15:00Z");

    /** The live Pilsting shape: Bayernwerk Preisblatt 11,33 ct netto, USt 0. */
    private static SlotEconomics pilstingEconomics() {
        SupplyPrice sheet = new SupplyPrice(11.33, null, null, null, null, 0.0);
        SiteEconomics site = new SiteEconomics("direktvermarktung", false, "ohne", null,
                null, null, null, 0.96, 4.0, sheet);
        return new SlotEconomics(site, EegRates.fromJson(null), Map.of(), false);
    }

    private static ScheduleSlotDto slot(BigDecimal spotEurMwh) {
        return new ScheduleSlotDto(SLOT, new BigDecimal("-4.332"), new BigDecimal("2.8"),
                new BigDecimal("77"), spotEurMwh, null, null, null, null, new BigDecimal("4.33"),
                "eigenverbrauch", List.of(), new BigDecimal("21.5"), null, null,
                null, null, null, null, null, Boolean.TRUE, Boolean.FALSE);
    }

    private static SchedulePricingService serviceReturning(SlotEconomics economics) {
        OptimizerDiagnosticsService diagnostics = mock(OptimizerDiagnosticsService.class);
        when(diagnostics.economicsFor(eq(SITE), any(), any())).thenReturn(economics);
        return new SchedulePricingService(diagnostics);
    }

    private static SchedulePlanDto plan(ScheduleSlotDto... slots) {
        return new SchedulePlanDto(UUID.randomUUID(), UUID.randomUUID(), SLOT, 15,
                BigDecimal.ONE, null, null, null, null, null, List.of(slots));
    }

    @Test
    void slotsCarryTheRealImportPriceNotTheBareSpot() {
        // Spot 21,2 ct - the number the old sentence compared against the
        // stored value 21,5 and therefore contradicted itself with.
        SchedulePlanDto priced =
                serviceReturning(pilstingEconomics()).priced(SITE, plan(slot(new BigDecimal("212"))));

        ScheduleSlotDto s = priced.slots().get(0);
        assertThat(s.importPriceCtKwh().doubleValue()).isCloseTo(32.53, within(0.01));
        assertThat(s.importPriceSource()).isEqualTo("preisblatt");
        // Merchant-side: a DV site without an anzulegender Wert earns bare spot.
        assertThat(s.exportValueCtKwh().doubleValue()).isCloseTo(21.2, within(1e-9));
        // The persisted spot stays untouched - the field is ADDITIVE.
        assertThat(s.priceEurMwh()).isEqualByComparingTo("212");
        // ... and so does everything else the slot carried.
        assertThat(s.batteryKw()).isEqualByComparingTo("-4.332");
        assertThat(s.loadKw()).isEqualByComparingTo("4.33");
        assertThat(s.slotRole()).isEqualTo("eigenverbrauch");
        assertThat(s.storedValueCtKwh()).isEqualByComparingTo("21.5");
        // ... including the Duty-Vorschau, tri-state intact: an explicit false
        // must never arrive as null (that would read as "not evaluated").
        assertThat(s.coverLoadFromBattery()).isTrue();
        assertThat(s.chargeFromSurplusOnly()).isFalse();
        // The decision the portal may now state, contradiction-free.
        assertThat(s.importPriceCtKwh().doubleValue())
                .isGreaterThan(s.storedValueCtKwh().doubleValue());
    }

    @Test
    void aSlotWithoutASpotPriceStaysNullInsteadOfFabricatingOne() {
        SchedulePlanDto priced =
                serviceReturning(pilstingEconomics()).priced(SITE, plan(slot(null)));

        ScheduleSlotDto s = priced.slots().get(0);
        assertThat(s.importPriceCtKwh()).isNull();
        assertThat(s.exportValueCtKwh()).isNull();
        // The SOURCE is a site-level fact and stays honest even then.
        assertThat(s.importPriceSource()).isEqualTo("preisblatt");
    }

    @Test
    void anUnpricedSiteIsLeftExactlyAsItWas() {
        // RLS hides the site (or it has no master data) -> no economics, and the
        // plan comes back untouched rather than half-priced.
        SchedulePlanDto original = plan(slot(new BigDecimal("212")));
        assertThat(serviceReturning(null).priced(SITE, original)).isSameAs(original);
        // An empty / absent plan is never queried for prices at all.
        assertThat(serviceReturning(pilstingEconomics()).priced(SITE, SchedulePlanDto.empty()).slots())
                .isEmpty();
        assertThat(serviceReturning(pilstingEconomics()).priced(SITE, null)).isNull();
    }
}
