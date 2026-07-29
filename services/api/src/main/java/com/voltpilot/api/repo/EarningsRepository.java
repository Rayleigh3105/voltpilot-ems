package com.voltpilot.api.repo;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.optimizer.SlotEconomics;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Realized-earnings aggregates for the current tenant: the section-3.2 math of
 * the fleet-overview plan over {@code telemetry_rollup_15m} x
 * {@code day_ahead_prices}. Per 15-min slot and site:
 *
 * <pre>
 *   baseline = greatest(load - pv, 0) * import_price   -- unregulated plant, battery idle:
 *            - greatest(pv - load, 0) * price/1000     -- residual imported at the tariff,
 *                                                      -- surplus fed in at spot (+ premium)
 *   actual   = grid_import_kwh * import_price - grid_export_kwh * price/1000
 *   saved    = baseline - actual
 * </pre>
 *
 * <p><b>Asymmetric pricing since Stufe 3 of the structured Bezugspreis
 * (report vp-nacht-bezug-e7 §3.4).</b> Grid IMPORT is valued at what the site
 * really pays per its tariff - the SAME composition the optimizer plans with
 * ({@link com.voltpilot.api.optimizer.SlotEconomics#importPriceCtSql}, the SQL
 * twin of pricing.py's {@code import_prices}): {@code fest} = the flat all-in
 * retail price, {@code dynamisch}/{@code ohne} with a maintained
 * {@code site_supply_price} sheet = {@code (spot + Σ Komponenten) × (1+USt)},
 * {@code dynamisch} without a sheet = spot + Aufschlag, and a site without any
 * price data stays at bare spot (byte-identical to the pre-Stufe-3 numbers;
 * the mirrored {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS} flag substitutes
 * the researched default set exactly like the solver). Export stays valued at
 * spot + Marktprämie (below). Because import ≠ export, the counterfactual is
 * no longer a pure aggregate: the baseline splits each 15-min slot into
 * {@code greatest(load - pv, 0)} import and {@code greatest(pv - load, 0)}
 * export - the same intra-slot approximation the premium crediting already
 * used, and the same sub-slot blindness every 15-min figure carries.
 *
 * <p><b>Historik-Semantik (documented v1 simplification):</b> every slot in
 * the window - however old - is valued at the CURRENTLY maintained tariff and
 * Preisblatt; there is no price-sheet history. A tariff change therefore
 * re-values the past under the new terms, exactly like the netzladen-flag and
 * Leistungspreis disciplines elsewhere in this class.
 *
 * <p>Under symmetric spot pricing, saved reduced to
 * {@code (battery_discharge_kwh - battery_charge_kwh) * price/1000} by the
 * rollups' power-balance identity ({@code battery = grid - load + pv},
 * migration V20260701030000). With a real tariff that shortcut no longer
 * holds; instead, load-shifting the battery performs against the tariff is
 * credited at its full avoided-import value, while pure sell-and-buy-back
 * spot churning loses its phantom contribution (a {@code fest} site's saved
 * carries no arbitrage at all - only shifted QUANTITIES count). Round-trip
 * losses still debit VoltPilot, so a badly-run battery shows NEGATIVE
 * savings.
 *
 * <p><b>Marktprämie (dynamic model, captain domain fix 2026-07-07).</b> The
 * premium of a direct-marketed EEG plant is NOT a fixed ct/kWh: fixed is the
 * plant's ANZULEGENDER WERT ({@code site.anzulegender_wert_ct_kwh}, migration
 * V20260707020000 - its EEG reference rate from the award /
 * Direktvermarktungsvertrag); the premium per exported kWh in month M is the
 * dynamic difference to that month's published Monatsmarktwert Solar
 * ({@code monthly_market_value}, fed by services/market-data from
 * netztransparenz.de, with a clearly-flagged PROVISIONAL value for months not
 * yet published):
 *
 * <pre>
 *   premium(M) = greatest(anzulegender_wert - monatsmarktwert_solar(M), 0)  [ct/kWh]
 *   baseline  -= greatest(pv_kwh - load_kwh, 0) * premium/100  -- immediate feed-in of the surplus
 *   actual    -= grid_export_kwh * premium/100                 -- the metered feed-in
 *   (both only when the slot price >= 0; months are Europe/Berlin calendar months)
 * </pre>
 *
 * <p>Negative-price slots keep the simplified §51-EEG rule: the law suspends
 * the premium over negative 4h/1h WINDOWS (rules changed for new plants in
 * 2023/2026); we apply it per 15-min spot slot. Crediting the baseline too
 * keeps the DELTA honest: storing PV instead of feeding it in forgoes premium
 * (a real cost of battery operation), and curtailment that avoids
 * negative-price feed-in shows its true value because neither side earns
 * premium in those slots anyway. The slot-level baseline export
 * {@code greatest(pv - load, 0)} is likewise an approximation: the rollup
 * cannot see sub-slot import/export interleaving of the counterfactual plant
 * (the same approximation the symmetric-pricing shortcut already makes exact
 * for the SPOT part).
 *
 * <p>An unconfigured anzulegender Wert (NULL, the default) contributes exactly
 * 0 to both sides - the pure-spot numbers are then unchanged. The same holds
 * for months WITHOUT a market-value row (feed not yet run): no premium is
 * credited rather than one invented. The DEPRECATED fixed
 * {@code site.marktpraemie_ct_kwh} (V20260706040000) is no longer read here.
 *
 * <p><b>Benchmark KPI (the DV selling point).</b> {@link SiteAggregate} also
 * carries the export-weighted realized price vs. the export-weighted
 * Monatsmarktwert over the same slots: "Sie haben X ct/kWh erzielt -
 * Monatsdurchschnitt Solar: Y ct". Beating Y is exactly what shifting feed-in
 * out of cheap solar hours delivers, so the two numbers make the value
 * tangible per range.
 *
 * <p>Every query runs through the RLS-scoped app datasource WITHOUT a tenant
 * predicate - RLS (migration V2) fences the tenant. {@code day_ahead_prices}
 * is public market data joined read-only per each site's OWN bidding zone.
 */
