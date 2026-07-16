package com.voltpilot.api.optimizer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.voltpilot.api.optimizer.SlotEconomics.MarketValue;
import com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The per-slot decomposition math, pinned against the pricing.py rules it
 * mirrors: tariff branching on import, Marktprämie incl. §51 suspension and
 * merchant-mode guard on export, feste Vergütung incl. §51a, persisted-wear
 * rate derivation, the forward best-use stored-energy approximation, the
 * chargeKind-twin decision label and the null-vs-zero discipline.
 */
class SlotEconomicsTest {

    // A slot squarely inside June 2026 (Berlin month 2026-06-01).
    private static final Instant SLOT = Instant.parse("2026-06-15T12:00:00Z");
    private static final LocalDate JUNE = LocalDate.of(2026, 6, 1);

    private static SiteEconomics site(String plantKind, boolean netzladen, String tarifArt,
            Double param, Double aw, LocalDate commissioned, Double kwp) {
        return new SiteEconomics(plantKind, netzladen, tarifArt, param, aw,
                commissioned, kwp, 0.92, 4.0);
    }

    private static SlotEconomics dv(Double aw, Map<LocalDate, MarketValue> mv) {
        return new SlotEconomics(
                site("direktvermarktung", false, "ohne", null, aw, null, null),
                EegRates.defaults(), mv);
    }

    // ---- import price per tarif_art -----------------------------------------

    @Test
    void dynamischImportIsSpotPlusAufschlag() {
        SlotEconomics e = new SlotEconomics(
                site("eigenverbrauch", false, "dynamisch", 18.0, null, null, null),
                EegRates.defaults(), Map.of());
        assertThat(e.importPriceCtKwh(100.0)).isCloseTo(10.0 + 18.0, within(1e-9));
        assertThat(e.importPriceCtKwh(-40.0)).isCloseTo(-4.0 + 18.0, within(1e-9));
        assertThat(e.importPriceCtKwh(null)).isNull();
    }

    @Test
    void festImportIsTheFlatRetailPriceEvenWithoutSpot() {
        SlotEconomics e = new SlotEconomics(
                site("eigenverbrauch", false, "fest", 30.0, null, null, null),
                EegRates.defaults(), Map.of());
        assertThat(e.importPriceCtKwh(200.0)).isEqualTo(30.0);
        assertThat(e.importPriceCtKwh(null)).isEqualTo(30.0);
    }

