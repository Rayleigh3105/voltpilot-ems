package com.voltpilot.api.repo;

import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.optimizer.SlotEconomics;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Duration;
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
 *            - greatest(pv - load, 0) * export_value   -- residual imported at the tariff,
 *                                                      -- surplus fed in at the export value
 *   actual   = grid_import_kwh * import_price - grid_export_kwh * export_value
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
 * the researched default set exactly like the solver). Since captain decision
 * E7 (2026-09-02) the {@code eigenverbrauchsWertEur} - the AVOIDED import -
 * reads the very same expression, so one card carries ONE import price
 * ({@link #eigenverbrauchsWertEurSql(boolean)}). Because import ≠
 * export, the counterfactual is no longer a pure aggregate: the baseline
 * splits each 15-min slot into {@code greatest(load - pv, 0)} import and
 * {@code greatest(pv - load, 0)} export - the same intra-slot approximation
 * the premium crediting already used, and the same sub-slot blindness every
 * 15-min figure carries.
 *
 * <p><b>Export is valued per the plant's remuneration since the B2 fix
 * (audit vp-geldzahlen-audit-x7).</b> Every export term (Einspeise-Erlös, the
 * metered export inside {@code actual}, the residual export inside
 * {@code baseline}) applies the ONE export composition
 * ({@link SlotEconomics#exportValueCtSql}, the SQL twin of
 * {@code SlotEconomics.exportValueCtKwh} = pricing.py's
 * {@code export_values}): a non-grid-charging {@code eigenverbrauch} plant
 * with a known, unexpired commissioning date earns its FESTE
 * EEG-Einspeisevergütung ({@link EegRates}, tranche-blended by kWp; §51a
 * zeroes it in negative-price slots for plants commissioned on/after
 * 2025-02-25) - before the fix those customers saw bare spot, incl. negative
 * "revenue" a fixed remuneration never has. Direktvermarktung stays
 * byte-identical at spot + Marktprämie (below); a plant whose remuneration
 * cannot be determined (no commissioned pv asset) honestly stays at bare
 * spot, never a guessed rate. Because the SAME per-slot rate values the
 * metered AND the residual export, the identities
 * {@code saved == baseline - actual} and
 * {@code stromkosten - einspeise == actual} keep holding exactly.
 * {@code exportVerguetungPriced} (the {@code tarifPriced} sibling) tells the
 * portal which valuation engaged.
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
     * The price series of every zone the tenant's sites price in, materialized
     * once per query over the queried window - see {@link PriceSlots} for the
     * why (this class ran the old per-bucket lateral FIVE times per
     * {@code /earnings} request) and for the proof that the slot choice is
     * identical. Binds: window start, window end.
     */
    private static final String PRICE_SLOT_CTE = PriceSlots.forTenantZones();

    /**
     * Matches a 15-min bucket (alias {@code r}) to its day-ahead price slot in
     * the SITE's bidding zone: the stored slot (PT15M or PT60M) containing the
     * bucket start, preferring the finer resolution when both exist. The zone
     * comes from the joined site row, so a multi-zone fleet sums correctly.
     */
    private static final String PRICE_JOIN =
            "LEFT JOIN price_slot p"
                    + " ON p.bidding_zone = s.bidding_zone AND p.slot = r.bucket ";

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

    /**
     * Premium EUR earned by the slot's METERED export (the actual side) - the
     * {@code marktpraemieEur} provenance sum. The premium inside the money
     * terms themselves now travels IN {@link #exportValueEurKwh} (the same
     * eligibility + rate, so the two can never disagree); this constant only
     * reports the contained premium separately.
     */
    private static final String ACTUAL_PREMIUM_EUR =
            "(CASE WHEN " + PREMIUM_ELIGIBLE
                    + " THEN r.grid_export_kwh * " + PREMIUM_RATE_CT + " / 100 ELSE 0 END)";

    /**
     * Self-consumed energy of a slot: the part of the load NOT drawn from the
     * grid (covered by own PV directly or from the battery). Floored at 0.
     */
    private static final String SELBSTVERBRAUCH_KWH =
            "GREATEST(r.load_kwh - r.grid_import_kwh, 0)";

    /**
     * The euro value of a slot's self-consumed energy - the AVOIDED grid
     * supply cost, and therefore the SAME price truth the metered import is
     * valued at ({@link SlotEconomics#importPriceCtSql}; captain decision E7
     * of 2026-09-02, concept vp-erloese-seite-konzept-e2 §2.3 finding B5).
     *
     * <p>Until then this expression carried its OWN composition
     * ({@code dynamisch} = spot + Aufschlag, {@code fest} = the flat price,
     * everything else NULL) and knew neither the {@code site_supply_price}
     * sheet, nor USt, nor the researched default set behind
     * {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS}. On one and the same card
     * the identical kWh was worth ~30 ct as consumption and ~15 ct as avoided
     * consumption, and a tariff-less plant on the production default showed no
     * euro value at all while its supply cost was fully valued - so its
     * Netto-Ergebnis read systematically too low. There is now ONE import
     * price per card: {@code selbstverbrauch × importPrice}, and the existing
     * {@link #tarifPriced} flag says honestly whether that price is the
     * customer's tariff or bare Börsenpreis.
     *
     * <p>Nothing else moved: {@code baseline}/{@code actual}/{@code saved} have
     * valued avoided import at this composition since Stufe 3, so
     * {@code saved == baseline - actual} and
     * {@code stromkosten - einspeise == actual} are untouched, and
     * {@code netto == einspeise + eigenverbrauch - stromkosten} now reconciles
     * across ONE price. The visible consequence (release note): plants with a
     * maintained Preisblatt, plants on the default set and tariff-less plants
     * see a HIGHER Eigenverbrauchs-Wert - and thus a higher Netto and
     * Gesamtertrag - than before.
     *
     * <p>{@code importPriceCtSql} is ct/kWh, hence the {@code / 100.0}; within
     * {@code COVERED} the slot price is never null, so every spot-dependent
     * branch is well-defined.
     */
    public static String eigenverbrauchsWertEurSql(boolean defaultSupplyComponents) {
        return "(" + SELBSTVERBRAUCH_KWH + " * "
                + SlotEconomics.importPriceCtSql("p.price_eur_mwh", defaultSupplyComponents)
                + " / 100.0)";
    }

    /** Energy moved through the battery in a slot (charged + discharged). */
    private static final String BATTERIE_BEWEGT_KWH =
            "(COALESCE(r.battery_charge_kwh, 0) + COALESCE(r.battery_discharge_kwh, 0))";

    /** The supply-price sheet join every import valuation needs (fixed
     * {@code ssp} alias, the importPriceCtSql contract). */
    private static final String SUPPLY_PRICE_JOIN =
            "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id ";

    /**
     * The PRIMARY pv asset join every export valuation needs (fixed {@code pv}
     * alias, the exportValueCtSql contract - the MaStR commissioning date +
     * kWp feed the feste-Vergütung branch). The partial unique index
     * {@code uq_asset_site_type_primary} guarantees at most one row per site,
     * so the join can never fan a slot out.
     */
    private static final String PV_ASSET_JOIN =
            "LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' AND pv.is_primary ";

    private final JdbcTemplate jdbc;

    /**
     * The slot's import price in EUR/kWh - the ONE composition truth
     * ({@link SlotEconomics#importPriceCtSql}), built once at construction
     * with the mirrored {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS} flag so
     * display and solver read the identical flag semantics.
     */
    private final String importPriceEurKwh;

    /**
     * The slot's export value in EUR/kWh - the ONE export composition
     * ({@link SlotEconomics#exportValueCtSql}, B2 fix): spot + Marktprämie for
     * Direktvermarktung, the feste EEG-Vergütung for an unexpired
     * {@code eigenverbrauch} plant (§51a-aware per slot), bare spot otherwise.
     * Built once at construction from the SAME {@code OPTIMIZER_EEG_RATES_JSON}
     * schedule the solver reads, so a rate correction never makes the card lie.
     */
    private final String exportValueEurKwh;

    /**
     * Feed-in revenue of a slot (the Einspeise-Erlös): the metered export
     * valued at the export composition (for DV that IS spot + the Marktprämie
     * on that export). Positive = money earned; can be negative in a
     * negative-price hour for spot-valued plants (feeding in then costs),
     * which is honest - a feste-Vergütung plant's §51a slots earn exactly 0
     * instead, never a negative "revenue" its fixed remuneration does not have.
     */
    private final String einspeiseErloesEur;

    /** Baseline EUR of one covered slot (see the class Javadoc formula). */
    private final String baselineEur;

    /** Actual EUR of one covered slot (see the class Javadoc formula). */
    private final String actualEur;

    /** Saved EUR of one covered slot ({@code baseline - actual}, expanded). */
    private final String savedEur;

    /**
     * Grid supply cost of one covered slot: the METERED import valued at the
     * site's real import price. This is literally the import term of
     * {@link #actualEur} - exposed as its own sum so the Erlöse world can show
     * the composition {@code Einspeise-Erlös + Wert des Eigenverbrauchs −
     * Stromkosten} and have it reconcile with {@code actualEur} by
     * construction ({@code stromkosten − einspeise == actual}). NOT a second
     * money truth: same {@link SlotEconomics#importPriceCtSql} expression.
     */
    private final String stromkostenEur;

    /**
     * The euro value of a slot's self-consumed energy - see
     * {@link #eigenverbrauchsWertEurSql(boolean)} for the composition and why
     * it is the import price, not a second one.
     */
    private final String eigenverbrauchsWertEur;

    /** The tarifPricedSql boolean for this flag setting (see {@link #tarifPriced}). */
    private final String tarifPricedExpr;

    /** The export-side honesty boolean (see {@link #exportVerguetungPriced}). */
    private final String exportVerguetungPricedExpr;

    public EarningsRepository(JdbcTemplate jdbc, OptimizerProperties optimizer) {
        this.jdbc = jdbc;
        this.importPriceEurKwh = "(" + SlotEconomics.importPriceCtSql(
                "p.price_eur_mwh", optimizer.defaultSupplyComponents()) + " / 100.0)";
        this.exportValueEurKwh = "(" + SlotEconomics.exportValueCtSql(
                "p.price_eur_mwh", "r.bucket", EegRates.fromJson(optimizer.eegRatesJson()))
                + " / 100.0)";
        this.einspeiseErloesEur = "(r.grid_export_kwh * " + exportValueEurKwh + ")";
        this.stromkostenEur = "(r.grid_import_kwh * " + importPriceEurKwh + ")";
        this.eigenverbrauchsWertEur =
                eigenverbrauchsWertEurSql(optimizer.defaultSupplyComponents());
        // The SAME per-slot export rate values the metered AND the residual
        // export, so saved == baseline - actual stays an algebraic identity
        // (for DV the rate expands to spot + eligible premium, reproducing the
        // former ACTUAL/BASELINE_PREMIUM_EUR terms byte for byte).
        this.baselineEur = "(GREATEST(r.load_kwh - r.pv_kwh, 0) * " + importPriceEurKwh
                + " - GREATEST(r.pv_kwh - r.load_kwh, 0) * " + exportValueEurKwh + ")";
        this.actualEur = "(r.grid_import_kwh * " + importPriceEurKwh
                + " - r.grid_export_kwh * " + exportValueEurKwh + ")";
        this.savedEur = "((GREATEST(r.load_kwh - r.pv_kwh, 0) - r.grid_import_kwh) * "
                + importPriceEurKwh
                + " - (GREATEST(r.pv_kwh - r.load_kwh, 0) - r.grid_export_kwh)"
                + "   * " + exportValueEurKwh + ")";
        this.tarifPricedExpr = SlotEconomics.tarifPricedSql(optimizer.defaultSupplyComponents());
        this.exportVerguetungPricedExpr = SlotEconomics.exportVerguetungPricedSql();
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
     *
     * <p>{@code stromkostenEur}/{@code bezogenKwh}/{@code marktpraemieEur} are
     * the three terms the Erlöse world needs to SHOW its composition instead of
     * only its result: the metered import valued at the site's real import
     * price (the import term of {@code actualEur}), the metered import energy
     * behind it (so an Ø Bezugspreis is a division of two shown sums, not a
     * new price model), and the Marktprämie already contained in
     * {@code einspeiseErloesEur} (the {@code ACTUAL_PREMIUM_EUR} term). No new
     * money math - the same expressions, summed separately.
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
            BigDecimal batterieBewegtKwh,
            BigDecimal stromkostenEur,
            BigDecimal bezogenKwh,
            BigDecimal marktpraemieEur) {
    }

    /**
     * One time bucket of the money-centric Meine-Anlage view: the parts of the
     * Gesamtertrag over the bucket - {@code einspeiseErloesEur} (metered export
     * valued at the export composition: spot + Marktprämie for DV, the feste
     * Vergütung for an EEG plant) and {@code eigenverbrauchsWertEur} (the
     * self-consumed energy valued at the site's IMPORT price - the avoided
     * supply cost, same composition as {@code stromkostenEur}; see
     * {@link #eigenverbrauchsWertEurSql(boolean)}). Both are summed per slot in
     * SQL, so a dynamic tariff is priced with each slot's own Börsenpreis. The
     * Gesamtertrag ({@code einspeise + eigenverbrauchsWert}, null-safe) is
     * assembled in the controller.
     *
     * <p>{@code stromkostenEur} is the bucket's grid supply cost (the same
     * import term as in {@link SiteAggregate}), so the Erlöse world's money
     * chart can stack the three parts of ONE bucket and its cumulative line
     * lands exactly on the period's Netto-Ergebnis.
     */
    public record BucketPoint(
            Instant start,
            BigDecimal einspeiseErloesEur,
            BigDecimal eigenverbrauchsWertEur,
            BigDecimal stromkostenEur) {
    }

    /**
     * One Europe/Berlin day of realized savings of one site.
     *
     * <p>{@code savedEur} is the whole storage system's contribution against a
     * plant WITHOUT a battery - an ADMIN number since the Messlatte decision
     * (Captain 04.09.2026). {@code savedSteuerungEur} is the day's share of the
     * INTELLIGENT control against a STUR working battery, i.e. the same
     * {@code savedEur - savedSpeicherEur} remainder the window aggregate ships,
     * cut per day out of ONE continuous greedy walk (see
     * {@link #savedSpeicherPerDay}). It is the ONLY storage figure a customer
     * surface may render.
     *
     * <p>Null when the site has no maintained battery master data - never a
     * fabricated zero, and never the whole-storage number as a stand-in.
     */
    public record DailySaved(LocalDate day, BigDecimal savedEur, BigDecimal savedSteuerungEur) {
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
     * Narrows a query to ONE site (the Anlagen-scharfe Erlöse-Welt, P3 of the
     * Historie concept) - or to nothing extra when {@code site} is null (the
     * tenant-wide fleet/portfolio path). RLS still fences the tenant either
     * way; this only avoids computing four other Anlagen for a page that shows
     * one. Returns the SQL fragment; {@link #args} appends the matching bind.
     */
    private static String siteFilter(UUID site) {
        return site == null ? "" : " AND r.site_id = ?";
    }

    /** The bind list of a window query: window twice (CTE + WHERE) + the optional site. */
    private static Object[] args(Instant from, Instant to, UUID site) {
        Timestamp f = Timestamp.from(from);
        Timestamp t = Timestamp.from(to);
        return site == null
                ? new Object[] {f, t, f, t}
                : new Object[] {f, t, f, t, site};
    }

    /**
     * The per-site earnings aggregate over {@code [from, to)}. Sites without
     * any rollup bucket in the window are absent from the map.
     */
    public Map<UUID, SiteAggregate> aggregate(Instant from, Instant to) {
        return aggregate(from, to, null);
    }

    /**
     * The aggregate of ONE site (P3) - {@code null} when the site has no rollup
     * bucket in the window. Same SQL, same price truth, one site.
     */
    public SiteAggregate aggregateForSite(UUID site, Instant from, Instant to) {
        return aggregate(from, to, site).get(site);
    }

    private Map<UUID, SiteAggregate> aggregate(Instant from, Instant to, UUID site) {
        Map<UUID, SiteAggregate> result = new HashMap<>();
        // The benchmark averages weight by EXPORTED energy: realized ct/kWh
        // over priced covered slots (EUR/MWh / 10 = ct/kWh), the market value
        // over the covered slots whose month HAS one - separate denominators,
        // so a missing market-value month degrades the benchmark but never the
        // realized number.
        String exportKwh = "sum(r.grid_export_kwh) FILTER (WHERE " + COVERED + ")";
        String mvFilter = COVERED + " AND mv.value_ct_kwh IS NOT NULL";
        jdbc.query(
                "WITH " + PRICE_SLOT_CTE
                        + "SELECT r.site_id,"
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
                        + " sum(" + einspeiseErloesEur + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS einspeise_erloes_eur,"
                        + " sum(" + eigenverbrauchsWertEur + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS eigenverbrauchs_wert_eur,"
                        + " sum(" + SELBSTVERBRAUCH_KWH + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS selbstverbrauch_kwh,"
                        + " sum(r.grid_export_kwh)"
                        + "   FILTER (WHERE " + COVERED + ") AS eingespeist_kwh,"
                        + " sum(" + BATTERIE_BEWEGT_KWH + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS batterie_bewegt_kwh,"
                        + " sum(" + stromkostenEur + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS stromkosten_eur,"
                        + " sum(r.grid_import_kwh)"
                        + "   FILTER (WHERE " + COVERED + ") AS bezogen_kwh,"
                        // Only ELIGIBLE slots enter the premium sum, so a site
                        // without an anzulegender Wert gets NULL ("—" with its
                        // reason) instead of a fabricated 0,00 €; a site that is
                        // eligible but earned nothing keeps its measured 0.
                        + " sum(" + ACTUAL_PREMIUM_EUR + ")"
                        + "   FILTER (WHERE " + COVERED + " AND " + PREMIUM_ELIGIBLE + ")"
                        + "   AS marktpraemie_eur "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + SUPPLY_PRICE_JOIN
                        + PV_ASSET_JOIN
                        + PRICE_JOIN
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ?" + siteFilter(site) + " "
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
                            rs.getBigDecimal("batterie_bewegt_kwh"),
                            rs.getBigDecimal("stromkosten_eur"),
                            rs.getBigDecimal("bezogen_kwh"),
                            rs.getBigDecimal("marktpraemie_eur")));
                },
                args(from, to, site));
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
     * The same honesty switch for ONE site (P3). False for a site the caller
     * cannot see (RLS) - the label then stays at the conservative
     * "zu Börsenpreisen", never an over-claimed tariff.
     */
    public boolean tarifPricedForSite(UUID site) {
        Boolean priced = jdbc.query(
                "SELECT " + tarifPricedExpr + " AS tarif_priced "
                        + "FROM site s " + SUPPLY_PRICE_JOIN + "WHERE s.id = ?",
                rs -> rs.next() ? rs.getBoolean("tarif_priced") : Boolean.FALSE,
                site);
        return Boolean.TRUE.equals(priced);
    }

    /**
     * The EXPORT-side honesty switch (the {@link #tarifPriced} sibling, B2
     * fix): which of the tenant's sites have their feed-in valued at the feste
     * EEG-Einspeisevergütung instead of bare spot
     * ({@link SlotEconomics#exportVerguetungPricedSql} - a non-grid-charging
     * {@code eigenverbrauch} plant with a known, unexpired commissioning
     * date). {@code false} for Direktvermarktung (its spot + Marktprämie
     * valuation is already explained by the premium fields) and for every
     * plant whose remuneration cannot be determined - those honestly stay at
     * spot, and the copy must not claim otherwise. RLS-fenced like every read
     * here.
     */
    public Map<UUID, Boolean> exportVerguetungPriced() {
        Map<UUID, Boolean> result = new HashMap<>();
        jdbc.query(
                "SELECT s.id, " + exportVerguetungPricedExpr + " AS export_priced "
                        + "FROM site s " + PV_ASSET_JOIN,
                rs -> {
                    result.put(rs.getObject("id", UUID.class), rs.getBoolean("export_priced"));
                });
        return result;
    }

    /**
     * The export-side honesty switch for ONE site (P3). False for a site the
     * caller cannot see (RLS) - conservative, like {@link #tarifPricedForSite}.
     */
    public boolean exportVerguetungPricedForSite(UUID site) {
        Boolean priced = jdbc.query(
                "SELECT " + exportVerguetungPricedExpr + " AS export_priced "
                        + "FROM site s " + PV_ASSET_JOIN + "WHERE s.id = ?",
                rs -> rs.next() ? rs.getBoolean("export_priced") : Boolean.FALSE,
                site);
        return Boolean.TRUE.equals(priced);
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
        return arbitrageSplit(from, to, null);
    }

    /** The split of ONE site (P3) - null when that site grid-charged nothing. */
    public ArbitrageSplit arbitrageSplitForSite(UUID site, Instant from, Instant to) {
        return arbitrageSplit(from, to, site).get(site);
    }

    private Map<UUID, ArbitrageSplit> arbitrageSplit(Instant from, Instant to, UUID site) {
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
                "WITH " + PRICE_SLOT_CTE
                        + "SELECT r.site_id,"
                        + " COALESCE(r.battery_charge_kwh, 0) AS charge_kwh,"
                        + " COALESCE(r.battery_discharge_kwh, 0) AS discharge_kwh,"
                        + " GREATEST(COALESCE(r.pv_kwh - r.load_kwh, 0), 0) AS pv_surplus_kwh,"
                        + " p.price_eur_mwh "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id AND s.netzladen_erlaubt "
                        + PRICE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ?" + siteFilter(site)
                        + " AND " + COVERED + " "
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
                args(from, to, site));
        state.finish();
        return result;
    }

    /**
     * The battery-asset join of the {@link #savedSpeicher} walk (own alias
     * {@code b} - {@code pv} belongs to {@link #PV_ASSET_JOIN}): only sites
     * whose PRIMARY battery asset carries the maintained master data the
     * greedy reference needs (capacity + both power caps, the exact columns
     * {@code inputs.load_battery_sites} requires) enter the walk. A site
     * without them is ABSENT from the result - the split then honestly stays
     * null with its reason, never a guessed battery (Eckpunkt 4 of the
     * Umbau-Skizze).
     */
    private static final String BATTERY_ASSET_JOIN =
            "JOIN asset b ON b.site_id = r.site_id AND b.type = 'battery' AND b.is_primary"
                    + " AND b.capacity_kwh IS NOT NULL AND b.max_charge_kw IS NOT NULL"
                    + " AND b.max_discharge_kw IS NOT NULL ";

    /**
     * Der Speicher-Anteil der Dreiteilung {@code saved_gesamt = saved_speicher
     * + saved_steuerung} (Audit vp-geldzahlen-audit-x7 §2.5, Befund B1): was
     * ein STUR arbeitender Standard-Speicher - das Greedy-Szenario (b) der
     * Ersparnis-Simulation, siehe {@link StandardSpeicher} - gegenüber der
     * speicherlosen Anlage erwirtschaftet hätte, über die covered Slots des
     * Fensters.
     *
     * <p>Ein deterministischer per-Slot-Zustands-Walk nach dem
     * {@link #arbitrageSplit}-Muster: die Slots kommen zeitlich sortiert, der
     * SoC des Referenz-Speichers wird im Speicher geführt, und jeder Slot
     * trägt {@code discharge × importPrice − charge × exportValue} bei
     * (Herleitung in {@link StandardSpeicher}) - mit EXAKT den Preis-Spalten,
     * die auch {@code savedEur} bewerten ({@link #importPriceEurKwh}/
     * {@link #exportValueEurKwh} als SELECT-Ausdrücke, also per Konstruktion
     * dieselbe Komposition inkl. Preisblatt, feste EEG-Vergütung und
     * DV-Marktprämie). Es gibt keine zweite Preiswahrheit.
     *
     * <p><b>On-the-fly statt persistiert</b> (Skizzen-Option (a), bewusst):
     * der Walk kostet einen zusätzlichen sortierten Scan über die covered
     * Slots × Batterie-Anlagen - dieselbe Größenordnung wie der
     * {@code arbitrageSplit}, der auf jedem Request läuft -, braucht weder
     * Migration noch nightly Job, und die Start-SoC-Verankerung am gemessenen
     * Fensterbeginn macht ihn fenster-agnostisch.
     *
     * <p><b>Start-SoC</b>: der letzte gemessene {@code soc_last_pct}-Eimer
     * VOR dem Fenster (7-Tage-Rückschau, {@link #SOC_START_LOOKBACK}), sonst
     * der SoC-Boden wie in der Simulation - Regel + Begründung in
     * {@link StandardSpeicher.Walk}.
     *
     * <p><b>Der sture Speicher lädt nie aus dem Netz</b> - auch auf einer
     * {@code netzladen_erlaubt}-Anlage: die Netzladen-Arbitrage ist per
     * Konstruktion Steuerungs-, nie Speicher-Beitrag (sie landet über den
     * Rest-Trick des Aufrufers in {@code saved_steuerung}, wo sie hingehört).
     *
     * <p>Anlagen ohne gepflegte Batterie-Stammdaten fehlen in der Map (siehe
     * {@link #BATTERY_ASSET_JOIN}); eine Anlage mit Stammdaten, deren sture
     * Referenz im Fenster schlicht nichts bewegt hat, steht ehrlich mit 0
     * darin (eine gemessene 0, keine erfundene).
     */
    public Map<UUID, BigDecimal> savedSpeicher(Instant from, Instant to) {
        return savedSpeicher(from, to, null);
    }

    /** Der Speicher-Anteil EINER Anlage - null ohne gepflegte Batterie-Stammdaten. */
    public BigDecimal savedSpeicherForSite(UUID site, Instant from, Instant to) {
        return savedSpeicher(from, to, site).get(site);
    }

    /**
     * Der Speicher-Anteil JE BERLINER TAG - dieselbe Messlatte, feiner
     * geschnitten (Captain 04.09.2026): die 14-Tage-Reihe hinter dem
     * Flotten-Spark und dem "Heute"-Teaser braucht je Tag den Anteil eines
     * sturen Speichers, damit der Aufrufer daraus den Steuerungs-Anteil bilden
     * kann.
     *
     * <p><b>EIN Lauf, zwei Ausgaben.</b> Es ist derselbe Walk wie
     * {@link #savedSpeicher} - der Ladestand des Referenz-Speichers laeuft
     * UEBER die Tagesgrenzen hinweg weiter, und ein Tag ist die DIFFERENZ
     * seines laufenden Gesamtstands an dessen Rand. Ein zweiter, je Tag neu
     * gestarteter Walk waere eine andere Referenz (jeder Tag begaenne am
     * Boden), also eine zweite Geldwahrheit ueber dieselbe Anlage.
     */
    private Map<UUID, Map<LocalDate, BigDecimal>> savedSpeicherPerDay(Instant from, Instant to) {
        return speicherWalk(from, to, null).perDay();
    }

    /** Was ein Walk hergibt: die Fenster-Summe je Anlage und ihre Tages-Zuwaechse. */
    private record SpeicherWalk(
            Map<UUID, BigDecimal> total,
            Map<UUID, Map<LocalDate, BigDecimal>> perDay) {
    }

    private Map<UUID, BigDecimal> savedSpeicher(Instant from, Instant to, UUID site) {
        return speicherWalk(from, to, site).total();
    }

    private SpeicherWalk speicherWalk(Instant from, Instant to, UUID site) {
        Map<UUID, BigDecimal> startSocPct = startSocPct(from, site);
        Map<UUID, BigDecimal> result = new HashMap<>();
        Map<UUID, Map<LocalDate, BigDecimal>> perDay = new HashMap<>();
        // One mutable walk state; rows arrive ordered by (site_id, bucket), so
        // a site change closes the previous site's walk (the arbitrageSplit
        // shape). walk == null cannot happen for a joined row unless the
        // asset's values are non-positive - then the master data is broken and
        // nothing is claimed (StandardSpeicher.batterie returns null).
        //
        // The day checkpoint rides the SAME loop: `day`/`dayStartEur` hold the
        // Berlin day currently accumulating and the walk's running total when
        // it began, so a day's share is the increment - never a restarted walk.
        var state = new Object() {
            UUID site;
            StandardSpeicher.Walk walk;
            LocalDate day;
            double dayStartEur;

            void closeDay() {
                if (site != null && walk != null && day != null) {
                    perDay.computeIfAbsent(site, k -> new HashMap<>())
                            .put(day, BigDecimal.valueOf(walk.speicherEur() - dayStartEur));
                }
                day = null;
            }

            void finish() {
                closeDay();
                if (site != null && walk != null) {
                    result.put(site, BigDecimal.valueOf(walk.speicherEur()));
                }
            }
        };
        jdbc.query(
                "WITH " + PRICE_SLOT_CTE
                        + "SELECT r.site_id, r.pv_kwh, r.load_kwh,"
                        + " time_bucket('1 day', r.bucket, 'Europe/Berlin') AS day,"
                        + " " + importPriceEurKwh + " AS import_price_eur_kwh,"
                        + " " + exportValueEurKwh + " AS export_value_eur_kwh,"
                        + " b.capacity_kwh, b.max_charge_kw, b.max_discharge_kw,"
                        + " b.roundtrip_efficiency_pct, b.soc_min_pct, b.soc_max_pct,"
                        + " s.backup_reserve_soc_pct, s.peak_reserve_soc_pct "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + BATTERY_ASSET_JOIN
                        + SUPPLY_PRICE_JOIN
                        + PV_ASSET_JOIN
                        + PRICE_JOIN
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ?" + siteFilter(site)
                        + " AND " + COVERED + " "
                        + "ORDER BY r.site_id, r.bucket",
                rs -> {
                    UUID siteId = rs.getObject("site_id", UUID.class);
                    if (!siteId.equals(state.site)) {
                        state.finish();
                        state.site = siteId;
                        StandardSpeicher.Batterie batterie = StandardSpeicher.batterie(
                                rs.getBigDecimal("capacity_kwh"),
                                rs.getBigDecimal("max_charge_kw"),
                                rs.getBigDecimal("max_discharge_kw"),
                                rs.getBigDecimal("roundtrip_efficiency_pct"),
                                rs.getBigDecimal("soc_min_pct"),
                                rs.getBigDecimal("soc_max_pct"),
                                rs.getBigDecimal("backup_reserve_soc_pct"),
                                rs.getBigDecimal("peak_reserve_soc_pct"));
                        BigDecimal socPct = startSocPct.get(siteId);
                        state.walk = batterie == null ? null
                                : new StandardSpeicher.Walk(batterie, socPct == null
                                        ? null
                                        : socPct.doubleValue() / 100.0
                                                * batterie.capacityKwh());
                    }
                    if (state.walk != null) {
                        LocalDate day = rs.getTimestamp("day").toInstant()
                                .atZone(ZONE).toLocalDate();
                        if (!day.equals(state.day)) {
                            state.closeDay();
                            state.day = day;
                            state.dayStartEur = state.walk.speicherEur();
                        }
                        state.walk.slot(
                                rs.getDouble("pv_kwh"),
                                rs.getDouble("load_kwh"),
                                rs.getDouble("import_price_eur_kwh"),
                                rs.getDouble("export_value_eur_kwh"));
                    }
                },
                args(from, to, site));
        state.finish();
        return new SpeicherWalk(result, perDay);
    }

    /**
     * Der gemessene Ladestand am Fensterbeginn je Anlage: der jüngste
     * {@code soc_last_pct}-Rollup-Eimer in {@code [from − 7d, from)} (die
     * {@link #rollupSocLast}-Regel, als EINE gebatchte Abfrage für den
     * Flotten-Pfad). Das Fenster ist auf der Partitionsspalte begrenzt, der
     * Scan also chunk-klein; für {@code range=all} (from = EPOCH) ist es leer
     * und jede Anlage startet am Boden.
     */
    private Map<UUID, BigDecimal> startSocPct(Instant from, UUID site) {
        Map<UUID, BigDecimal> result = new HashMap<>();
        Timestamp lookback = Timestamp.from(from.minus(SOC_START_LOOKBACK));
        Timestamp start = Timestamp.from(from);
        jdbc.query(
                "SELECT DISTINCT ON (site_id) site_id, soc_last_pct "
                        + "FROM telemetry_rollup_15m "
                        + "WHERE bucket >= ? AND bucket < ? AND soc_last_pct IS NOT NULL"
                        + (site == null ? "" : " AND site_id = ?")
                        + " ORDER BY site_id, bucket DESC",
                rs -> {
                    result.put(rs.getObject("site_id", UUID.class),
                            rs.getBigDecimal("soc_last_pct"));
                },
                site == null
                        ? new Object[] {lookback, start}
                        : new Object[] {lookback, start, site});
        return result;
    }

    /**
     * Realized savings per site and Europe/Berlin day over {@code [from, to)}
     * (the hero's spark bars + the "Heute" teasers). Only covered slots count;
     * days without one are absent - never a fake zero.
     */
    public Map<UUID, List<DailySaved>> dailySavedPerSite(Instant from, Instant to) {
        Map<UUID, List<DailySaved>> result = new HashMap<>();
        // Die MESSLATTE der Kundenansicht (Captain 04.09.2026): der Anteil des
        // sturen Speichers je Tag, aus dem der Steuerungs-Anteil als exakter
        // Rest entsteht - derselbe Rest-Trick wie im Fenster-Aggregat, damit
        // Reihe und Summe nie Verschiedenes behaupten.
        Map<UUID, Map<LocalDate, BigDecimal>> speicherPerDay = savedSpeicherPerDay(from, to);
        jdbc.query(
                "WITH " + PRICE_SLOT_CTE
                        + "SELECT r.site_id,"
                        + " time_bucket('1 day', r.bucket, 'Europe/Berlin') AS day,"
                        // saved = baseline - actual (import at the tariff,
                        // export at the export composition, incl. the premium
                        // delta resp. the feste Vergütung).
                        + " sum(" + savedEur + ") AS saved_eur "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + SUPPLY_PRICE_JOIN
                        + PV_ASSET_JOIN
                        + PRICE_JOIN
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ? AND " + COVERED + " "
                        + "GROUP BY 1, 2 ORDER BY 1, 2",
                rs -> {
                    BigDecimal saved = rs.getBigDecimal("saved_eur");
                    if (saved != null) {
                        UUID siteId = rs.getObject("site_id", UUID.class);
                        LocalDate day = rs.getTimestamp("day").toInstant()
                                .atZone(ZONE).toLocalDate();
                        // Kein Speicher-Anteil (keine gepflegten Stammdaten, oder
                        // der Walk hat diesen Tag nicht gesehen) => KEINE
                        // Steuerungs-Zahl. Die Gesamtzahl ist dafuer kein Ersatz.
                        BigDecimal speicher = speicherPerDay
                                .getOrDefault(siteId, Map.of()).get(day);
                        result.computeIfAbsent(siteId, k -> new ArrayList<>())
                                .add(new DailySaved(day, saved,
                                        speicher == null ? null : saved.subtract(speicher)));
                    }
                },
                Timestamp.from(from), Timestamp.from(to),
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
     * bidding zone with the same {@link PriceSlots} matching the realized
     * aggregates use (PT15M preferred, PT60M fallback). The weighted average
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
                "WITH " + PriceSlots.forTenantZonesFrom()
                        // ⚠ per-Anlage-LATERAL statt fleet-weitem GROUP BY
                        // (gemessener Defekt 2026-08-24): `forecast` ist auf
                        // `time` partitioniert, dieses CTE bindet `time` gar
                        // nicht - ohne site_id-Gleichheit steigt es deshalb in
                        // JEDEN Chunk ab. Prod-förmiger Klon (2,27 Mio Zeilen,
                        // 28 Chunks): 161 ms -> 1,4 ms, PRÄDIKAT UNVERÄNDERT,
                        // 0 Differenzen (HotReadRewriteEqualityTest). `site`
                        // führt jetzt - dieselbe Fence wie der alte JOIN, denn
                        // `forecast` trägt selbst keine RLS.
                        + ", latest_run AS ("
                        + "  SELECT s.id AS site_id, x.run_at FROM site s"
                        + "  JOIN LATERAL (SELECT max(f.run_at) AS run_at FROM forecast f"
                        + "    WHERE f.site_id = s.id AND f.kind = 'pv' AND f.model = ?) x ON true"
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
                        + "JOIN price_slot p"
                        + "  ON p.bidding_zone = s.bidding_zone AND p.slot = fc.time "
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
                Timestamp.from(now), pvModel, pvModel, Timestamp.from(now));
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
        return bucketed(from, to, bucket, null);
    }

    /** The bucketed series of ONE site (P3) - empty when nothing is computable. */
    public List<BucketPoint> bucketedForSite(UUID site, Instant from, Instant to, Bucket bucket) {
        return bucketed(from, to, bucket, site).getOrDefault(site, List.of());
    }

    private Map<UUID, List<BucketPoint>> bucketed(Instant from, Instant to, Bucket bucket,
            UUID site) {
        Map<UUID, List<BucketPoint>> result = new HashMap<>();
        String start = "(date_trunc('" + bucket.unit
                + "', r.bucket AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin')";
        jdbc.query(
                "WITH " + PRICE_SLOT_CTE
                        + "SELECT r.site_id, " + start + " AS bucket_start,"
                        + " sum(" + einspeiseErloesEur + ") AS einspeise_erloes_eur,"
                        + " sum(" + eigenverbrauchsWertEur + ") AS eigenverbrauchs_wert_eur,"
                        + " sum(" + stromkostenEur + ") AS stromkosten_eur "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        // The import price reads the supply-price sheet and the
                        // export value the primary pv asset, so the sums need
                        // the same LEFT JOINs the aggregate uses (one row per
                        // site each - they cannot fan a bucket out).
                        + SUPPLY_PRICE_JOIN
                        + PV_ASSET_JOIN
                        + PRICE_JOIN
                        + MARKET_VALUE_JOIN
                        + "WHERE r.bucket >= ? AND r.bucket < ?" + siteFilter(site)
                        + " AND " + COVERED + " "
                        + "GROUP BY r.site_id, bucket_start ORDER BY r.site_id, bucket_start",
                rs -> {
                    result.computeIfAbsent(rs.getObject("site_id", UUID.class),
                                    k -> new ArrayList<>())
                            .add(new BucketPoint(
                                    rs.getTimestamp("bucket_start").toInstant(),
                                    rs.getBigDecimal("einspeise_erloes_eur"),
                                    rs.getBigDecimal("eigenverbrauchs_wert_eur"),
                                    rs.getBigDecimal("stromkosten_eur")));
                },
                args(from, to, site));
        return result;
    }

    /* -----------------------------------------------------------------------
     * Das BESTANDSKONTO des Zeitraums (Diagnose vp-tagesbild-minus-f3 §6.1)
     * --------------------------------------------------------------------- */

    /**
     * Wie weit zurück ein Ladestand VOR dem Fenster gesucht wird. Ohne Grenze
     * müsste ein Rückwärts-Lauf über den ganzen Hypertable laufen, sobald eine
     * Anlage davor nie gemessen hat; nach einer Woche Stille wird über den
     * Anfangsbestand ohnehin nichts mehr behauptet.
     */
    private static final Duration SOC_START_LOOKBACK = Duration.ofDays(7);

    /**
     * Wie frisch ein ROHES Telemetrie-Sample sein muss, um den Bestand des
     * laufenden Zeitraums zu tragen. Ein Gerät, das seit Stunden schweigt,
     * belegt keinen Ladestand von jetzt - dann greift der Rollup-Stand, und
     * fehlt auch der, wird nichts behauptet.
     */
    private static final Duration SOC_LIVE_LOOKBACK = Duration.ofHours(2);

    /**
     * Wie alt die Plan-Bewertung λ höchstens sein darf. Ein λ von gestern
     * bewertete den Bestand von heute mit dem Preisbild von gestern; die Grenze
     * hält die Abfrage außerdem klein (der Optimierer plant alle 15 min neu).
     */
    private static final Duration LAMBDA_LOOKBACK = Duration.ofHours(6);

    /**
     * Der Speicher-Bestand des Fensters {@code [from, to)} - die FK2-Gutschrift
     * für den GEMESSENEN Zeitraum: {@code ΔLadestand × Kapazität}, bewertet mit
     * dem λ, das der Optimierer selbst persistiert hat. Regeln, Vorzeichen und
     * Begründung stehen in {@link SpeicherBank}; hier stehen nur die drei
     * schmalen Abfragen dahinter.
     *
     * <p>Vier Dinge, die man kennen muss:
     * <ul>
     *   <li><b>Ohne primären Speicher gibt es nichts zu sagen</b> - dann läuft
     *       keine weitere Abfrage.</li>
     *   <li><b>Der Anker ist {@code min(to, jetzt)}</b>: solange der Zeitraum
     *       läuft, ist der Bestand der von JETZT (sonst hinkte die Zeile dem
     *       Bild hinterher); ein abgeschlossener Zeitraum endet an seiner
     *       letzten Viertelstunde.</li>
     *   <li><b>Am laufenden Zeitraum gewinnt das ROHE Sample</b> (§7.1: die
     *       Bestandszeile nimmt dieselbe Quelle wie der kWh-Satz daneben) -
     *       der Rollup-Stand hinkt bis zu 15 Minuten hinterher und ist nur der
     *       Rückfall.</li>
     *   <li><b>Der Anfangsbestand ist der letzte Eimer VOR dem Fenster</b>, nie
     *       der erste darin: der erste im Fenster steht schon eine
     *       Viertelstunde nach Beginn und trüge die erste Ladung bereits in
     *       sich.</li>
     * </ul>
     */
    public SpeicherBank.Bestand storageBank(UUID site, Instant from, Instant to, Instant now) {
        if (site == null || from == null || to == null || now == null) {
            return SpeicherBank.Bestand.NONE;
        }
        BigDecimal capacity = batteryCapacityKwh(site);
        if (capacity == null || capacity.signum() <= 0) {
            return SpeicherBank.Bestand.NONE;
        }
        boolean laufend = to.isAfter(now);
        Instant anchor = laufend ? now : to.minusMillis(1);
        if (!anchor.isAfter(from)) {
            // Der Zeitraum hat noch gar nicht begonnen.
            return SpeicherBank.Bestand.NONE;
        }
        BigDecimal socEnd = laufend ? rawSocAt(site, anchor) : null;
        if (socEnd == null) {
            socEnd = rollupSocLast(site, from, laufend ? now : to);
        }
        BigDecimal socStart = rollupSocLast(site, from.minus(SOC_START_LOOKBACK), from);
        Lambda lambda = lambdaAt(site, anchor);
        return SpeicherBank.of(socEnd, socStart, capacity,
                lambda == null ? null : lambda.storedValueCtKwh(),
                lambda == null ? null : lambda.terminalValueEurKwh());
    }

    /** Die Nennkapazität des PRIMÄREN Speichers (das {@code is_primary}-Muster). */
    private BigDecimal batteryCapacityKwh(UUID site) {
        return jdbc.query(
                "SELECT capacity_kwh FROM asset "
                        + "WHERE site_id = ? AND type = 'battery' AND is_primary",
                rs -> rs.next() ? rs.getBigDecimal("capacity_kwh") : null,
                site);
    }

    /** Der jüngste ROHE Ladestand bis {@code anchor} - null, wenn er zu alt ist. */
    private BigDecimal rawSocAt(UUID site, Instant anchor) {
        return jdbc.query(
                "SELECT soc_pct FROM telemetry "
                        + "WHERE site_id = ? AND time <= ? AND time > ? AND soc_pct IS NOT NULL "
                        + "ORDER BY time DESC LIMIT 1",
                rs -> rs.next() ? rs.getBigDecimal("soc_pct") : null,
                site, Timestamp.from(anchor),
                Timestamp.from(anchor.minus(SOC_LIVE_LOOKBACK)));
    }

    /**
     * Der Ladestand am Ende des letzten Rollup-Eimers in {@code [von, bis)} -
     * Eimer OHNE Ladestand werden übersprungen statt die Zeile zu töten.
     */
    private BigDecimal rollupSocLast(UUID site, Instant von, Instant bis) {
        if (!bis.isAfter(von)) {
            return null;
        }
        return jdbc.query(
                "SELECT soc_last_pct FROM telemetry_rollup_15m "
                        + "WHERE site_id = ? AND bucket >= ? AND bucket < ? "
                        + "  AND soc_last_pct IS NOT NULL "
                        + "ORDER BY bucket DESC LIMIT 1",
                rs -> rs.next() ? rs.getBigDecimal("soc_last_pct") : null,
                site, Timestamp.from(von), Timestamp.from(bis));
    }

    /** Die zwei Bewertungs-Zahlen eines Plan-Slots (beide dürfen fehlen). */
    private record Lambda(BigDecimal storedValueCtKwh, BigDecimal terminalValueEurKwh) {
    }

    /**
     * Die Plan-Bewertung im maßgeblichen Slot: der jüngste Slot bis
     * {@code anchor} und dafür der jüngste Lauf, der ihn geplant hat.
     * {@code generated_at <= anchor} sagt ausdrücklich, dass kein Lauf von NACH
     * dem bewerteten Moment einfließt.
     */
    private Lambda lambdaAt(UUID site, Instant anchor) {
        Timestamp a = Timestamp.from(anchor);
        return jdbc.query(
                "SELECT s.stored_value_ct_kwh, s.terminal_value_eur_per_kwh FROM schedule s "
                        + "WHERE s.site_id = ? AND s.time <= ? AND s.time > ? "
                        + "  AND s.generated_at <= ? "
                        + "ORDER BY s.time DESC, s.generated_at DESC LIMIT 1",
                rs -> rs.next()
                        ? new Lambda(rs.getBigDecimal("stored_value_ct_kwh"),
                                rs.getBigDecimal("terminal_value_eur_per_kwh"))
                        : null,
                site, a, Timestamp.from(anchor.minus(LAMBDA_LOOKBACK)), a);
    }
}