@Repository
public class EarningsRepository {

    /** Berlin days for the daily buckets (HistoryRange.ZONE). */
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /**
     * A slot is computable when the baseline channels (load/PV) AND the meter
     * channels (grid import/export) are present. Generation-only inverters
     * (Deye string/micro: no grid or load registers) never satisfy this - their
     * sites degrade honestly instead of summing garbage.
     */
    private static final String CHANNELS_OK =
            "r.load_kwh IS NOT NULL AND r.pv_kwh IS NOT NULL"
                    + " AND r.grid_import_kwh IS NOT NULL AND r.grid_export_kwh IS NOT NULL";

    /**
     * Matches a 15-min bucket to its day-ahead price slot in the SITE's bidding
     * zone: the stored slot (PT15M or PT60M) containing the bucket start,
     * preferring the finer resolution when both exist - the
     * HistoryRepository.PRICE_LATERAL approach, with the zone taken from the
     * joined site row instead of a parameter (each site prices in its own
     * zone, so multi-zone fleets sum correctly).
     */
    private static final String PRICE_LATERAL =
            "LEFT JOIN LATERAL ("
                    + "  SELECT p.price_eur_mwh FROM day_ahead_prices p"
                    + "  WHERE p.bidding_zone = s.bidding_zone AND p.ts <= r.bucket"
                    + "    AND p.ts + (CASE p.resolution WHEN 'PT60M' THEN INTERVAL '60 minutes'"
                    + "                ELSE INTERVAL '15 minutes' END) > r.bucket"
                    + "  ORDER BY (p.resolution = 'PT15M') DESC, p.ts DESC LIMIT 1"
                    + ") p ON true ";

    /** A slot enters the sums when its channels AND a price are present. */
    private static final String COVERED = CHANNELS_OK + " AND p.price_eur_mwh IS NOT NULL";

    /**
     * Joins a slot's German calendar month to its Monatsmarktwert Solar (the
     * table is market-wide - no tenant, no RLS - and tiny: twelve rows per
     * technology per year). Absent month = NULL = no premium for that slot.
     */
    private static final String MARKET_VALUE_JOIN =
            "LEFT JOIN monthly_market_value mv ON mv.technology = 'solar'"
                    + " AND mv.month = date_trunc('month', r.bucket AT TIME ZONE 'Europe/Berlin')::date ";

    /**
     * When a slot earns the Marktprämie: the site markets directly AND has an
     * anzulegender Wert configured AND the month's Monatsmarktwert is known AND
     * the slot's price is non-negative (the simplified §51-EEG rule - see the
     * class Javadoc). NULL anzulegender Wert => never eligible => both premium
     * terms are exactly 0 and the pure-spot numbers are unchanged.
     */
    private static final String PREMIUM_ELIGIBLE =
            "s.plant_kind = 'direktvermarktung' AND s.anzulegender_wert_ct_kwh IS NOT NULL"
                    + " AND mv.value_ct_kwh IS NOT NULL AND p.price_eur_mwh >= 0";

    /**
     * The month's dynamic premium in ct/kWh: anzulegender Wert minus
     * Monatsmarktwert Solar, floored at 0 (a market value above the reference
     * rate means no premium, never a negative one).
     */
    private static final String PREMIUM_RATE_CT =
            "GREATEST(s.anzulegender_wert_ct_kwh - mv.value_ct_kwh, 0)";

