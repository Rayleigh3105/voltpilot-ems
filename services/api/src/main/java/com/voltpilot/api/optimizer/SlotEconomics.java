package com.voltpilot.api.optimizer;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Pure per-slot economics of a persisted optimizer plan - the read-side twin
 * of services/optimization {@code voltpilot_optimization/pricing.py} (P1
 * asymmetric import/export pricing) used by the admin "why" view. Everything
 * here is deterministic math over plain values; the service feeds it the
 * site's master data, the plan's slots and the Monatsmarktwert rows.
 *
 * <p><b>Consistency rule:</b> the import/export formulas mirror pricing.py
 * BYTE-FOR-BYTE in semantics (tarif_art branching, dynamic Marktprämie with
 * the §51 suspension, feste Vergütung incl. §51a and expiry, the merchant-mode
 * Ausschließlichkeitsprinzip guard, every missing datum degrading to bare
 * spot) - so the numbers shown ARE what the solver optimized against, not a
 * reporting-side reinterpretation. Where a value genuinely cannot be computed
 * (no spot price persisted for the slot), the result is {@code null}, never a
 * fabricated 0 (the platform's null-vs-zero discipline).
 *
 * <p>Units: the persisted {@code schedule.price_eur_mwh} is spot EUR/MWh; all
 * outputs are ct/kWh (EUR/MWh / 10).
 */
public final class SlotEconomics {

    /** Battery deadband mirroring frontend/portal src/schedule.ts SLOT_DEADBAND_KW. */
    public static final double SLOT_DEADBAND_KW = 0.05;
    /** Curtailment deadband mirroring schedule.ts CURTAIL_DEADBAND_KW. */
    public static final double CURTAIL_DEADBAND_KW = 0.01;

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** One month's Monatsmarktwert Solar (the monthly_market_value row). */
    public record MarketValue(double ctKwh, boolean provisional) {
    }

    /**
     * One site's structured supply-price sheet (the {@code site_supply_price}
     * row - the pricing.py {@code SupplyPriceComponents} twin): volumetric
     * Bezugspreis components in ct/kWh NETTO, all nullable (NULL = unknown,
     * contributes 0); {@code ustPct} is the multiplicative USt on everything
     * incl. the spot share (household 19, C&I with Vorsteuer-Abzug 0).
     */
    public record SupplyPrice(
            Double netzentgeltArbeitspreisCt,
            Double stromsteuerCt,
            Double konzessionsabgabeCt,
            Double umlagenCt,
            Double vertriebsaufschlagCt,
            double ustPct) {

        /** Σ of the maintained (non-null) components, ct netto. */
        public double componentsCtKwh() {
            double sum = 0.0;
            for (Double c : new Double[] {netzentgeltArbeitspreisCt, stromsteuerCt,
                    konzessionsabgabeCt, umlagenCt, vertriebsaufschlagCt}) {
                if (c != null) {
                    sum += c;
                }
            }
            return sum;
        }

        /**
         * Whether at least one component is maintained - the load-bearing
         * activation gate (mirrors pricing.py {@code has_components}): a
         * degenerate all-NULL row behaves exactly like NO row, so only an
         * explicitly maintained sheet activates the structured composition.
         */
        public boolean hasComponents() {
            return netzentgeltArbeitspreisCt != null || stromsteuerCt != null
                    || konzessionsabgabeCt != null || umlagenCt != null
                    || vertriebsaufschlagCt != null;
        }
    }

    /**
     * The researched household default set (pricing.py
     * {@code DEFAULT_SUPPLY_COMPONENTS}, report vp-nacht-bezug-e7 Teil 2):
     * only ever applied behind the {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS}
     * flag mirrored from the optimizer env - keep both sides in sync.
     */
    public static final SupplyPrice DEFAULT_SUPPLY_PRICE =
            new SupplyPrice(7.6, 2.05, 1.59, 2.946, 1.5, 19.0);

    /**
     * The pricing-relevant site master data (the SiteTariff twin). Battery
     * fields are null for battery-less sites - stored-energy values are then
     * honestly absent. {@code roundtripEfficiency} is the 0..1 fraction
     * (defaulted to 0.92 when the asset column is NULL, mirroring
     * inputs.load_battery_sites); {@code wearCostCtPerKwh} is the EFFECTIVE
     * per-cycle rate (asset override or platform default).
     * {@code supplyPrice} is the site's structured supply-price sheet (null =
     * no {@code site_supply_price} row = the legacy import model).
     */
    public record SiteEconomics(
            String plantKind,
            boolean netzladenErlaubt,
            String tarifArt,
            Double tarifParamCtKwh,
            Double anzulegenderWertCtKwh,
            LocalDate pvCommissionedOn,
            Double pvCapacityKwp,
            Double roundtripEfficiency,
            Double wearCostCtPerKwh,
            SupplyPrice supplyPrice) {
    }

    private final SiteEconomics site;
    private final EegRates eegRates;
    private final Map<LocalDate, MarketValue> marketValuesByMonth;
    private final boolean defaultSupplyComponents;

    public SlotEconomics(SiteEconomics site, EegRates eegRates,
            Map<LocalDate, MarketValue> marketValuesByMonth) {
        this(site, eegRates, marketValuesByMonth, false);
    }

    /**
     * @param defaultSupplyComponents the mirrored
     *     {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS} flag: whether the
     *     researched default component set stands in for a missing sheet on
     *     {@code dynamisch}-without-Aufschlag / {@code ohne} sites (default
     *     OFF - captain decision pending).
     */
    public SlotEconomics(SiteEconomics site, EegRates eegRates,
            Map<LocalDate, MarketValue> marketValuesByMonth,
            boolean defaultSupplyComponents) {
        this.site = site;
        this.eegRates = eegRates;
        this.marketValuesByMonth = marketValuesByMonth;
        this.defaultSupplyComponents = defaultSupplyComponents;
    }

    /**
     * What one imported kWh really costs the site in this slot (ct/kWh), per
     * its supply tariff - mirrors pricing.py {@code import_prices} branch for
     * branch (report vp-nacht-bezug-e7 §3.1): {@code fest} = the flat all-in
     * retail price, UNCHANGED (a maintained sheet is ignored - nothing is
     * double-counted); {@code dynamisch}/{@code ohne} with a maintained sheet
     * = {@code (spot + Σ Komponenten netto) × (1 + USt)} - the USt factor
     * covers the spot share too; {@code dynamisch} without a sheet = the
     * legacy spot + Aufschlag; no sheet and no Aufschlag = bare spot, or the
     * researched default set when the mirrored flag is on. Null when the slot
     * has no persisted spot price (except the flat tariff, which needs none).
     */
    public Double importPriceCtKwh(Double spotEurMwh) {
        boolean maintained = site.supplyPrice() != null && site.supplyPrice().hasComponents();
        if ("fest".equals(site.tarifArt()) && site.tarifParamCtKwh() != null) {
            return site.tarifParamCtKwh();
        }
        boolean structured = "dynamisch".equals(site.tarifArt())
                || "ohne".equals(site.tarifArt());
        if (structured && maintained) {
            return structuredImportCtKwh(site.supplyPrice(), spotEurMwh);
        }
        if ("dynamisch".equals(site.tarifArt()) && site.tarifParamCtKwh() != null) {
            return spotEurMwh == null ? null : spotEurMwh / 10.0 + site.tarifParamCtKwh();
        }
        if (structured && defaultSupplyComponents) {
            return structuredImportCtKwh(DEFAULT_SUPPLY_PRICE, spotEurMwh);
        }
        return spotCt(spotEurMwh);
    }

    /** {@code (spot + Σ Komponenten netto) × (1 + USt)}, in ct/kWh. */
    private static Double structuredImportCtKwh(SupplyPrice supply, Double spotEurMwh) {
        if (spotEurMwh == null) {
            return null;
        }
        return (spotEurMwh / 10.0 + supply.componentsCtKwh()) * (1.0 + supply.ustPct() / 100.0);
    }

    // ---- SQL twins (the read-side aggregates' ONE price truth) --------------
    //
    // The Earnings/History aggregates value MILLIONS of 15-min slots in SQL, so
    // the import-price composition exists once more as a generated SQL fragment
    // - generated HERE, next to importPriceCtKwh, so both renderings of the
    // rule live in one file and change together (Stufe 3 of the
    // vp-nacht-bezug-e7 report: display and steering tell the SAME math).
    // Branch order and semantics MUST stay identical to importPriceCtKwh();
    // the equivalence is pinned vector-for-vector against real Postgres by
    // PortalApiTest.importPriceSqlMatchesTheSlotEconomicsCompositionVectors.

    /** The maintained-sheet gate in SQL (SupplyPrice.hasComponents twin). */
    private static final String SQL_SHEET_MAINTAINED =
            "(ssp.netzentgelt_arbeitspreis_ct IS NOT NULL OR ssp.stromsteuer_ct IS NOT NULL"
                    + " OR ssp.konzessionsabgabe_ct IS NOT NULL OR ssp.umlagen_ct IS NOT NULL"
                    + " OR ssp.vertriebsaufschlag_ct IS NOT NULL)";

    /** Σ of the maintained components in SQL (componentsCtKwh twin). */
    private static final String SQL_SHEET_COMPONENTS_CT =
            "(COALESCE(ssp.netzentgelt_arbeitspreis_ct, 0) + COALESCE(ssp.stromsteuer_ct, 0)"
                    + " + COALESCE(ssp.konzessionsabgabe_ct, 0) + COALESCE(ssp.umlagen_ct, 0)"
                    + " + COALESCE(ssp.vertriebsaufschlag_ct, 0))";

    /**
     * The SQL twin of {@link #importPriceCtKwh(Double)}: a ct/kWh expression
     * over a query that aliases the site row as {@code s} and LEFT JOINs its
     * supply-price sheet as {@code ssp}
     * ({@code LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id});
     * {@code spotEurMwhExpr} is the slot's day-ahead price expression in
     * EUR/MWh (NULL propagates to NULL, exactly like the Java twin - except
     * the flat {@code fest} tariff, which needs no spot). The
     * {@code defaultSupplyComponents} flag is folded in at query-build time
     * from the SAME mirrored {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS}
     * property the diagnostics view reads, its numbers taken from
     * {@link #DEFAULT_SUPPLY_PRICE} - flag semantics are identical for the
     * solver, the diagnostics and the earnings/history aggregates.
     */
    public static String importPriceCtSql(String spotEurMwhExpr, boolean defaultSupplyComponents) {
        String spotCt = "(" + spotEurMwhExpr + " / 10.0)";
        StringBuilder sql = new StringBuilder("(CASE")
                .append(" WHEN s.tarif_art = 'fest' AND s.tarif_param_ct_kwh IS NOT NULL")
                .append(" THEN s.tarif_param_ct_kwh")
                .append(" WHEN s.tarif_art IN ('dynamisch', 'ohne') AND ").append(SQL_SHEET_MAINTAINED)
                .append(" THEN (").append(spotCt).append(" + ").append(SQL_SHEET_COMPONENTS_CT)
                .append(") * (1 + ssp.ust_pct / 100.0)")
                .append(" WHEN s.tarif_art = 'dynamisch' AND s.tarif_param_ct_kwh IS NOT NULL")
                .append(" THEN ").append(spotCt).append(" + s.tarif_param_ct_kwh");
        if (defaultSupplyComponents) {
            sql.append(" WHEN s.tarif_art IN ('dynamisch', 'ohne')")
                    .append(" THEN (").append(spotCt).append(" + ")
                    .append(DEFAULT_SUPPLY_PRICE.componentsCtKwh()).append(") * ")
                    .append(1.0 + DEFAULT_SUPPLY_PRICE.ustPct() / 100.0);
        }
        return sql.append(" ELSE ").append(spotCt).append(" END)").toString();
    }

    /**
     * SQL boolean: does {@link #importPriceCtSql} value this site's import
     * beyond bare spot (i.e. did any tariff/sheet/default branch engage)?
     * Same aliases and branch conditions as the price expression - drives the
     * honest "bewertet zu Ihrem Stromtarif" vs "zu Börsenpreisen" labeling
     * (a bare {@code tarif_art} echo cannot tell an {@code ohne} site with a
     * maintained Preisblatt from one without).
     */
    public static String tarifPricedSql(boolean defaultSupplyComponents) {
        String structured = defaultSupplyComponents
                ? "s.tarif_art IN ('dynamisch', 'ohne')"
                : "s.tarif_art IN ('dynamisch', 'ohne') AND " + SQL_SHEET_MAINTAINED;
        return "((s.tarif_art = 'fest' AND s.tarif_param_ct_kwh IS NOT NULL)"
                + " OR (" + structured + ")"
                + " OR (s.tarif_art = 'dynamisch' AND s.tarif_param_ct_kwh IS NOT NULL))";
    }

    /**
     * What one exported kWh really earns in this slot (ct/kWh), per the
     * plant's remuneration: Direktvermarktung = spot + dynamic Marktprämie
     * ({@code max(anzulegender Wert - Monatsmarktwert, 0)}, suspended at
     * negative spot, only when the month's value is known); Eigenverbrauch =
     * the feste Vergütung (flat; §51a zeroes it at negative spot for plants
     * commissioned on/after 2025-02-25; expired/unknown commissioning = bare
     * spot); merchant mode ({@code netzladen_erlaubt}) = bare spot regardless
     * (Ausschließlichkeitsprinzip - mirrors pricing.py's guard).
     */
    public Double exportValueCtKwh(Double spotEurMwh, Instant slotStart) {
        if (site.netzladenErlaubt()) {
            return spotCt(spotEurMwh);
        }
        if ("direktvermarktung".equals(site.plantKind())) {
            if (site.anzulegenderWertCtKwh() == null || spotEurMwh == null) {
                return spotCt(spotEurMwh);
            }
            MarketValue mv = marketValuesByMonth.get(berlinMonth(slotStart));
            if (mv == null || spotEurMwh < 0) {
                return spotEurMwh / 10.0;
            }
            return spotEurMwh / 10.0 + Math.max(site.anzulegenderWertCtKwh() - mv.ctKwh(), 0.0);
        }
        if ("eigenverbrauch".equals(site.plantKind())) {
            LocalDate commissioned = site.pvCommissionedOn();
            if (commissioned == null || EegRates.remunerationExpired(commissioned, slotStart)) {
                return spotCt(spotEurMwh);
            }
            double rate = eegRates.festeVerguetungCtPerKwh(commissioned, site.pvCapacityKwp());
            if (!commissioned.isBefore(EegRates.SOLARSPITZENGESETZ_CUTOFF)) {
                if (spotEurMwh == null) {
                    return null; // §51a needs the spot sign - unknown = unknowable
                }
                return spotEurMwh >= 0 ? rate : 0.0;
            }
            return rate;
        }
        return spotCt(spotEurMwh);
    }

    /**
     * The wear rate this slot's battery move actually spent (ct per kWh of
     * throughput), derived from the PERSISTED {@code schedule.wear_cost_eur} -
     * the real P2 objective term, not an estimate. Null for idle slots (no
     * throughput = no rate) and for pre-P2 rows (NULL column).
     */
    public static Double wearCostCtKwh(Double wearCostEur, Double batteryKw, double slotHours) {
        if (wearCostEur == null || batteryKw == null
                || Math.abs(batteryKw) <= SLOT_DEADBAND_KW) {
            return null;
        }
        double throughputKwh = Math.abs(batteryKw) * slotHours;
        return wearCostEur * 100.0 / throughputKwh;
    }

    /**
     * The approximate value of one kWh sitting in the battery at each slot
     * (ct/kWh): the best forward best-use price still reachable within the
     * horizon ({@code max(import, export)} over the remaining slots - avoided
     * import counts, like the P3 terminal value's best-use definition),
     * discounted by one-way efficiency and the pending discharge wear:
     * {@code eta * (maxForwardBestUse - wear/2)}, floored at 0.
     *
     * <p><b>An APPROXIMATION by design</b> (design report §4.2 option (b)): the
     * exact number is the MILP's SoC shadow price, which is not persisted. The
     * UI must label it as such. Null per slot when no forward slot has a
     * computable price, and null throughout for battery-less sites (no
     * efficiency/wear to discount with) - never a fake 0.
     */
    public List<Double> storedEnergyValuesCtKwh(List<Double> importCt, List<Double> exportCt) {
        int n = importCt.size();
        List<Double> values = new ArrayList<>(java.util.Collections.nCopies(n, (Double) null));
        if (site.roundtripEfficiency() == null || site.wearCostCtPerKwh() == null) {
            return values;
        }
        double eta = Math.sqrt(site.roundtripEfficiency());
        double wearEachWayCt = site.wearCostCtPerKwh() / 2.0;
        Double forwardBest = null;
        for (int i = n - 1; i >= 0; i--) {
            Double best = maxNullable(importCt.get(i), exportCt.get(i));
            forwardBest = maxNullable(forwardBest, best);
            if (forwardBest != null) {
                values.set(i, Math.max(0.0, eta * (forwardBest - wearEachWayCt)));
            }
        }
        return values;
    }

    /** Mirrors frontend/portal src/schedule.ts PV_SOURCE_DEADBAND_KW. */
    public static final double PV_SOURCE_DEADBAND_KW = 0.1;

    /**
     * What the slot does with the battery - the server-side twin of
     * frontend/portal src/schedule.ts {@code chargeKind} (same deadbands, same
     * energy-source-honest netzladen derivation): {@code solarladen} |
     * {@code netzladen} | {@code entladen} | {@code ruhe}.
     *
     * <p>PV-aware since FK3 (PV-bus semantics): an EEG site legitimately
     * charges solar WHILE the house imports its load, so a charging slot is
     * {@code netzladen} only when the charge EXCEEDS the slot's available PV
     * ({@code pv - curtail}) - the solver's own solar-only bound. Without a PV
     * value the old, coarser charging-while-importing rule applies.
     */
    public static String decisionLabel(Double batteryKw, Double gridKw, Double pvKw,
            Double curtailKw) {
        if (batteryKw == null || Math.abs(batteryKw) <= SLOT_DEADBAND_KW) {
            return "ruhe";
        }
        if (batteryKw < 0) {
            return "entladen";
        }
        // Grid energy can only flow INTO the battery while the slot net-imports.
        if (gridKw == null || gridKw <= SLOT_DEADBAND_KW) {
            return "solarladen";
        }
        if (pvKw == null) {
            return "netzladen"; // no PV data: the pre-pvKw fallback
        }
        double available = Math.max(pvKw - Math.max(curtailKw == null ? 0 : curtailKw, 0), 0);
        return batteryKw > available + PV_SOURCE_DEADBAND_KW ? "netzladen" : "solarladen";
    }

    /**
     * ONE plain-German sentence explaining the slot's decision from its real
     * economics (the brief's "warum" ask). Composed from the already-computed
     * fields; degrades to a number-free sentence when a needed value is null
     * instead of inventing one.
     */
    public static String whyText(String label, Double batteryKw, Double gridKw,
            Double curtailKw, Double importCt, Double exportCt, Double storedCt) {
        String base = switch (label) {
            case "entladen" -> {
                double kw = Math.abs(batteryKw != null ? batteryKw : 0);
                boolean exporting = gridKw != null && gridKw < -SLOT_DEADBAND_KW;
                if (exporting) {
                    yield exportCt != null && storedCt != null
                            ? String.format(Locale.GERMANY,
                                    "Entlädt %.1f kW und speist ein: Einspeisewert %.1f ct/kWh "
                                            + "liegt über dem Wert gespeicherter Energie (≈ %.1f ct/kWh).",
                                    kw, exportCt, storedCt)
                            : String.format(Locale.GERMANY, "Entlädt %.1f kW und speist ein.", kw);
                }
                yield importCt != null && storedCt != null
                        ? String.format(Locale.GERMANY,
                                "Entlädt %.1f kW für den Eigenverbrauch: vermiedener Netzbezug zu "
                                        + "%.1f ct/kWh liegt über dem Wert gespeicherter Energie (≈ %.1f ct/kWh).",
                                kw, importCt, storedCt)
                        : String.format(Locale.GERMANY,
                                "Entlädt %.1f kW für den Eigenverbrauch.", kw);
            }
            case "netzladen" -> importCt != null && storedCt != null
                    ? String.format(Locale.GERMANY,
                            "Lädt %.1f kW aus dem Netz: Bezug zu %.1f ct/kWh ist günstiger als der "
                                    + "spätere Wert der gespeicherten Energie (≈ %.1f ct/kWh nach "
                                    + "Verlusten und Verschleiß).",
                            batteryKw, importCt, storedCt)
                    : String.format(Locale.GERMANY, "Lädt %.1f kW aus dem Netz.", batteryKw);
            case "solarladen" -> storedCt != null && exportCt != null
                    ? String.format(Locale.GERMANY,
                            "Speichert %.1f kW PV-Überschuss: spätere Nutzung (≈ %.1f ct/kWh) ist "
                                    + "mehr wert als sofortige Einspeisung zu %.1f ct/kWh.",
                            batteryKw, storedCt, exportCt)
                    : String.format(Locale.GERMANY, "Speichert %.1f kW PV-Überschuss.", batteryKw);
            default -> "Speicher ruht: kein Zyklus, dessen Ertrag Verschleiß und Verluste deckt.";
        };
        if (curtailKw != null && curtailKw > CURTAIL_DEADBAND_KW) {
            if (exportCt != null && exportCt < 0) {
                base += String.format(Locale.GERMANY,
                        " Drosselt %.1f kW PV: Einspeisung würde bei %.1f ct/kWh Geld kosten.",
                        curtailKw, exportCt);
            } else {
                base += String.format(Locale.GERMANY,
                        " Drosselt %.1f kW PV (Einspeisebegrenzung).", curtailKw);
            }
        }
        return base;
    }

    /** First day of the German calendar month containing the slot (the
     * monthly_market_value.month key - mirrors pricing.py berlin_month). */
    public static LocalDate berlinMonth(Instant at) {
        return at.atZone(BERLIN).toLocalDate().withDayOfMonth(1);
    }

    private static Double spotCt(Double spotEurMwh) {
        return spotEurMwh == null ? null : spotEurMwh / 10.0;
    }

    private static Double maxNullable(Double a, Double b) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        return Math.max(a, b);
    }
}
