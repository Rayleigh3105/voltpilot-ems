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
import java.time.ZoneId;
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
    /**
     * The plan-shape deadband the optimizer's per-slot duties share
     * (voltpilot_optimization/slot_trim.py PLANNED_DISCHARGE_DEADBAND_KW /
     * PLANNED_GRID_EXCHANGE_DEADBAND_KW, both 0,05 kW). Kept as ONE constant
     * here because the two are one number by construction on the Python side.
     */
    private static final double PLANNED_DEADBAND_KW = 0.05;

    /** The v1 platform timezone for run-day navigation (the HistoryRange rule). */
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

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
     * The diagnostics of one run, with the run list scoped to ONE Berlin day
     * (the {@code schedule} hypertable keeps every 15-min run, so an unscoped
     * list only ever reached ~7.5 hours back):
     * <ul>
     * <li>{@code generatedAt} set: that exact run (null return = 404 upstream);
     * {@code availableRuns} covers the run's Berlin day unless {@code date}
     * pins another one.</li>
     * <li>{@code date} set (no {@code generatedAt}): that Berlin day's newest
     * run; a day without runs yields an empty (but well-formed) DTO - the
     * picker range only bounds first/last, gaps inside stay possible.</li>
     * <li>neither set: the latest run + its day's runs (the pre-date-param
     * default, now day-scoped).</li>
     * </ul>
     * {@code firstRunDate}/{@code lastRunDate} always carry the site's covered
     * Berlin run-day range so the UI can bound its date picker; a site without
     * any plan yields an empty DTO with null range.
     */
    public OptimizerDiagnosticsDto diagnose(SiteContext site, Instant generatedAt, LocalDate date) {
        UUID siteId = site.siteId();
        // The effective import-price source is a SITE-level fact (independent of
        // any run) - which rule the optimizer prices grid import with today
        // (report vp-nacht-bezug-e7 Stufe 2 admin echo).
        String priceSource = new SlotEconomics(siteEconomics(site), eegRates, Map.of(),
                properties.defaultSupplyComponents()).importPriceSource();
        Instant run = null;
        if (generatedAt != null) {
            run = repo.resolveRun(siteId, generatedAt);
            if (run == null) {
                return null; // the requested run does not exist
            }
        }
        Instant latest = repo.resolveRun(siteId, null);
        Instant first = repo.firstRun(siteId);
        LocalDate firstRunDate = first == null ? null : berlinDay(first);
        LocalDate lastRunDate = latest == null ? null : berlinDay(latest);
        LocalDate day = date != null ? date
                : run != null ? berlinDay(run)
                : lastRunDate;
        List<Instant> availableRuns = day == null ? List.of()
                : repo.runsBetween(siteId,
                        day.atStartOfDay(BERLIN).toInstant(),
                        day.plusDays(1).atStartOfDay(BERLIN).toInstant());
        if (run == null) {
            // No explicit run: the picked day's newest, else the latest overall.
            run = date != null
                    ? (availableRuns.isEmpty() ? null : availableRuns.get(0))
                    : latest;
        }
        if (run == null) {
            return dto(site, null, null, day, firstRunDate, lastRunDate, availableRuns,
                    priceSource, true, null, new BigDecimal[] {null, null}, List.of());
        }
        List<SlotRow> rows = repo.slots(site.siteId(), run);
        Map<LocalDate, MarketValue> marketValues = rows.isEmpty() ? Map.of()
                : marketValuesFor(site, rows.get(0).time(), rows.get(rows.size() - 1).time());
        SlotEconomics economics = new SlotEconomics(siteEconomics(site), eegRates, marketValues,
                properties.defaultSupplyComponents());

        List<Double> importCt = new ArrayList<>(rows.size());
        List<Double> exportCt = new ArrayList<>(rows.size());
        for (SlotRow row : rows) {
            Double spot = toDouble(row.priceEurMwh());
            importCt.add(economics.importPriceCtKwh(spot));
            exportCt.add(economics.exportValueCtKwh(spot, row.time()));
        }
        List<Double> approxStoredCt = economics.storedEnergyValuesCtKwh(importCt, exportCt);

        // Fahrplan-Warum: prefer the PERSISTED exact stored-energy value (the
        // run's SoC shadow price, schedule.stored_value_ct_kwh); the forward
        // best-use heuristic remains only the fallback for pre-feature rows.
        // The run-level approximation flag is honest per run: false only when
        // every rendered slot carries the exact value.
        boolean anyApproximated = rows.isEmpty();
        List<OptimizerDiagnosticsSlotDto> slots = new ArrayList<>(rows.size());
        for (int i = 0; i < rows.size(); i++) {
            SlotRow row = rows.get(i);
            Double batteryKw = toDouble(row.batteryKw());
            Double gridKw = toDouble(row.gridKw());
            Double curtailKw = toDouble(row.curtailKw());
            String label = SlotEconomics.decisionLabel(batteryKw, gridKw,
                    toDouble(row.pvKw()), curtailKw);
            Double storedCt = toDouble(row.storedValueCtKwh());
            if (storedCt == null) {
                storedCt = approxStoredCt.get(i);
                anyApproximated = true;
            }
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
                    storedCt,
                    label,
                    SlotEconomics.whyText(label, batteryKw, gridKw, curtailKw,
                            importCt.get(i), exportCt.get(i), storedCt,
                            row.whyNextBest(), toDouble(row.whyNextBestMarginCt())),
                    row.slotRole(),
                    splitFlags(row.slotFlags()),
                    limitDischargeToLoad(batteryKw, gridKw)));
        }
        return dto(site, repo.planId(site.siteId(), run), run, day, firstRunDate, lastRunDate,
                availableRuns, priceSource, anyApproximated,
                repo.pvAnchorRatio(site.siteId(), run),
                repo.nightReserve(site.siteId(), run), slots);
    }

    /**
     * Whether this slot's SHAPE grants the REDUCE-only right
     * {@code limit_discharge_to_load} (Netz-null-Reduzieren, 2026-09-08): a real
     * planned discharge into a planned grid exchange of ~ 0.
     *
     * <p>DERIVED from the row's own two persisted numbers rather than read from
     * a column, because the flag is deliberately not persisted - and it can be,
     * because unlike its three siblings the rule reads NO price and NO lambda
     * (voltpilot_optimization/slot_trim.py {@code limit_discharge_to_load}: the
     * same deadbands, no economics). It therefore answers "did this slot qualify",
     * never "did the box get the flag" - see the DTO's Javadoc. Null when the
     * row carries no battery or grid power: an unknown shape makes no claim.
     */
    private static Boolean limitDischargeToLoad(Double batteryKw, Double gridKw) {
        if (batteryKw == null || gridKw == null) {
            return null;
        }
        return batteryKw < -PLANNED_DEADBAND_KW && Math.abs(gridKw) <= PLANNED_DEADBAND_KW;
    }

    /** The persisted binding CSV as a list (null stays null - pre-feature row). */
    private static List<String> splitFlags(String csv) {
        return csv == null || csv.isBlank() ? null : List.of(csv.split(","));
    }

    private static LocalDate berlinDay(Instant instant) {
        return instant.atZone(BERLIN).toLocalDate();
    }

    private OptimizerDiagnosticsDto dto(SiteContext site, UUID planId, Instant run,
            LocalDate availableRunsDate, LocalDate firstRunDate, LocalDate lastRunDate,
            List<Instant> availableRuns, String priceSource, boolean storedValueIsApproximation,
            BigDecimal pvAnchorRatio, BigDecimal[] nightReserve,
            List<OptimizerDiagnosticsSlotDto> slots) {
        return new OptimizerDiagnosticsDto(
                site.siteId(),
                planId,
                run,
                SLOT_MINUTES,
                availableRuns,
                availableRunsDate,
                firstRunDate,
                lastRunDate,
                site.plantKind(),
                site.netzladenErlaubt(),
                site.tarifArt(),
                site.tarifParamCtKwh(),
                site.anzulegenderWertCtKwh(),
                site.backupReserveSocPct(),
                batteryContext(site),
                activeLoadModel,
                activePvModel,
                priceSource,
                storedValueIsApproximation,
                pvAnchorRatio,
                nightReserve[0],
                nightReserve[1],
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
                wearCt,
                supplyPrice(site));
    }

    /** The site's structured supply-price sheet, or null without a row (the
     * legacy import model - mirrors inputs.load_battery_sites). */
    private static SlotEconomics.SupplyPrice supplyPrice(SiteContext site) {
        if (!site.hasSupplyPrice()) {
            return null;
        }
        return new SlotEconomics.SupplyPrice(
                toDouble(site.netzentgeltArbeitspreisCt()),
                toDouble(site.stromsteuerCt()),
                toDouble(site.konzessionsabgabeCt()),
                toDouble(site.umlagenCt()),
                toDouble(site.vertriebsaufschlagCt()),
                site.ustPct() != null ? site.ustPct().doubleValue() : 19.0);
    }

    Map<LocalDate, MarketValue> marketValuesFor(SiteContext site, Instant first, Instant last) {
        // Only DV sites with an anzulegender Wert in EEG mode can earn the
        // premium (pricing.py needs_market_values) - skip the query otherwise.
        boolean needed = !site.netzladenErlaubt()
                && "direktvermarktung".equals(site.plantKind())
                && site.anzulegenderWertCtKwh() != null;
        if (!needed) {
            return Map.of();
        }
        return repo.marketValues(SlotEconomics.berlinMonth(first), SlotEconomics.berlinMonth(last));
    }

    /**
     * The site's {@link SlotEconomics}, or {@code null} when RLS hides the site
     * (the caller then leaves its slots un-priced instead of guessing). The ONE
     * recomposition both the admin diagnostics and the customer Fahrplan read -
     * see {@link SchedulePricingService}.
     */
    public SlotEconomics economicsFor(UUID siteId, Instant first, Instant last) {
        SiteContext site = repo.siteContext(siteId);
        if (site == null) {
            return null;
        }
        return new SlotEconomics(siteEconomics(site), eegRates,
                marketValuesFor(site, first, last), properties.defaultSupplyComponents());
    }

    private static Double toDouble(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }
}
