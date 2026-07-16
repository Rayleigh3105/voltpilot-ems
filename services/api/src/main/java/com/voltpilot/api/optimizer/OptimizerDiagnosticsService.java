package com.voltpilot.api.optimizer;

import com.voltpilot.api.optimizer.SlotEconomics.MarketValue;
import com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository.SiteContext;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository.SlotRow;
import com.voltpilot.api.web.dto.OptimizerDiagnosticsDto;
import com.voltpilot.api.web.dto.OptimizerDiagnosticsDto.BatteryContext;
import com.voltpilot.api.web.dto.OptimizerDiagnosticsSlotDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Assembles the admin optimizer diagnostics (design §4.2): loads the run's
 * persisted slots + the site's pricing master data through the RLS-scoped
 * repository, reconstructs the per-slot P1 import/export values with
 * {@link SlotEconomics} (the pricing.py twin), derives the P2 wear rate from
 * the PERSISTED {@code wear_cost_eur}, approximates the stored-energy value,
 * and composes decision label + German why-sentence per slot.
 */
@Service
public class OptimizerDiagnosticsService {

    /** 15-min platform slot grid (domain.py SLOT_MINUTES). */
    static final int SLOT_MINUTES = 15;
    private static final double SLOT_HOURS = SLOT_MINUTES / 60.0;
    private static final int MAX_AVAILABLE_RUNS = 30;

    private final OptimizerDiagnosticsRepository repo;
    private final OptimizerProperties properties;
    private final EegRates eegRates;
    private final String activeLoadModel;
    private final String activePvModel;

    public OptimizerDiagnosticsService(
            OptimizerDiagnosticsRepository repo,
            OptimizerProperties properties,
            @Value("${voltpilot.forecast.active-load-model}") String activeLoadModel,
            @Value("${voltpilot.forecast.active-pv-model}") String activePvModel) {
        this.repo = repo;
        this.properties = properties;
        this.eegRates = EegRates.fromJson(properties.eegRatesJson());
        this.activeLoadModel = activeLoadModel;
        this.activePvModel = activePvModel;
    }

    /** The site's context, or null when RLS hides the site (=> 404 upstream). */
    public SiteContext siteContext(UUID siteId) {
        return repo.siteContext(siteId);
    }

    /**
     * The diagnostics of one run: {@code generatedAt} null = the latest run.
     * Returns null when the requested run does not exist for this site; a site
     * without any plan yields an empty (but well-formed) DTO.
     */
    public OptimizerDiagnosticsDto diagnose(SiteContext site, Instant generatedAt) {
        Instant run = repo.resolveRun(site.siteId(), generatedAt);
        if (run == null && generatedAt != null) {
            return null; // the requested run does not exist
        }
        List<Instant> availableRuns = repo.availableRuns(site.siteId(), MAX_AVAILABLE_RUNS);
        if (run == null) {
            return dto(site, null, null, availableRuns, List.of());
        }
        List<SlotRow> rows = repo.slots(site.siteId(), run);
        Map<LocalDate, MarketValue> marketValues = marketValuesFor(site, rows);
        SlotEconomics economics = new SlotEconomics(siteEconomics(site), eegRates, marketValues);

        List<Double> importCt = new ArrayList<>(rows.size());
        List<Double> exportCt = new ArrayList<>(rows.size());
        for (SlotRow row : rows) {
            Double spot = toDouble(row.priceEurMwh());
            importCt.add(economics.importPriceCtKwh(spot));
            exportCt.add(economics.exportValueCtKwh(spot, row.time()));
        }
        List<Double> storedCt = economics.storedEnergyValuesCtKwh(importCt, exportCt);

        List<OptimizerDiagnosticsSlotDto> slots = new ArrayList<>(rows.size());
        for (int i = 0; i < rows.size(); i++) {
            SlotRow row = rows.get(i);
            Double batteryKw = toDouble(row.batteryKw());
            Double gridKw = toDouble(row.gridKw());
            Double curtailKw = toDouble(row.curtailKw());
            String label = SlotEconomics.decisionLabel(batteryKw, gridKw,
                    toDouble(row.pvKw()), curtailKw);
            slots.add(new OptimizerDiagnosticsSlotDto(
                    row.time(),
                    row.batteryKw(),
                    row.gridKw(),
                    row.socPct(),
                    row.loadKw(),
                    row.pvKw(),
                    row.curtailKw(),
                    row.costEur(),
                    row.baselineCostEur(),
                    row.wearCostEur(),
                    toDouble(row.priceEurMwh()) == null ? null
                            : row.priceEurMwh().doubleValue() / 10.0,
                    importCt.get(i),
                    exportCt.get(i),
                    SlotEconomics.wearCostCtKwh(
                            toDouble(row.wearCostEur()), batteryKw, SLOT_HOURS),
                    storedCt.get(i),
                    label,
                    SlotEconomics.whyText(label, batteryKw, gridKw, curtailKw,
                            importCt.get(i), exportCt.get(i), storedCt.get(i))));
        }
        return dto(site, repo.planId(site.siteId(), run), run, availableRuns, slots);
    }

