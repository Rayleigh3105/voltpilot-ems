package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

/**
 * Die reine Referenz-Physik des stur arbeitenden Standard-Speichers - der
 * Java-Zwilling von {@code simulation/greedy.py} (Szenario (b) der
 * Ersparnis-Simulation). Die ersten drei Vektoren SPIEGELN die
 * {@code test_simulation.py}-Greedy-Vektoren (dort in kW, hier in kWh je
 * 15-min-Slot: kW × 0,25 h) - wer die Greedy-Semantik dort ändert, ändert
 * beide Seiten. Dazu die Stammdaten-Auflösung (die
 * {@code inputs.load_battery_sites}/{@code _soc_band}-Regeln) und der
 * handgerechnete Geld-Vektor des Testcontainers-Falls.
 */
class StandardSpeicherTest {

    private static final org.assertj.core.data.Offset<Double> EPS =
            org.assertj.core.data.Offset.offset(1e-9);

    private static StandardSpeicher.Batterie batterie(
            double capacity, double charge, double discharge, Double effPct) {
        return StandardSpeicher.batterie(
                BigDecimal.valueOf(capacity), BigDecimal.valueOf(charge),
                BigDecimal.valueOf(discharge),
                effPct == null ? null : BigDecimal.valueOf(effPct),
                null, null, null, null);
    }

    /**
     * Mirror of {@code test_greedy_charges_surplus_with_efficiency_split}:
     * one slot of 4 kW surplus (1,0 kWh) on the 10/5/5/92% battery - charged
     * fully, SoC gains eta*1,0 kWh, and the charged kWh forgoes export at the
     * slot's export value.
     */
    @Test
    void chargesSurplusWithTheEfficiencySplit() {
        StandardSpeicher.Batterie b = batterie(10.0, 5.0, 5.0, null);
        double eta = Math.sqrt(0.92);
        assertThat(b.etaOneWay()).isCloseTo(eta, EPS);
        assertThat(b.socFloorKwh()).isCloseTo(0.5, EPS);
        assertThat(b.socMaxKwh()).isCloseTo(9.5, EPS);

        StandardSpeicher.Walk walk = new StandardSpeicher.Walk(b, null);
        walk.slot(1.25, 0.25, 0.30, 0.10);
        assertThat(walk.socKwh()).isCloseTo(0.5 + eta * 1.0, EPS);
        assertThat(walk.speicherEur()).isCloseTo(-0.10, EPS);
    }

    /**
     * Mirror of {@code test_greedy_discharges_deficit_and_respects_the_floor}:
     * at the floor nothing discharges (the whole deficit would import - the
     * dumb battery contributes 0); after a power-capped charge slot the
     * deficit discharges bounded by the deliverable content (stored × eta).
     */
    @Test
    void dischargesDeficitAndRespectsTheFloor() {
        StandardSpeicher.Batterie b = batterie(10.0, 5.0, 5.0, null);
        double eta = Math.sqrt(0.92);

        StandardSpeicher.Walk empty = new StandardSpeicher.Walk(b, null);
        empty.slot(0.0, 0.75, 0.30, 0.10);
        assertThat(empty.socKwh()).isCloseTo(b.socFloorKwh(), EPS);
        assertThat(empty.speicherEur()).isCloseTo(0.0, EPS);

        StandardSpeicher.Walk walk = new StandardSpeicher.Walk(b, null);
        // Slot 1: 8 kW surplus = 2,0 kWh, the 5-kW power cap binds at 1,25.
        walk.slot(2.0, 0.0, 0.30, 0.10);
        assertThat(walk.socKwh()).isCloseTo(b.socFloorKwh() + eta * 1.25, EPS);
        // Slot 2: 3-kW deficit = 0,75 kWh; deliverable = eta^2*1,25 = 1,15,
        // so the full deficit discharges and is valued at the import price.
        walk.slot(0.0, 0.75, 0.30, 0.10);
        assertThat(walk.speicherEur()).isCloseTo(-1.25 * 0.10 + 0.75 * 0.30, EPS);
    }