    /** Premium EUR earned by the slot's METERED export (the actual side). */
    private static final String ACTUAL_PREMIUM_EUR =
            "(CASE WHEN " + PREMIUM_ELIGIBLE
                    + " THEN r.grid_export_kwh * " + PREMIUM_RATE_CT + " / 100 ELSE 0 END)";

    /**
     * Premium EUR the UNREGULATED plant would earn: it feeds its PV surplus in
     * immediately, so its export is {@code greatest(pv - load, 0)} per slot.
     */
    private static final String BASELINE_PREMIUM_EUR =
            "(CASE WHEN " + PREMIUM_ELIGIBLE
                    + " THEN GREATEST(r.pv_kwh - r.load_kwh, 0) * " + PREMIUM_RATE_CT + " / 100"
                    + " ELSE 0 END)";

    /**
     * Feed-in revenue of a slot (the Einspeise-Erlös): the metered export valued
     * at spot PLUS the Marktprämie on that export. Positive = money earned; can
     * be slightly negative in a negative-price hour (feeding in then costs), which
     * is honest.
     */
    private static final String EINSPEISE_ERLOES_EUR =
            "(r.grid_export_kwh * p.price_eur_mwh / 1000 + " + ACTUAL_PREMIUM_EUR + ")";

    /**
     * Self-consumed energy of a slot: the part of the load NOT drawn from the
     * grid (covered by own PV directly or from the battery). Floored at 0.
     */
    private static final String SELBSTVERBRAUCH_KWH =
            "GREATEST(r.load_kwh - r.grid_import_kwh, 0)";

    /**
     * The euro value of a slot's self-consumed energy, per the site's tariff
     * (captain 2026-07-08, migration V20260708010000):
     * <ul>
     * <li><b>dynamisch</b>: self-consumed kWh valued at THIS slot's Börsenpreis
     * plus the optional fixed Aufschlag - the whole point of the dynamic model,
     * exact per 15-min slot, never a single fixed price. A null Aufschlag values
     * at pure spot (honest, conservative). Note the spot part can be negative in
     * a negative-price slot; that is the correct dynamic-tariff economics (the
     * §51 suspension is a FEED-IN/Marktprämie rule, not a self-consumption one).</li>
     * <li><b>fest</b>: self-consumed kWh valued at the fixed retail price (the
     * old strompreis behaviour); NULL when no price is configured.</li>
     * <li><b>ohne</b>: NULL - no euro value (self-consumption shown in kWh only).</li>
     * </ul>
     * price is EUR/MWh, so {@code price/1000} is EUR/kWh and the Aufschlag
     * ({@code ct/kWh}) divides by 100. Within {@code COVERED} the price is never
     * null, so the dynamic branch is always well-defined.
     */
    private static final String EIGENVERBRAUCHS_WERT_EUR =
            "(CASE"
                    + " WHEN s.tarif_art = 'dynamisch' THEN " + SELBSTVERBRAUCH_KWH
                    + "   * (p.price_eur_mwh / 1000.0 + COALESCE(s.tarif_param_ct_kwh, 0) / 100.0)"
                    + " WHEN s.tarif_art = 'fest' AND s.tarif_param_ct_kwh IS NOT NULL THEN "
                    + SELBSTVERBRAUCH_KWH + " * s.tarif_param_ct_kwh / 100.0"
                    + " ELSE NULL END)";

    /** Energy moved through the battery in a slot (charged + discharged). */
    private static final String BATTERIE_BEWEGT_KWH =
            "(COALESCE(r.battery_charge_kwh, 0) + COALESCE(r.battery_discharge_kwh, 0))";

    /** The supply-price sheet join every import valuation needs (fixed
     * {@code ssp} alias, the importPriceCtSql contract). */
    private static final String SUPPLY_PRICE_JOIN =
            "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id ";

    private final JdbcTemplate jdbc;

    /**
     * The slot's import price in EUR/kWh - the ONE composition truth
     * ({@link SlotEconomics#importPriceCtSql}), built once at construction
     * with the mirrored {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS} flag so
     * display and solver read the identical flag semantics.
     */
    private final String importPriceEurKwh;

    /** Baseline EUR of one covered slot (see the class Javadoc formula). */
    private final String baselineEur;

    /** Actual EUR of one covered slot (see the class Javadoc formula). */
    private final String actualEur;

    /** Saved EUR of one covered slot ({@code baseline - actual}, expanded). */
    private final String savedEur;

    /** The tarifPricedSql boolean for this flag setting (see {@link #tarifPriced}). */
    private final String tarifPricedExpr;