    private OptimizerDiagnosticsDto dto(SiteContext site, UUID planId, Instant run,
            List<Instant> availableRuns, List<OptimizerDiagnosticsSlotDto> slots) {
        return new OptimizerDiagnosticsDto(
                site.siteId(),
                planId,
                run,
                SLOT_MINUTES,
                availableRuns,
                site.plantKind(),
                site.netzladenErlaubt(),
                site.tarifArt(),
                site.tarifParamCtKwh(),
                site.anzulegenderWertCtKwh(),
                site.backupReserveSocPct(),
                batteryContext(site),
                activeLoadModel,
                activePvModel,
                true,
                slots);
    }

    /** The effective battery parameters, or null for battery-less sites. */
    BatteryContext batteryContext(SiteContext site) {
        if (!site.hasBattery()) {
            return null;
        }
        boolean overridden = site.wearCostCtPerKwh() != null;
        double wearCt = overridden
                ? site.wearCostCtPerKwh().doubleValue()
                : properties.defaultWearCostCtPerKwh();
        double socMin = site.socMinPct() != null
                ? site.socMinPct().doubleValue() : OptimizerProperties.DEFAULT_SOC_MIN_PCT;
        double socMax = site.socMaxPct() != null
                ? site.socMaxPct().doubleValue() : OptimizerProperties.DEFAULT_SOC_MAX_PCT;
        return new BatteryContext(
                site.batteryCapacityKwh(),
                site.roundtripEfficiencyPct(),
                wearCt,
                overridden ? "asset" : "platform-default",
                socMin,
                socMax);
    }

    private SiteEconomics siteEconomics(SiteContext site) {
        // Battery-less sites carry no efficiency/wear: stored-energy values
        // are then honestly absent (SlotEconomics returns nulls).
        Double roundtrip = null;
        Double wearCt = null;
        if (site.hasBattery()) {
            // NULL efficiency defaults like inputs.load_battery_sites (92%).
            roundtrip = site.roundtripEfficiencyPct() != null
                    ? site.roundtripEfficiencyPct().doubleValue() / 100.0 : 0.92;
            wearCt = site.wearCostCtPerKwh() != null
                    ? site.wearCostCtPerKwh().doubleValue()
                    : properties.defaultWearCostCtPerKwh();
        }
        return new SiteEconomics(
                site.plantKind(),
                site.netzladenErlaubt(),
                site.tarifArt(),
                toDouble(site.tarifParamCtKwh()),
                toDouble(site.anzulegenderWertCtKwh()),
                site.pvCommissionedOn(),
                toDouble(site.pvCapacityKwp()),
                roundtrip,
                wearCt);
    }

    private Map<LocalDate, MarketValue> marketValuesFor(SiteContext site, List<SlotRow> rows) {
        // Only DV sites with an anzulegender Wert in EEG mode can earn the
        // premium (pricing.py needs_market_values) - skip the query otherwise.
        boolean needed = !site.netzladenErlaubt()
                && "direktvermarktung".equals(site.plantKind())
                && site.anzulegenderWertCtKwh() != null;
        if (!needed || rows.isEmpty()) {
            return Map.of();
        }
        LocalDate from = SlotEconomics.berlinMonth(rows.get(0).time());
        LocalDate to = SlotEconomics.berlinMonth(rows.get(rows.size() - 1).time());
        return repo.marketValues(from, to);
    }

    private static Double toDouble(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }
}