    @Test
    void festWithoutPriceAndOhneDegradeToBareSpot() {
        SlotEconomics fest = new SlotEconomics(
                site("eigenverbrauch", false, "fest", null, null, null, null),
                EegRates.defaults(), Map.of());
        assertThat(fest.importPriceCtKwh(200.0)).isEqualTo(20.0);
        SlotEconomics ohne = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null, null, null),
                EegRates.defaults(), Map.of());
        assertThat(ohne.importPriceCtKwh(200.0)).isEqualTo(20.0);
        assertThat(ohne.importPriceCtKwh(null)).isNull();
    }

    // ---- export value: Direktvermarktung (Marktprämie) ------------------------

    @Test
    void dvPremiumIsAnzulegenderWertMinusMonatsmarktwertFlooredAtZero() {
        // aw 8.11, MW Solar 4.5 -> premium 3.61 ct on top of spot 10 ct.
        SlotEconomics e = dv(8.11, Map.of(JUNE, new MarketValue(4.5, false)));
        assertThat(e.exportValueCtKwh(100.0, SLOT)).isCloseTo(10.0 + 3.61, within(1e-9));
        // MW above aw -> no premium, never negative.
        SlotEconomics floored = dv(8.11, Map.of(JUNE, new MarketValue(9.0, false)));
        assertThat(floored.exportValueCtKwh(100.0, SLOT)).isCloseTo(10.0, within(1e-9));
    }

    @Test
    void dvPremiumIsSuspendedAtNegativeSpot() {
        SlotEconomics e = dv(8.11, Map.of(JUNE, new MarketValue(4.5, false)));
        assertThat(e.exportValueCtKwh(-40.0, SLOT)).isCloseTo(-4.0, within(1e-9));
    }

    @Test
    void dvWithoutAwOrMarketValueMonthIsBareSpot() {
        assertThat(dv(null, Map.of()).exportValueCtKwh(100.0, SLOT)).isEqualTo(10.0);
        assertThat(dv(8.11, Map.of()).exportValueCtKwh(100.0, SLOT)).isEqualTo(10.0);
    }

    @Test
    void merchantModeExportsAtBareSpotDespiteConfiguredPremium() {
        // pricing.py's Ausschließlichkeitsprinzip guard: netzladen_erlaubt
        // means EEG remuneration never enters the objective.
        SlotEconomics e = new SlotEconomics(
                site("direktvermarktung", true, "ohne", null, 8.11, null, null),
                EegRates.defaults(), Map.of(JUNE, new MarketValue(4.5, false)));
        assertThat(e.exportValueCtKwh(100.0, SLOT)).isEqualTo(10.0);
    }

    // ---- export value: Eigenverbrauch (feste Vergütung) -----------------------

    @Test
    void festeVerguetungIsFlatAndSurvivesNegativeSpotForOlderPlants() {
        SlotEconomics e = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null,
                        LocalDate.of(2023, 6, 15), 5.0),
                EegRates.defaults(), Map.of());
        assertThat(e.exportValueCtKwh(100.0, SLOT)).isEqualTo(8.2);
        assertThat(e.exportValueCtKwh(-40.0, SLOT)).isEqualTo(8.2);
    }

    @Test
    void postSolarspitzengesetzPlantEarnsNothingAtNegativeSpot() {
        SlotEconomics e = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null,
                        LocalDate.of(2025, 3, 1), 5.0),
                EegRates.defaults(), Map.of());
        assertThat(e.exportValueCtKwh(100.0, SLOT)).isEqualTo(7.94);
        assertThat(e.exportValueCtKwh(-40.0, SLOT)).isEqualTo(0.0);
        assertThat(e.exportValueCtKwh(null, SLOT)).isNull(); // §51a needs the sign
    }

    @Test
    void unknownCommissioningOrExpiredRemunerationDegradesToSpot() {
        SlotEconomics unknown = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null, null, null),
                EegRates.defaults(), Map.of());
        assertThat(unknown.exportValueCtKwh(100.0, SLOT)).isEqualTo(10.0);
        SlotEconomics expired = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null,
                        LocalDate.of(2004, 6, 1), 5.0),
                EegRates.defaults(), Map.of());
        assertThat(expired.exportValueCtKwh(100.0, SLOT)).isEqualTo(10.0);
    }

    // ---- persisted wear rate --------------------------------------------------

    @Test
    void wearRateDerivesFromPersistedWearOverSlotThroughput() {
        // 4 kW for 15 min = 1 kWh throughput; 0.02 EUR wear -> 2 ct/kWh.
        assertThat(SlotEconomics.wearCostCtKwh(0.02, 4.0, 0.25))
                .isCloseTo(2.0, within(1e-9));
        // Direction-agnostic (discharge slots carry negative kW).
        assertThat(SlotEconomics.wearCostCtKwh(0.02, -4.0, 0.25))
                .isCloseTo(2.0, within(1e-9));
        // Idle slot or pre-P2 row: no rate, never a fake 0.
        assertThat(SlotEconomics.wearCostCtKwh(0.0, 0.0, 0.25)).isNull();
        assertThat(SlotEconomics.wearCostCtKwh(null, 4.0, 0.25)).isNull();
    }

    // ---- stored-energy value (forward best-use approximation) -----------------

    @Test
    void storedEnergyValueIsForwardBestUseDiscountedByEfficiencyAndWear() {
        SlotEconomics e = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null, null, null),
                EegRates.defaults(), Map.of());
        // Import 10/30/20 ct, export 5/8/25 ct: best-use = 10/30/25, forward
        // max from slot 0 = 30, slot 1 = 30, slot 2 = 25.
        List<Double> stored = e.storedEnergyValuesCtKwh(
                List.of(10.0, 30.0, 20.0), List.of(5.0, 8.0, 25.0));
        double eta = Math.sqrt(0.92);
        double wearEachWay = 4.0 / 2.0;
        assertThat(stored.get(0)).isCloseTo(eta * (30.0 - wearEachWay), within(1e-9));
        assertThat(stored.get(1)).isCloseTo(eta * (30.0 - wearEachWay), within(1e-9));
        assertThat(stored.get(2)).isCloseTo(eta * (25.0 - wearEachWay), within(1e-9));
    }

    @Test
    void storedEnergyValueFloorsAtZeroAndIsNullWithoutBatteryOrPrices() {
        SlotEconomics e = new SlotEconomics(
                site("eigenverbrauch", false, "ohne", null, null, null, null),
                EegRates.defaults(), Map.of());
        // A fully negative-priced tail values storage at 0, never below.
        assertThat(e.storedEnergyValuesCtKwh(List.of(-10.0), List.of(-12.0)).get(0))
                .isEqualTo(0.0);
        // No computable price anywhere -> null.
        assertThat(e.storedEnergyValuesCtKwh(
                Arrays.asList((Double) null), Arrays.asList((Double) null)).get(0)).isNull();
        // Battery-less site (no efficiency/wear) -> all null.
        SlotEconomics noBattery = new SlotEconomics(
                new SiteEconomics("eigenverbrauch", false, "ohne", null, null,
                        null, null, null, null),
                EegRates.defaults(), Map.of());
        assertThat(noBattery.storedEnergyValuesCtKwh(List.of(10.0), List.of(5.0)).get(0))
                .isNull();
    }

    // ---- decision label (schedule.ts chargeKind twin) --------------------------

    @Test
    void decisionLabelMirrorsChargeKind() {
        assertThat(SlotEconomics.decisionLabel(null, null, null, null)).isEqualTo("ruhe");
        assertThat(SlotEconomics.decisionLabel(0.04, 5.0, null, null)).isEqualTo("ruhe");
        assertThat(SlotEconomics.decisionLabel(-3.0, -2.0, null, null)).isEqualTo("entladen");
        assertThat(SlotEconomics.decisionLabel(5.0, 8.0, null, null)).isEqualTo("netzladen");
        assertThat(SlotEconomics.decisionLabel(5.0, -1.0, null, null)).isEqualTo("solarladen");
        assertThat(SlotEconomics.decisionLabel(5.0, null, null, null)).isEqualTo("solarladen");
        assertThat(SlotEconomics.decisionLabel(5.0, 0.04, null, null)).isEqualTo("solarladen");
    }

    /**
     * The pv-aware half of the twin (FK3 PV-bus semantics): an EEG cloudy-day
     * slot charges solar WHILE the house imports - grid never feeds the
     * battery, so it must NOT read netzladen; only charge beyond the slot's
     * available PV (pv - curtail) is grid-fed.
     */
    @Test
    void decisionLabelIsPvAwareSinceFk3() {
        // FK3 cloudy day: charge 3 kW == pv 3 kW while the house imports 1 kW.
        assertThat(SlotEconomics.decisionLabel(3.0, 1.0, 3.0, null)).isEqualTo("solarladen");
        // Real grid charge: charge 5 kW against 1 kW of PV.
        assertThat(SlotEconomics.decisionLabel(5.0, 4.5, 1.0, null)).isEqualTo("netzladen");
        // Within the PV deadband stays solar (forecast jitter must not flicker).
        assertThat(SlotEconomics.decisionLabel(3.05, 1.0, 3.0, null)).isEqualTo("solarladen");
        assertThat(SlotEconomics.decisionLabel(3.2, 1.0, 3.0, null)).isEqualTo("netzladen");
        // A fully curtailed slot has NO available PV: its charge is grid-fed.
        assertThat(SlotEconomics.decisionLabel(5.0, 5.0, 10.0, 10.0)).isEqualTo("netzladen");
        // No PV data (pre-pvKw rows): the old import-based fallback.
        assertThat(SlotEconomics.decisionLabel(4.0, 6.0, null, null)).isEqualTo("netzladen");
    }

    // ---- whyText ---------------------------------------------------------------

    @Test
    void whyTextComposesGermanRationalesAndDegradesWithoutNumbers() {
        assertThat(SlotEconomics.whyText("entladen", -5.0, -2.0, null, 28.0, 18.5, 12.3))
                .contains("speist ein").contains("18,5 ct/kWh").contains("12,3 ct/kWh");
        assertThat(SlotEconomics.whyText("entladen", -5.0, 2.0, null, 28.0, 18.5, 12.3))
                .contains("Eigenverbrauch").contains("28,0 ct/kWh");
        assertThat(SlotEconomics.whyText("netzladen", 5.0, 8.0, null, 8.0, 5.0, 20.0))
                .contains("aus dem Netz").contains("8,0 ct/kWh");
        assertThat(SlotEconomics.whyText("solarladen", 5.0, -1.0, null, 30.0, 7.9, 20.0))
                .contains("PV-Überschuss").contains("7,9 ct/kWh");
        assertThat(SlotEconomics.whyText("ruhe", 0.0, 0.0, null, null, null, null))
                .contains("ruht");
        // Missing numbers degrade to a number-free sentence, never invent one.
        assertThat(SlotEconomics.whyText("solarladen", 5.0, null, null, null, null, null))
                .isEqualTo("Speichert 5,0 kW PV-Überschuss.");
        // Curtailment at a negative export value names the avoided loss.
        assertThat(SlotEconomics.whyText("ruhe", 0.0, -3.0, 4.0, null, -4.0, null))
                .contains("Drosselt 4,0 kW PV").contains("Geld kosten");
        assertThat(SlotEconomics.whyText("ruhe", 0.0, -3.0, 4.0, null, 5.0, null))
                .contains("Einspeisebegrenzung");
    }
}