    public EarningsRepository(JdbcTemplate jdbc, OptimizerProperties optimizer) {
        this.jdbc = jdbc;
        this.importPriceEurKwh = "(" + SlotEconomics.importPriceCtSql(
                "p.price_eur_mwh", optimizer.defaultSupplyComponents()) + " / 100.0)";
        this.baselineEur = "(GREATEST(r.load_kwh - r.pv_kwh, 0) * " + importPriceEurKwh
                + " - GREATEST(r.pv_kwh - r.load_kwh, 0) * p.price_eur_mwh / 1000"
                + " - " + BASELINE_PREMIUM_EUR + ")";
        this.actualEur = "(r.grid_import_kwh * " + importPriceEurKwh
                + " - r.grid_export_kwh * p.price_eur_mwh / 1000"
                + " - " + ACTUAL_PREMIUM_EUR + ")";
        this.savedEur = "((GREATEST(r.load_kwh - r.pv_kwh, 0) - r.grid_import_kwh) * "
                + importPriceEurKwh
                + " - (GREATEST(r.pv_kwh - r.load_kwh, 0) - r.grid_export_kwh)"
                + "   * p.price_eur_mwh / 1000"
                + " + " + ACTUAL_PREMIUM_EUR + " - " + BASELINE_PREMIUM_EUR + ")";
        this.tarifPricedExpr = SlotEconomics.tarifPricedSql(optimizer.defaultSupplyComponents());
    }

    /**
     * One site's aggregate over a window. {@code bucketCount} counts ALL rollup
     * buckets in the window, {@code channelBuckets} those with computable
     * channels, {@code coveredSlots} those that also found a price - the three
     * tiers let the caller derive an honest non-computability reason. Money
     * sums and {@code firstCovered} span covered slots only.
     *
     * <p>The benchmark KPI fields are export-weighted averages over the same
     * covered slots: {@code realizedExportCtKwh} = the spot price the site's
     * metered feed-in actually fetched; {@code marketValueSolarCtKwh} = the
     * Monatsmarktwert Solar weighted with the SAME exports (so a range spanning
     * months compares like with like); {@code marketValueProvisional} = true
     * when any contributing month's value is still the provisional
     * approximation. All three are null when the window has no exported energy
     * (or no market-value rows) - never a fake zero.
     */
    public record SiteAggregate(
            long bucketCount,
            long channelBuckets,
            long coveredSlots,
            BigDecimal baselineEur,
            BigDecimal actualEur,
            Instant firstCovered,
            BigDecimal realizedExportCtKwh,
            BigDecimal marketValueSolarCtKwh,
            Boolean marketValueProvisional,
            BigDecimal einspeiseErloesEur,
            BigDecimal eigenverbrauchsWertEur,
            BigDecimal selbstverbrauchKwh,
            BigDecimal eingespeistKwh,
            BigDecimal batterieBewegtKwh) {
    }

    /**
     * One time bucket of the money-centric Meine-Anlage view: the parts of the
     * Gesamtertrag over the bucket - {@code einspeiseErloesEur} (metered export
     * valued at spot + Marktprämie) and {@code eigenverbrauchsWertEur} (the
     * self-consumed energy valued per the site's tariff, dynamisch slot-by-slot
     * at spot + Aufschlag). Both are summed per slot in SQL, so a dynamic tariff
     * is priced with each slot's own Börsenpreis; {@code eigenverbrauchsWertEur}
     * is NULL for an {@code ohne} tariff (never a fabricated euro). The
     * Gesamtertrag ({@code einspeise + eigenverbrauchsWert}, null-safe) is
     * assembled in the controller.
     */
    public record BucketPoint(
            Instant start,
            BigDecimal einspeiseErloesEur,
            BigDecimal eigenverbrauchsWertEur) {
    }

    /** One Europe/Berlin day of realized savings of one site. */
    public record DailySaved(LocalDate day, BigDecimal savedEur) {
    }

    /**
     * The FORWARD-looking expected Marktwert Solar of one site (captain
     * decision 2026-07-09): a plant-specific, production-weighted average
     * day-ahead price over the future horizon -
     *
     * <pre>
     *   erwarteter Marktwert Solar = Σ(price(t) × pv_forecast(t)) / Σ(pv_forecast(t))
     * </pre>
     *
     * in {@code ctKwh} (same unit as the realized {@code marketValueSolarCtKwh}),
     * over the slots {@code [from, to]} ({@code slots} of them) where BOTH a
     * day-ahead price AND this site's PV forecast exist. This is the forward
     * companion to the realized/backward benchmark - it says what the market
     * VALUES this site's coming production, weighted by when it will actually
     * produce (not by a generic clear-sky shape like the Germany-wide
     * provisional value). Null (absent from the map) when there is no forward
     * PV forecast or no forward price coverage - never a fabricated figure.
     */
    public record ExpectedMarketValue(
            BigDecimal ctKwh, Instant from, Instant to, long slots) {
    }