    /**
     * Mirror of {@code test_greedy_never_grid_charges_and_respects_soc_ceiling}
     * on a 1-kWh battery under permanent surplus: the SoC never exceeds the
     * 95% ceiling, and once full the walk charges 0 (the residual surplus
     * keeps exporting - dumb, deliberately).
     */
    @Test
    void neverExceedsTheCeilingAndStopsChargingWhenFull() {
        StandardSpeicher.Batterie b = batterie(1.0, 5.0, 5.0, null);
        StandardSpeicher.Walk walk = new StandardSpeicher.Walk(b, null);
        for (int i = 0; i < 8; i++) {
            walk.slot(1.25, 0.0, 0.30, 0.10);
            assertThat(walk.socKwh()).isLessThanOrEqualTo(b.socMaxKwh() + 1e-9);
        }
        assertThat(walk.socKwh()).isCloseTo(b.socMaxKwh(), EPS);
        // Full: another surplus slot moves neither SoC nor money.
        double before = walk.speicherEur();
        walk.slot(1.25, 0.0, 0.30, 0.10);
        assertThat(walk.speicherEur()).isCloseTo(before, EPS);
    }

    /**
     * Charging in a NEGATIVE-price slot ADDS value: the forgone "export" would
     * have cost money, so {@code -charge * ev} is positive - the dumb battery
     * legitimately avoids paid feed-in (the same economics the no-battery
     * baseline carries).
     */
    @Test
    void chargingAtANegativeExportValueEarns() {
        StandardSpeicher.Batterie b = batterie(10.0, 8.0, 8.0, 81.0);
        StandardSpeicher.Walk walk = new StandardSpeicher.Walk(b, null);
        walk.slot(1.5, 0.5, 0.30, -0.04);
        assertThat(walk.speicherEur()).isCloseTo(0.04, EPS);
    }

    /**
     * Der handgerechnete Geld-Vektor des Testcontainers-Falls (Site A in
     * {@code PortalApiTest}): Kapazität 3,0 kWh, 8 kW laden (2,0 kWh/Slot),
     * 16 kW entladen (4,0 kWh/Slot), Round-Trip 81% (eta = 0,9 exakt), Band
     * 5-95% (Boden 0,15 / Decke 2,85), Start am Boden; fest 30 ct Import,
     * Export zu nacktem Spot.
     *
     * <pre>
     *   Slot  spot   pv   load  Aktion                                SoC     Δspeicher
     *   1     100    3,0  0,5   charge 2,0 (Leistungs-Kappe)          1,95    −2,0×0,10 = −0,20
     *   2     200    2,5  1,0   charge 1,0 (Headroom (2,85−1,95)/0,9) 2,85    −1,0×0,20 = −0,20
     *   3     −40    1,0  0,5   voll → charge 0                       2,85    0
     *   4     250    0,0  4,0   discharge 2,43 (Energie (2,7)×0,9)    0,15    +2,43×0,30 = +0,729
     *                                                                 Σ speicher = 0,329
     * </pre>
     *
     * Jede Klemm-Kante ist dabei einmal dran: Leistungs-Kappe (1),
     * SoC-Decken-Headroom mit eta (2), voller Speicher (3), Energie-/
     * Boden-Klemme mit eta (4).
     */
    @Test
    void handComputedMoneyVectorOfTheTestcontainersCase() {
        StandardSpeicher.Batterie b = batterie(3.0, 8.0, 16.0, 81.0);
        assertThat(b.etaOneWay()).isCloseTo(0.9, EPS);
        assertThat(b.socFloorKwh()).isCloseTo(0.15, EPS);
        assertThat(b.socMaxKwh()).isCloseTo(2.85, EPS);

        StandardSpeicher.Walk walk = new StandardSpeicher.Walk(b, null);
        walk.slot(3.0, 0.5, 0.30, 0.10);
        assertThat(walk.socKwh()).isCloseTo(1.95, EPS);
        walk.slot(2.5, 1.0, 0.30, 0.20);
        assertThat(walk.socKwh()).isCloseTo(2.85, EPS);
        walk.slot(1.0, 0.5, 0.30, -0.04);
        assertThat(walk.socKwh()).isCloseTo(2.85, EPS);
        walk.slot(0.0, 4.0, 0.30, 0.25);
        assertThat(walk.socKwh()).isCloseTo(0.15, EPS);
        assertThat(walk.speicherEur()).isCloseTo(0.329, EPS);
    }

    /** Missing capacity or power master data = no reference battery, never a guess. */
    @Test
    void missingOrBrokenMasterDataResolvesToNull() {
        assertThat(StandardSpeicher.batterie(null, BigDecimal.ONE, BigDecimal.ONE,
                null, null, null, null, null)).isNull();
        assertThat(StandardSpeicher.batterie(BigDecimal.ONE, null, BigDecimal.ONE,
                null, null, null, null, null)).isNull();
        assertThat(StandardSpeicher.batterie(BigDecimal.ONE, BigDecimal.ONE, null,
                null, null, null, null, null)).isNull();
        assertThat(StandardSpeicher.batterie(BigDecimal.ZERO, BigDecimal.ONE,
                BigDecimal.ONE, null, null, null, null, null)).isNull();
        assertThat(StandardSpeicher.batterie(BigDecimal.ONE, BigDecimal.ZERO,
                BigDecimal.ONE, null, null, null, null, null)).isNull();
        assertThat(StandardSpeicher.batterie(BigDecimal.ONE, BigDecimal.ONE,
                BigDecimal.valueOf(-1), null, null, null, null, null)).isNull();
        assertThat(StandardSpeicher.batterie(BigDecimal.ONE, BigDecimal.ONE,
                BigDecimal.ONE, BigDecimal.ZERO, null, null, null, null)).isNull();
    }

