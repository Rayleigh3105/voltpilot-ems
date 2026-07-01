package com.voltpilot.api.history;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.ProtocolEventDto;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * The Tagesprotokoll: the day's notable events in plain German, derived from
 * the day's 15-min telemetry buckets (+ prices where stored). Pure functions,
 * no I/O - the traceability heart of the Historie view, so the heuristics are
 * deliberately simple and honest:
 *
 * <ul>
 *   <li><b>Batterie geladen/entladen</b>: consecutive buckets whose net
 *       battery power (charge - discharge, derived from the telemetry power
 *       balance) exceeds {@value #BATTERY_THRESHOLD_KW} kW in either
 *       direction, merged into windows. Charge windows report the
 *       energy-weighted average price paid; discharge windows additionally
 *       report the avoided grid cost = discharged energy x that window's
 *       average price (the import the battery displaced at that time).</li>
 *   <li><b>PV-Spitze</b>: the bucket with the highest PV power.</li>
 *   <li><b>Preis-Tief / Preis-Hoch</b>: the cheapest and most expensive
 *       quarter-hour of the day (only when prices are stored, and only when
 *       they differ - a flat curve has no notable extremes).</li>
 * </ul>
 */
public final class Tagesprotokoll {

    /** Net battery power below this is treated as idle (measurement noise). */
    static final double BATTERY_THRESHOLD_KW = 0.1;

    private Tagesprotokoll() {
    }

    public static List<ProtocolEventDto> build(List<HistoryBucketDto> buckets) {
        List<ProtocolEventDto> events = new ArrayList<>();
        events.addAll(batteryWindows(buckets));
        pvPeak(buckets).ifPresent(events::add);
        events.addAll(priceExtremes(buckets));
        events.sort(Comparator.comparing(ProtocolEventDto::start));
        return events;
    }

    // ---- battery charge/discharge windows ------------------------------------

    private static List<ProtocolEventDto> batteryWindows(List<HistoryBucketDto> buckets) {
        List<ProtocolEventDto> events = new ArrayList<>();
        int i = 0;
        while (i < buckets.size()) {
            int direction = direction(buckets.get(i));
            if (direction == 0) {
                i++;
                continue;
            }
            int start = i;
            while (i < buckets.size() && direction(buckets.get(i)) == direction) {
                i++;
            }
            events.add(windowEvent(buckets.subList(start, i), direction));
        }
        return events;
    }

    /** +1 charging, -1 discharging, 0 idle/unknown for one bucket. */
    private static int direction(HistoryBucketDto b) {
        if (b.batteryChargeKwh() == null || b.batteryDischargeKwh() == null) {
            return 0;
        }
        double netKw = b.batteryChargeKwh().subtract(b.batteryDischargeKwh()).doubleValue()
                / bucketHours(b);
        if (netKw >= BATTERY_THRESHOLD_KW) {
            return 1;
        }
        return netKw <= -BATTERY_THRESHOLD_KW ? -1 : 0;
    }

    private static ProtocolEventDto windowEvent(List<HistoryBucketDto> window, int direction) {
        Instant start = window.get(0).start();
        Instant end = window.get(window.size() - 1).start()
                .plus(Duration.ofMinutes(15));
        BigDecimal energy = BigDecimal.ZERO;
        BigDecimal priceWeighted = BigDecimal.ZERO;
        BigDecimal pricedEnergy = BigDecimal.ZERO;
        for (HistoryBucketDto b : window) {
            BigDecimal e = direction > 0 ? b.batteryChargeKwh() : b.batteryDischargeKwh();
            if (e == null) {
                continue;
            }
            energy = energy.add(e);
            if (b.priceEurMwh() != null) {
                priceWeighted = priceWeighted.add(e.multiply(b.priceEurMwh()));
                pricedEnergy = pricedEnergy.add(e);
            }
        }
        BigDecimal avgPrice = pricedEnergy.signum() > 0
                ? priceWeighted.divide(pricedEnergy, MathContext.DECIMAL64)
                : null;

        if (direction > 0) {
            String text = avgPrice != null
                    ? String.format(Locale.GERMANY, "Batterie geladen: %.1f kWh bei Ø %.1f ct/kWh",
                            energy, ctPerKwh(avgPrice))
                    : String.format(Locale.GERMANY, "Batterie geladen: %.1f kWh", energy);
            return new ProtocolEventDto("batterie-laden", start, end, text,
                    round(energy), round(avgPrice), null, null);
        }
        BigDecimal avoided = avgPrice != null
                ? energy.multiply(avgPrice).divide(BigDecimal.valueOf(1000), MathContext.DECIMAL64)
                : null;
        String text = avoided != null
                ? String.format(Locale.GERMANY,
                        "Batterie entladen: %.1f kWh - ca. %.2f € Netzbezug vermieden",
                        energy, avoided)
                : String.format(Locale.GERMANY, "Batterie entladen: %.1f kWh", energy);
        return new ProtocolEventDto("batterie-entladen", start, end, text,
                round(energy), round(avgPrice), round(avoided), null);
    }

    // ---- PV peak --------------------------------------------------------------

    private static java.util.Optional<ProtocolEventDto> pvPeak(List<HistoryBucketDto> buckets) {
        HistoryBucketDto peak = null;
        for (HistoryBucketDto b : buckets) {
            if (b.pvKwh() != null && b.pvKwh().signum() > 0
                    && (peak == null || b.pvKwh().compareTo(peak.pvKwh()) > 0)) {
                peak = b;
            }
        }
        if (peak == null) {
            return java.util.Optional.empty();
        }
        BigDecimal peakKw = peak.pvKwh()
                .divide(BigDecimal.valueOf(bucketHours(peak)), MathContext.DECIMAL64);
        return java.util.Optional.of(new ProtocolEventDto(
                "pv-spitze", peak.start(), peak.start().plus(Duration.ofMinutes(15)),
                String.format(Locale.GERMANY, "PV-Spitze: %.1f kW", peakKw),
                null, null, null, round(peakKw)));
    }

    // ---- price extremes --------------------------------------------------------

    private static List<ProtocolEventDto> priceExtremes(List<HistoryBucketDto> buckets) {
        HistoryBucketDto min = null;
        HistoryBucketDto max = null;
        for (HistoryBucketDto b : buckets) {
            if (b.priceEurMwh() == null) {
                continue;
            }
            if (min == null || b.priceEurMwh().compareTo(min.priceEurMwh()) < 0) {
                min = b;
            }
            if (max == null || b.priceEurMwh().compareTo(max.priceEurMwh()) > 0) {
                max = b;
            }
        }
        if (min == null || min.priceEurMwh().compareTo(max.priceEurMwh()) == 0) {
            return List.of();
        }
        return List.of(
                new ProtocolEventDto("preis-tief", min.start(),
                        min.start().plus(Duration.ofMinutes(15)),
                        String.format(Locale.GERMANY, "Günstigste Viertelstunde: %.1f ct/kWh",
                                ctPerKwh(min.priceEurMwh())),
                        null, round(min.priceEurMwh()), null, null),
                new ProtocolEventDto("preis-hoch", max.start(),
                        max.start().plus(Duration.ofMinutes(15)),
                        String.format(Locale.GERMANY, "Teuerste Viertelstunde: %.1f ct/kWh",
                                ctPerKwh(max.priceEurMwh())),
                        null, round(max.priceEurMwh()), null, null));
    }

    // ---- helpers ----------------------------------------------------------------

    /** Day buckets are 15 minutes; kept as a function for clarity, not config. */
    private static double bucketHours(HistoryBucketDto b) {
        return 0.25;
    }

    private static BigDecimal ctPerKwh(BigDecimal eurPerMwh) {
        return eurPerMwh.divide(BigDecimal.TEN, MathContext.DECIMAL64);
    }

    private static BigDecimal round(BigDecimal v) {
        return v == null ? null : v.setScale(4, RoundingMode.HALF_UP);
    }
}
