package com.voltpilot.api.history;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.ProtocolEventDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Unit tests of the Tagesprotokoll heuristics on synthetic days (pure, no
 * Spring/DB). Buckets are 15-min; battery energies are the per-bucket kWh the
 * repository derives from the telemetry power balance.
 */
class TagesprotokollTest {

    private static final Instant DAY = Instant.parse("2026-06-15T00:00:00Z");

    @Test
    void emptyDayYieldsEmptyProtocol() {
        assertThat(Tagesprotokoll.build(List.of())).isEmpty();
    }

    @Test
    void idleDayBelowThresholdYieldsNoBatteryEvents() {
        // 0.01 kWh per 15 min = 0.04 kW net, below the 0.1 kW noise threshold.
        List<HistoryBucketDto> buckets = List.of(
                bucket(0, charge(0.01), price(100)),
                bucket(1, discharge(0.01), price(100)));
        assertThat(Tagesprotokoll.build(buckets))
                .extracting(ProtocolEventDto::type)
                .doesNotContain("batterie-laden", "batterie-entladen");
    }

    @Test
    void chargeWindowMergesBucketsAndWeightsPriceByEnergy() {
        // Three consecutive charging buckets: 0.5 kWh @100, 0.5 @100, 1.0 @40
        // -> one window, 2.0 kWh, weighted avg = (50 + 50 + 40) / 2.0 = 70 EUR/MWh.
        List<HistoryBucketDto> buckets = List.of(
                bucket(0, charge(0.5), price(100)),
                bucket(1, charge(0.5), price(100)),
                bucket(2, charge(1.0), price(40)),
                bucket(3, charge(0.0), price(100))); // idle ends the window

        List<ProtocolEventDto> charging = Tagesprotokoll.build(buckets).stream()
                .filter(e -> e.type().equals("batterie-laden")).toList();
        assertThat(charging).hasSize(1);
        ProtocolEventDto e = charging.get(0);
        assertThat(e.start()).isEqualTo(DAY);
        assertThat(e.end()).isEqualTo(DAY.plusSeconds(3 * 900));
        assertThat(e.energyKwh()).isEqualByComparingTo("2.0");
        assertThat(e.avgPriceEurMwh()).isEqualByComparingTo("70");
        assertThat(e.text()).contains("2,0 kWh").contains("7,0 ct/kWh");
    }

    @Test
    void dischargeWindowReportsAvoidedGridCost() {
        // 1.0 kWh discharged at 200 EUR/MWh -> 0.20 EUR import avoided.
        List<HistoryBucketDto> buckets = List.of(
                bucket(0, discharge(0.5), price(200)),
                bucket(1, discharge(0.5), price(200)));

        List<ProtocolEventDto> discharging = Tagesprotokoll.build(buckets).stream()
                .filter(e -> e.type().equals("batterie-entladen")).toList();
        assertThat(discharging).hasSize(1);
        ProtocolEventDto e = discharging.get(0);
        assertThat(e.energyKwh()).isEqualByComparingTo("1.0");
        assertThat(e.avoidedCostEur()).isEqualByComparingTo("0.20");
        assertThat(e.text()).contains("0,20 €").contains("vermieden");
    }

    @Test
    void chargeWithoutPricesStillReportsEnergy() {
        List<ProtocolEventDto> events =
                Tagesprotokoll.build(List.of(bucket(0, charge(0.5), null)));
        assertThat(events).extracting(ProtocolEventDto::type).contains("batterie-laden");
        ProtocolEventDto e = events.stream()
                .filter(ev -> ev.type().equals("batterie-laden")).findFirst().orElseThrow();
        assertThat(e.avgPriceEurMwh()).isNull();
        assertThat(e.text()).contains("0,5 kWh").doesNotContain("ct/kWh");
    }

    @Test
    void directionChangeSplitsWindowsAndEventsAreSortedByTime() {
        List<HistoryBucketDto> buckets = List.of(
                bucket(0, charge(0.5), null),
                bucket(1, discharge(0.5), null));
        List<ProtocolEventDto> events = Tagesprotokoll.build(buckets);
        assertThat(events).extracting(ProtocolEventDto::type)
                .containsExactly("batterie-laden", "batterie-entladen");
    }

    @Test
    void pvPeakReportsTimeAndKw() {
        // pv kWh per 15 min: 0.2 / 1.0 / 0.5 -> peak 4.0 kW in the second bucket.
        List<HistoryBucketDto> buckets = List.of(
                pvBucket(0, 0.2), pvBucket(1, 1.0), pvBucket(2, 0.5));
        List<ProtocolEventDto> events = Tagesprotokoll.build(buckets);
        ProtocolEventDto peak = events.stream()
                .filter(e -> e.type().equals("pv-spitze")).findFirst().orElseThrow();
        assertThat(peak.start()).isEqualTo(DAY.plusSeconds(900));
        assertThat(peak.peakKw()).isEqualByComparingTo("4.0");
        assertThat(peak.text()).contains("4,0 kW");
    }

    @Test
    void nightWithoutPvHasNoPvPeak() {
        assertThat(Tagesprotokoll.build(List.of(pvBucket(0, 0.0), pvBucket(1, 0.0))))
                .extracting(ProtocolEventDto::type)
                .doesNotContain("pv-spitze");
    }

    @Test
    void priceExtremesReportedOnlyWhenCurveIsNotFlat() {
        List<HistoryBucketDto> varied = List.of(
                bucket(0, idle(), price(50)),
                bucket(1, idle(), price(300)),
                bucket(2, idle(), price(120)));
        List<ProtocolEventDto> events = Tagesprotokoll.build(varied);
        ProtocolEventDto min = events.stream()
                .filter(e -> e.type().equals("preis-tief")).findFirst().orElseThrow();
        ProtocolEventDto max = events.stream()
                .filter(e -> e.type().equals("preis-hoch")).findFirst().orElseThrow();
        assertThat(min.start()).isEqualTo(DAY);
        assertThat(min.text()).contains("5,0 ct/kWh");
        assertThat(max.start()).isEqualTo(DAY.plusSeconds(900));
        assertThat(max.text()).contains("30,0 ct/kWh");

        List<HistoryBucketDto> flat = List.of(
                bucket(0, idle(), price(80)), bucket(1, idle(), price(80)));
        assertThat(Tagesprotokoll.build(flat))
                .extracting(ProtocolEventDto::type)
                .doesNotContain("preis-tief", "preis-hoch");
    }

    // ---- synthetic-day helpers ------------------------------------------------

    private record Battery(double chargeKwh, double dischargeKwh) {
    }

    private static Battery charge(double kwh) {
        return new Battery(kwh, 0);
    }

    private static Battery discharge(double kwh) {
        return new Battery(0, kwh);
    }

    private static Battery idle() {
        return new Battery(0, 0);
    }

    private static BigDecimal price(double eurMwh) {
        return BigDecimal.valueOf(eurMwh);
    }

    private static HistoryBucketDto bucket(int slot, Battery battery, BigDecimal price) {
        return new HistoryBucketDto(DAY.plusSeconds(slot * 900L),
                BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO,
                BigDecimal.valueOf(battery.chargeKwh()), BigDecimal.valueOf(battery.dischargeKwh()),
                null, null, null, price, null);
    }

    private static HistoryBucketDto pvBucket(int slot, double pvKwh) {
        return new HistoryBucketDto(DAY.plusSeconds(slot * 900L),
                BigDecimal.valueOf(pvKwh), BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO,
                BigDecimal.ZERO, BigDecimal.ZERO, null, null, null, null, null);
    }
}