    /**
     * The grid-charging (arbitrage) attribution of one netzladen-erlaubt site
     * over a window: {@code arbitrageEur} is the part of the site's saved that
     * the grid-charging permission concretely earned, {@code gridChargedKwh}
     * the grid-charged energy that backs it. Only sites with
     * {@code gridChargedKwh > 0} appear in the result - a range without grid
     * charging has no defensible arbitrage number, so the split stays absent
     * (null in the DTO), never a fake zero.
     */
    public record ArbitrageSplit(BigDecimal arbitrageEur, BigDecimal gridChargedKwh) {
    }

    /**
     * The per-site earnings aggregate over {@code [from, to)}. Sites without
     * any rollup bucket in the window are absent from the map.
     */
    public Map<UUID, SiteAggregate> aggregate(Instant from, Instant to) {
        Map<UUID, SiteAggregate> result = new HashMap<>();
        // The benchmark averages weight by EXPORTED energy: realized ct/kWh
        // over priced covered slots (EUR/MWh / 10 = ct/kWh), the market value
        // over the covered slots whose month HAS one - separate denominators,
        // so a missing market-value month degrades the benchmark but never the
        // realized number.
        String exportKwh = "sum(r.grid_export_kwh) FILTER (WHERE " + COVERED + ")";
        String mvFilter = COVERED + " AND mv.value_ct_kwh IS NOT NULL";
        jdbc.query(
                "SELECT r.site_id,"
                        + " count(*) AS bucket_count,"
                        + " count(*) FILTER (WHERE " + CHANNELS_OK + ") AS channel_buckets,"
                        + " count(*) FILTER (WHERE " + COVERED + ") AS covered_slots,"
                        + " sum(" + baselineEur + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS baseline_eur,"
                        + " sum(" + actualEur + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS actual_eur,"
                        + " min(r.bucket) FILTER (WHERE " + COVERED + ") AS first_covered,"
                        + " sum(r.grid_export_kwh * p.price_eur_mwh / 10)"
                        + "   FILTER (WHERE " + COVERED + ")"
                        + "   / NULLIF(" + exportKwh + ", 0) AS realized_export_ct,"
                        + " sum(r.grid_export_kwh * mv.value_ct_kwh)"
                        + "   FILTER (WHERE " + mvFilter + ")"
                        + "   / NULLIF(sum(r.grid_export_kwh) FILTER (WHERE " + mvFilter + "), 0)"
                        + "   AS market_value_ct,"
                        + " bool_or(mv.provisional)"
                        + "   FILTER (WHERE " + mvFilter + " AND r.grid_export_kwh > 0)"
                        + "   AS market_value_provisional,"
                        + " sum(" + EINSPEISE_ERLOES_EUR + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS einspeise_erloes_eur,"
                        + " sum(" + EIGENVERBRAUCHS_WERT_EUR + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS eigenverbrauchs_wert_eur,"
                        + " sum(" + SELBSTVERBRAUCH_KWH + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS selbstverbrauch_kwh,"
                        + " sum(r.grid_export_kwh)"
                        + "   FILTER (WHERE " + COVERED + ") AS eingespeist_kwh,"
                        + " sum(" + BATTERIE_BEWEGT_KWH + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS batterie_bewegt_kwh "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + SUPPLY_PRICE_JOIN
                        + PRICE_LATERAL
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ? "
                        + "GROUP BY r.site_id",
                rs -> {
                    Timestamp firstCovered = rs.getTimestamp("first_covered");
                    BigDecimal marketValueCt = rs.getBigDecimal("market_value_ct");
                    Object provisional = rs.getObject("market_value_provisional");
                    result.put(rs.getObject("site_id", UUID.class), new SiteAggregate(
                            rs.getLong("bucket_count"),
                            rs.getLong("channel_buckets"),
                            rs.getLong("covered_slots"),
                            rs.getBigDecimal("baseline_eur"),
                            rs.getBigDecimal("actual_eur"),
                            firstCovered == null ? null : firstCovered.toInstant(),
                            rs.getBigDecimal("realized_export_ct"),
                            marketValueCt,
                            marketValueCt == null ? null
                                    : provisional != null && (Boolean) provisional,
                            rs.getBigDecimal("einspeise_erloes_eur"),
                            rs.getBigDecimal("eigenverbrauchs_wert_eur"),
                            rs.getBigDecimal("selbstverbrauch_kwh"),
                            rs.getBigDecimal("eingespeist_kwh"),
                            rs.getBigDecimal("batterie_bewegt_kwh")));
                },
                Timestamp.from(from), Timestamp.from(to));
        return result;
    }

