package com.voltpilot.api.consumers;

import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.web.dto.PricePointDto;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * The production {@link ConsumerPolicyCompiler.WindowSource}: expands a cloud
 * price condition to the concrete UTC windows where it holds (D1 - the ONE
 * price truth). Spot slots come from {@code day_ahead_prices} for the site's
 * bidding zone (PT15M preferred over a PT60M row covering the same time - the
 * platform's standing rule); {@code market.import_price_ct_kwh} runs each
 * slot's spot through the SAME {@link SlotEconomics} recomposition the admin
 * diagnostics and the Fahrplan pricing use - never a second price rule.
 *
 * <p>Contiguous holding slots merge into one window. No price data = an empty
 * list; the compiler then emits an already-expired sentinel window, which the
 * edge honestly reads as {@code unknown} (a rule without a cloud answer never
 * starts, §13.5).
 */
@Component
public class PriceWindowSource implements ConsumerPolicyCompiler.WindowSource {

    private final JdbcTemplate jdbc;
    private final PriceRepository prices;
    private final OptimizerDiagnosticsService diagnostics;

    public PriceWindowSource(JdbcTemplate jdbc, PriceRepository prices,
            OptimizerDiagnosticsService diagnostics) {
        this.jdbc = jdbc;
        this.prices = prices;
        this.diagnostics = diagnostics;
    }

    @Override
    public List<ConsumerPolicyCompiler.Window> windows(UUID siteId, String signal, String op,
            double value, Instant from, Instant to) {
        String zone = biddingZone(siteId);
        if (zone == null) {
            return List.of();
        }
        List<PricePointDto> points = preferQuarterHours(
                prices.findForZone(zone, from.minus(Duration.ofHours(1)), to, 500));
        if (points.isEmpty()) {
            return List.of();
        }
        SlotEconomics economics = "market.import_price_ct_kwh".equals(signal)
                ? diagnostics.economicsFor(siteId, from, to) : null;

        List<ConsumerPolicyCompiler.Window> out = new ArrayList<>();
        Instant openFrom = null;
        Instant openTo = null;
        for (PricePointDto p : points) {
            if (p.end().isBefore(from) || !p.ts().isBefore(to)) {
                continue;
            }
            Double ct = ctFor(signal, economics, p.priceEurMwh().doubleValue());
            boolean holds = ct != null && compare(op, ct, value);
            if (holds) {
                Instant slotFrom = p.ts().isBefore(from) ? from : p.ts();
                if (openTo != null && openTo.equals(slotFrom)) {
                    openTo = p.end();
                } else {
                    if (openFrom != null) {
                        out.add(new ConsumerPolicyCompiler.Window(openFrom, openTo));
                    }
                    openFrom = slotFrom;
                    openTo = p.end();
                }
            }
        }
        if (openFrom != null) {
            out.add(new ConsumerPolicyCompiler.Window(openFrom, openTo));
        }
        return out;
    }

    private Double ctFor(String signal, SlotEconomics economics, double spotEurMwh) {
        if ("market.import_price_ct_kwh".equals(signal)) {
            return economics == null ? null : economics.importPriceCtKwh(spotEurMwh);
        }
        return spotEurMwh / 10.0; // spot ct/kWh
    }

    private static boolean compare(String op, double v, double threshold) {
        return switch (op) {
            case "lt" -> v < threshold;
            case "lte" -> v <= threshold;
            case "gt" -> v > threshold;
            case "gte" -> v >= threshold;
            case "eq" -> v == threshold;
            case "ne" -> v != threshold;
            default -> false;
        };
    }

    /**
     * The PT15M-beats-PT60M rule: an hour covered by any quarter-hour row
     * drops its PT60M row; hours with only PT60M coverage keep it.
     */
    private static List<PricePointDto> preferQuarterHours(List<PricePointDto> raw) {
        List<PricePointDto> quarters = raw.stream()
                .filter(p -> Duration.between(p.ts(), p.end()).toMinutes() <= 15).toList();
        List<PricePointDto> out = new ArrayList<>(quarters);
        for (PricePointDto hour : raw) {
            if (Duration.between(hour.ts(), hour.end()).toMinutes() <= 15) {
                continue;
            }
            boolean covered = quarters.stream().anyMatch(q ->
                    !q.ts().isBefore(hour.ts()) && q.ts().isBefore(hour.end()));
            if (!covered) {
                out.add(hour);
            }
        }
        out.sort((a, b) -> a.ts().compareTo(b.ts()));
        return out;
    }

    private String biddingZone(UUID siteId) {
        List<String> rows = jdbc.query(
                "SELECT bidding_zone FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }
}