    /**
     * The _soc_band discipline: an explicit band engages; an INCONSISTENT one
     * (min >= max) falls back to the platform 5-95% instead of failing - the
     * optimizer plans with the defaults then too, so the two verdicts stay
     * aligned.
     */
    @Test
    void socBandResolvesLikeTheOptimizer() {
        StandardSpeicher.Batterie explicit = StandardSpeicher.batterie(
                BigDecimal.TEN, BigDecimal.ONE, BigDecimal.ONE, null,
                BigDecimal.valueOf(10), BigDecimal.valueOf(90), null, null);
        assertThat(explicit.socFloorKwh()).isCloseTo(1.0, EPS);
        assertThat(explicit.socMaxKwh()).isCloseTo(9.0, EPS);

        StandardSpeicher.Batterie broken = StandardSpeicher.batterie(
                BigDecimal.TEN, BigDecimal.ONE, BigDecimal.ONE, null,
                BigDecimal.valueOf(80), BigDecimal.valueOf(20), null, null);
        assertThat(broken.socFloorKwh()).isCloseTo(0.5, EPS);
        assertThat(broken.socMaxKwh()).isCloseTo(9.5, EPS);
    }

    /**
     * The reservation STACK raises the floor absolutely (max, never additive),
     * capped at the ceiling - the {@code BatteryParams.soc_floor_kwh} rule.
     */
    @Test
    void reservesRaiseTheFloorAndCapAtTheCeiling() {
        StandardSpeicher.Batterie backup = StandardSpeicher.batterie(
                BigDecimal.TEN, BigDecimal.ONE, BigDecimal.ONE, null,
                null, null, BigDecimal.valueOf(30), null);
        assertThat(backup.socFloorKwh()).isCloseTo(3.0, EPS);

        StandardSpeicher.Batterie peakWins = StandardSpeicher.batterie(
                BigDecimal.TEN, BigDecimal.ONE, BigDecimal.ONE, null,
                null, null, BigDecimal.valueOf(30), BigDecimal.valueOf(50));
        assertThat(peakWins.socFloorKwh()).isCloseTo(5.0, EPS);

        StandardSpeicher.Batterie capped = StandardSpeicher.batterie(
                BigDecimal.TEN, BigDecimal.ONE, BigDecimal.ONE, null,
                null, null, BigDecimal.valueOf(100), null);
        assertThat(capped.socFloorKwh()).isCloseTo(capped.socMaxKwh(), EPS);
    }

    /**
     * The start SoC is the measured window-begin state clamped into the band
     * (the greedy initial clamp): below the floor starts at the floor, above
     * the ceiling at the ceiling, in between verbatim; unknown = floor.
     */
    @Test
    void startSocClampsIntoTheBandLikeGreedy() {
        StandardSpeicher.Batterie b = batterie(3.0, 8.0, 16.0, 81.0);
        assertThat(new StandardSpeicher.Walk(b, null).socKwh())
                .isCloseTo(0.15, EPS);
        assertThat(new StandardSpeicher.Walk(b, 0.05).socKwh())
                .isCloseTo(0.15, EPS);
        assertThat(new StandardSpeicher.Walk(b, 2.95).socKwh())
                .isCloseTo(2.85, EPS);
        assertThat(new StandardSpeicher.Walk(b, 1.95).socKwh())
                .isCloseTo(1.95, EPS);
    }

    /** A balanced slot (pv == load) moves neither SoC nor money. */
    @Test
    void balancedSlotIsANoOp() {
        StandardSpeicher.Batterie b = batterie(3.0, 8.0, 16.0, 81.0);
        StandardSpeicher.Walk walk = new StandardSpeicher.Walk(b, 1.0);
        walk.slot(1.5, 1.5, 0.30, 0.10);
        assertThat(walk.socKwh()).isCloseTo(1.0, EPS);
        assertThat(walk.speicherEur()).isCloseTo(0.0, within(1e-12));
    }
}