    /**
     * Which of the tenant's sites are valued beyond bare spot on the import
     * side ({@code true} = "bewertet zu Ihrem Stromtarif": a flat/dynamic
     * tariff parameter, a maintained {@code site_supply_price} sheet, or the
     * default-components flag engaged) - the honest labeling context the
     * portal's provenance sentences need, because the {@code tarifArt} echo
     * alone cannot tell an {@code ohne} site with a maintained Preisblatt
     * from one without. Same branch conditions as the price expression
     * ({@link SlotEconomics#tarifPricedSql}). RLS-fenced like every read here.
     */
    public Map<UUID, Boolean> tarifPriced() {
        Map<UUID, Boolean> result = new HashMap<>();
        jdbc.query(
                "SELECT s.id, " + tarifPricedExpr + " AS tarif_priced "
                        + "FROM site s " + SUPPLY_PRICE_JOIN,
                rs -> {
                    result.put(rs.getObject("id", UUID.class), rs.getBoolean("tarif_priced"));
                });
        return result;
    }

    /**
     * The "davon Arbitrage-Gewinn" split (captain pick 2026-07-07): how much of
     * a grid-charging site's saved the {@code netzladen_erlaubt} permission
     * concretely earned. Computed with the STORAGE-MIX model - a deterministic
     * one-pass walk over the site's covered 15-min slots in time order,
     * carrying the battery's content as two pools (pv-charged vs grid-charged
     * kWh):
     *
     * <pre>
     *   per slot (charge applied before discharge):
     *     gridCharge = max(0, charge_kwh - max(pv_kwh - load_kwh, 0))
     *     pvCharge   = charge_kwh - gridCharge          -&gt; pools grow
     *     discharge draws PROPORTIONALLY from the current pool mix
     *   arbitrageEur = sum(gridDrawnDischarge * price/1000)   -- revenue of grid content
     *                - sum(gridCharge * price/1000)           -- its purchase cost
     * </pre>
     *
     * <p>The PV-shift part is deliberately NOT computed here: the caller takes
     * it as the remainder {@code saved - arbitrage}, so the two parts reconcile
     * with the total EXACTLY, by construction (both draw shares and charge
     * splits partition the slot quantities the saved formula sums).
     *
     * <p>Documented assumptions of the attribution (the fine print's one
     * sentence is the customer-facing version of these):
     * <ul>
     * <li><b>Pre-window content counts as solar.</b> The pools start empty at
     * the window start; discharge exceeding the tracked content is attributed
     * to the PV side. Conservative: arbitrage is never inflated by energy whose
     * origin the window cannot see.</li>
     * <li><b>Round-trip losses debit both pools proportionally.</b> Cumulative
     * discharge is smaller than cumulative charge, so residual (lost) content
     * lingers in the pools in proportion to each pool's charging; its purchase
     * cost was debited at charge time and never earns discharge revenue - each
     * strategy pays its own losses.</li>
     * <li><b>Slot granularity.</b> Sub-slot interleaving (charging from PV
     * early in a quarter hour, from grid late) is invisible to the rollups;
     * the {@code max(0, charge - surplus)} split is the slot-level best
     * estimate - the same granularity the saved total already lives at.</li>
     * <li><b>The Marktprämie stays on the PV side.</b> Grid-charged energy is
     * never premium-eligible (it is not EEG generation), so the premium delta
     * inside saved belongs entirely to the remainder; arbitrage is pure spot.</li>
     * <li><b>The flag is read at query time.</b> Slots that predate a flag
     * flip are attributed under the CURRENT mode - historical mode tracking is
     * out of scope (a freshly-permitted site simply has no grid-charged slots
     * in its past, so this only matters after a permission is REVOKED).</li>
     * <li><b>The split's valuation stays at bare spot (v1, Stufe 3).</b>
     * Grid-charge purchase cost and grid-content discharge revenue are both
     * spot-priced even though the saved TOTAL now values import at the
     * structured tariff: attributing the tariff components would need to know
     * whether each discharged kWh avoided import or was exported, which the
     * pool walk does not track. The remainder construction keeps
     * {@code arbitrage + pvShift == saved} exact regardless; netzladen sites
     * are typically spot-settled merchants, where the two models coincide.</li>
     * </ul>
     *
     * <p>Only covered slots (channels + price) enter the walk - the same
     * filter the saved total uses, so the parts and the total describe the
     * same slot set. Sites whose window contains no grid-charged energy are
     * absent from the map (see {@link ArbitrageSplit}).
     */
    public Map<UUID, ArbitrageSplit> arbitrageSplit(Instant from, Instant to) {
        Map<UUID, ArbitrageSplit> result = new HashMap<>();
        // One mutable walk state; rows arrive ordered by (site_id, bucket), so
        // a site change closes the previous site's split.
        var state = new Object() {
            UUID site;
            double pvPool;
            double gridPool;
            double arbitrageEur;
            double gridChargedKwh;

            void finish() {
                if (site != null && gridChargedKwh > 0) {
                    result.put(site, new ArbitrageSplit(
                            BigDecimal.valueOf(arbitrageEur),
                            BigDecimal.valueOf(gridChargedKwh)));
                }
            }

            void reset(UUID next) {
                site = next;
                pvPool = 0;
                gridPool = 0;
                arbitrageEur = 0;
                gridChargedKwh = 0;
            }
        };
        jdbc.query(
                "SELECT r.site_id,"
                        + " COALESCE(r.battery_charge_kwh, 0) AS charge_kwh,"
                        + " COALESCE(r.battery_discharge_kwh, 0) AS discharge_kwh,"
                        + " GREATEST(COALESCE(r.pv_kwh - r.load_kwh, 0), 0) AS pv_surplus_kwh,"
                        + " p.price_eur_mwh "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id AND s.netzladen_erlaubt "
                        + PRICE_LATERAL
                        + "WHERE r.bucket >= ? AND r.bucket < ? AND " + COVERED + " "
                        + "ORDER BY r.site_id, r.bucket",
                rs -> {
                    UUID siteId = rs.getObject("site_id", UUID.class);
                    if (!siteId.equals(state.site)) {
                        state.finish();
                        state.reset(siteId);
                    }
                    double charge = rs.getDouble("charge_kwh");
                    double discharge = rs.getDouble("discharge_kwh");
                    double surplus = rs.getDouble("pv_surplus_kwh");
                    double price = rs.getDouble("price_eur_mwh");

                    double gridCharge = Math.max(0, charge - surplus);
                    state.gridPool += gridCharge;
                    state.pvPool += charge - gridCharge;
                    state.gridChargedKwh += gridCharge;
                    state.arbitrageEur -= gridCharge * price / 1000.0;

                    double content = state.gridPool + state.pvPool;
                    if (discharge > 0 && content > 0) {
                        double drawn = Math.min(discharge, content);
                        double fromGrid = drawn * state.gridPool / content;
                        state.gridPool = Math.max(0, state.gridPool - fromGrid);
                        state.pvPool = Math.max(0, state.pvPool - (drawn - fromGrid));
                        state.arbitrageEur += fromGrid * price / 1000.0;
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        state.finish();
        return result;
    }

    /**
     * Realized savings per site and Europe/Berlin day over {@code [from, to)}
     * (the hero's spark bars + the "Heute" teasers). Only covered slots count;
     * days without one are absent - never a fake zero.
     */
    public Map<UUID, List<DailySaved>> dailySavedPerSite(Instant from, Instant to) {
        Map<UUID, List<DailySaved>> result = new HashMap<>();
        jdbc.query(
                "SELECT r.site_id, time_bucket('1 day', r.bucket, 'Europe/Berlin') AS day,"
                        // saved = baseline - actual (import at the tariff,
                        // export at spot, incl. the premium delta).
                        + " sum(" + savedEur + ") AS saved_eur "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + SUPPLY_PRICE_JOIN
                        + PRICE_LATERAL
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ? AND " + COVERED + " "
                        + "GROUP BY 1, 2 ORDER BY 1, 2",
                rs -> {
                    BigDecimal saved = rs.getBigDecimal("saved_eur");
                    if (saved != null) {
                        result.computeIfAbsent(rs.getObject("site_id", UUID.class),
                                        k -> new ArrayList<>())
                                .add(new DailySaved(
                                        rs.getTimestamp("day").toInstant().atZone(ZONE).toLocalDate(),
                                        saved));
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        return result;
    }

    /**
     * The forward expected Marktwert Solar per site (see
     * {@link ExpectedMarketValue}): the site's coming PV production valued at
     * the day-ahead price, production-weighted, over the forward horizon from
     * {@code now}.
     *
     * <p>For each site the LATEST stored run of the ACTIVE PV model
     * ({@code pvModel}) is taken (shadow challengers are never consumed - same
     * rule as the optimizer's {@code inputs.py}); its future slots
     * ({@code time >= now}) are joined to the day-ahead price of the site's OWN
     * bidding zone with the {@link #PRICE_LATERAL} matching (PT15M preferred,
     * PT60M fallback). The weighted average
     * {@code Σ(price × pv) / Σ(pv)} is EUR/MWh; {@code / 10} converts to ct/kWh.
     * The forecast is in POWER (kW, the {@code forecast.value_kw} the optimizer
     * reads); the constant 15-min slot length cancels in the weighted average,
     * so weighting by power gives the identical result to weighting by energy.
     *
     * <p>The forecast table carries NO RLS (backend-only consumers), so the
     * JOIN to the RLS-scoped {@code site} table is what fences the query to the
     * caller's tenant - the same technique the realized aggregates use.
     * Negative-price slots are included (they legitimately pull the expected
     * value down); zero-production night slots contribute 0 to both sums and so
     * never distort the weighting. Sites without a future forecast slot, or
     * whose forward slots find no price, are ABSENT from the map (their
     * {@code Σ(pv)} is 0 -> the value is NULL -> the row is dropped) - never a
     * fake zero.
     */
    public Map<UUID, ExpectedMarketValue> expectedMarketValue(String pvModel, Instant now) {
        Map<UUID, ExpectedMarketValue> result = new HashMap<>();
        jdbc.query(
                "WITH latest_run AS ("
                        + "  SELECT f.site_id, max(f.run_at) AS run_at"
                        + "  FROM forecast f JOIN site s ON s.id = f.site_id"
                        + "  WHERE f.kind = 'pv' AND f.model = ?"
                        + "  GROUP BY f.site_id"
                        + "), fc AS ("
                        + "  SELECT f.site_id, f.time, f.value_kw"
                        + "  FROM forecast f"
                        + "  JOIN latest_run lr ON lr.site_id = f.site_id AND lr.run_at = f.run_at"
                        + "  WHERE f.kind = 'pv' AND f.model = ? AND f.time >= ? AND f.value_kw >= 0"
                        + ") "
                        + "SELECT fc.site_id,"
                        + " sum(p.price_eur_mwh * fc.value_kw) / NULLIF(sum(fc.value_kw), 0) / 10"
                        + "   AS expected_ct,"
                        + " count(*) AS slots, min(fc.time) AS from_ts, max(fc.time) AS to_ts "
                        + "FROM fc "
                        + "JOIN site s ON s.id = fc.site_id "
                        + "JOIN LATERAL ("
                        + "  SELECT p.price_eur_mwh FROM day_ahead_prices p"
                        + "  WHERE p.bidding_zone = s.bidding_zone AND p.ts <= fc.time"
                        + "    AND p.ts + (CASE p.resolution WHEN 'PT60M' THEN INTERVAL '60 minutes'"
                        + "                ELSE INTERVAL '15 minutes' END) > fc.time"
                        + "  ORDER BY (p.resolution = 'PT15M') DESC, p.ts DESC LIMIT 1"
                        + ") p ON true "
                        + "GROUP BY fc.site_id",
                rs -> {
                    BigDecimal ct = rs.getBigDecimal("expected_ct");
                    if (ct == null) {
                        // All forward slots have zero PV production (or no
                        // priced forward slot survived the join) - no defensible
                        // expected value, so drop the site.
                        return;
                    }
                    result.put(rs.getObject("site_id", UUID.class), new ExpectedMarketValue(
                            ct,
                            rs.getTimestamp("from_ts").toInstant(),
                            rs.getTimestamp("to_ts").toInstant(),
                            rs.getLong("slots")));
                },
                pvModel, pvModel, Timestamp.from(now));
        return result;
    }

    /** The bucket width of a {@link #bucketed} series (a safe SQL date_trunc unit). */
    public enum Bucket {
        HOUR("hour"),
        DAY("day"),
        MONTH("month");

        private final String unit;

        Bucket(String unit) {
            this.unit = unit;
        }
    }

    /**
     * The per-site Gesamtertrag parts bucketed by Europe/Berlin hour/day/month
     * over {@code [from, to)} - feeds the money-centric view's Ertrag chart
     * (hour for the day range, day for the month range, month for the year/all
     * ranges) AND the 12-month strip (month buckets over the last year).
     *
     * <p>Only covered slots (channels + price) enter a bucket, exactly like the
     * money sums, so the series and the totals describe the same slot set. The
     * bucket start is the Europe/Berlin calendar bucket start as a proper
     * instant ({@code date_trunc(...) AT TIME ZONE 'Europe/Berlin'} - guaranteed
     * correct across DST and month lengths, no TimescaleDB month-bucket
     * dependency). The bucket unit is a fixed enum literal, never client input.
     */
    public Map<UUID, List<BucketPoint>> bucketed(Instant from, Instant to, Bucket bucket) {
        Map<UUID, List<BucketPoint>> result = new HashMap<>();
        String start = "(date_trunc('" + bucket.unit
                + "', r.bucket AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin')";
        jdbc.query(
                "SELECT r.site_id, " + start + " AS bucket_start,"
                        + " sum(" + EINSPEISE_ERLOES_EUR + ") AS einspeise_erloes_eur,"
                        + " sum(" + EIGENVERBRAUCHS_WERT_EUR + ") AS eigenverbrauchs_wert_eur "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + PRICE_LATERAL
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ? AND " + COVERED + " "
                        + "GROUP BY r.site_id, bucket_start ORDER BY r.site_id, bucket_start",
                rs -> {
                    result.computeIfAbsent(rs.getObject("site_id", UUID.class),
                                    k -> new ArrayList<>())
                            .add(new BucketPoint(
                                    rs.getTimestamp("bucket_start").toInstant(),
                                    rs.getBigDecimal("einspeise_erloes_eur"),
                                    rs.getBigDecimal("eigenverbrauchs_wert_eur")));
                },
                Timestamp.from(from), Timestamp.from(to));
        return result;
    }
}
