package com.voltpilot.api.history;

import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.HistoryDto;
import com.voltpilot.api.web.dto.HistoryPlanPointDto;
import com.voltpilot.api.web.dto.HistoryTotalsDto;
import com.voltpilot.api.web.dto.ProtocolEventDto;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.stereotype.Service;

/**
 * Assembles a site's Historie response for one period: the bucketed series
 * (day = live 15-min from raw telemetry; week/month/year = the precomputed
 * rollups), the period totals (formulas documented on
 * {@link HistoryTotalsDto}), and for the day range the Tagesprotokoll plus
 * the plan-vs-actual overlay. Tenant scoping is entirely RLS (the repository
 * reads as the app role), so this service never sees foreign data.
 */
@Service
public class HistoryService {

    private final HistoryRepository repo;

    public HistoryService(HistoryRepository repo) {
        this.repo = repo;
    }

    public HistoryDto history(UUID siteId, String biddingZone, HistoryRange range, LocalDate at) {
        HistoryRange.Window window = range.window(at);

        List<HistoryBucketDto> buckets;
        if (range == HistoryRange.DAY) {
            buckets = repo.dayBuckets(siteId, window.from(), window.to(), biddingZone);
        } else {
            buckets = repo.rollupBuckets(siteId, window.from(), window.to(), range.dailyBuckets());
            Map<Instant, BigDecimal> costs = repo.costPerBucket(
                    siteId, window.from(), window.to(), biddingZone, range.dailyBuckets());
            buckets = buckets.stream()
                    .map(b -> withCost(b, costs.get(b.start())))
                    .toList();
        }

        HistoryTotalsDto totals = totals(buckets, repo.savings(siteId, window.from(), window.to()));

        List<ProtocolEventDto> protocol = range == HistoryRange.DAY
                ? Tagesprotokoll.build(buckets)
                : List.of();
        List<HistoryPlanPointDto> plan = range == HistoryRange.DAY
                ? repo.planForWindow(siteId, window.from(), window.to())
                : List.of();

        return new HistoryDto(range.name().toLowerCase(java.util.Locale.ROOT),
                window.from(), window.to(), range.bucketMinutes(), buckets, totals, protocol, plan);
    }

    /** Period totals; see {@link HistoryTotalsDto} for the formulas. */
    static HistoryTotalsDto totals(List<HistoryBucketDto> buckets, BigDecimal savings) {
        BigDecimal consumption = sum(buckets, HistoryBucketDto::loadKwh);
        BigDecimal pv = sum(buckets, HistoryBucketDto::pvKwh);
        BigDecimal gridImport = sum(buckets, HistoryBucketDto::gridImportKwh);
        BigDecimal gridExport = sum(buckets, HistoryBucketDto::gridExportKwh);

        // Cost is null (not zero) when no bucket had a matching price at all.
        BigDecimal cost = null;
        for (HistoryBucketDto b : buckets) {
            if (b.costEur() != null) {
                cost = (cost == null ? BigDecimal.ZERO : cost).add(b.costEur());
            }
        }

        BigDecimal autarkie = null;
        if (consumption.signum() > 0) {
            autarkie = clampPct(BigDecimal.ONE
                    .subtract(gridImport.divide(consumption, MathContext.DECIMAL64))
                    .multiply(BigDecimal.valueOf(100)));
        }
        BigDecimal eigenverbrauch = null;
        if (pv.signum() > 0) {
            eigenverbrauch = clampPct(pv.subtract(gridExport)
                    .divide(pv, MathContext.DECIMAL64)
                    .multiply(BigDecimal.valueOf(100)));
        }

        return new HistoryTotalsDto(
                round(consumption), round(pv), round(gridImport), round(gridExport),
                cost == null ? null : cost.setScale(4, RoundingMode.HALF_UP),
                savings == null ? null : savings.setScale(4, RoundingMode.HALF_UP),
                autarkie, eigenverbrauch);
    }

    private static HistoryBucketDto withCost(HistoryBucketDto b, BigDecimal cost) {
        if (cost == null) {
            return b;
        }
        return new HistoryBucketDto(b.start(), b.pvKwh(), b.loadKwh(),
                b.gridImportKwh(), b.gridExportKwh(),
                b.batteryChargeKwh(), b.batteryDischargeKwh(),
                b.socMinPct(), b.socMaxPct(), b.socLastPct(),
                b.priceEurMwh(), cost);
    }

    private static BigDecimal sum(List<HistoryBucketDto> buckets,
            Function<HistoryBucketDto, BigDecimal> field) {
        BigDecimal total = BigDecimal.ZERO;
        for (HistoryBucketDto b : buckets) {
            BigDecimal v = field.apply(b);
            if (v != null) {
                total = total.add(v);
            }
        }
        return total;
    }

    private static BigDecimal clampPct(BigDecimal pct) {
        BigDecimal clamped = pct.max(BigDecimal.ZERO).min(BigDecimal.valueOf(100));
        return clamped.setScale(1, RoundingMode.HALF_UP);
    }

    private static BigDecimal round(BigDecimal v) {
        return v.setScale(3, RoundingMode.HALF_UP);
    }
}
