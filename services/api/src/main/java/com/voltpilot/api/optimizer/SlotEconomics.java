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
     * The pricing-relevant site master data (the SiteTariff twin). Battery
     * fields are null for battery-less sites - stored-energy values are then
     * honestly absent. {@code roundtripEfficiency} is the 0..1 fraction
     * (defaulted to 0.92 when the asset column is NULL, mirroring
     * inputs.load_battery_sites); {@code wearCostCtPerKwh} is the EFFECTIVE
     * per-cycle rate (asset override or platform default).
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
            Double wearCostCtPerKwh) {
    }

    private final SiteEconomics site;
    private final EegRates eegRates;
    private final Map<LocalDate, MarketValue> marketValuesByMonth;

    public SlotEconomics(SiteEconomics site, EegRates eegRates,
            Map<LocalDate, MarketValue> marketValuesByMonth) {
        this.site = site;
        this.eegRates = eegRates;
        this.marketValuesByMonth = marketValuesByMonth;
    }

    /**
     * What one imported kWh really costs the site in this slot (ct/kWh), per
     * its supply tariff: {@code dynamisch} = spot + Aufschlag, {@code fest} =
     * the flat retail price (spot-independent), {@code ohne}/unknown = bare
     * spot. Null when the slot has no persisted spot price (except the flat
     * tariff, which needs none).
     */
    public Double importPriceCtKwh(Double spotEurMwh) {
        if ("dynamisch".equals(site.tarifArt())) {
            if (spotEurMwh == null) {
                return null;
            }
            double aufschlag = site.tarifParamCtKwh() != null ? site.tarifParamCtKwh() : 0.0;
            return spotEurMwh / 10.0 + aufschlag;
        }
        if ("fest".equals(site.tarifArt()) && site.tarifParamCtKwh() != null) {
            return site.tarifParamCtKwh();
        }
        return spotCt(spotEurMwh);
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

    /**
     * What the slot does with the battery - the server-side twin of
     * frontend/portal src/schedule.ts {@code chargeKind} (same deadband, same
     * energy-source-honest netzladen derivation): {@code solarladen} |
     * {@code netzladen} | {@code entladen} | {@code ruhe}.
     */
    public static String decisionLabel(Double batteryKw, Double gridKw) {
        if (batteryKw == null || Math.abs(batteryKw) <= SLOT_DEADBAND_KW) {
            return "ruhe";
        }
        if (batteryKw < 0) {
            return "entladen";
        }
        return gridKw != null && gridKw > SLOT_DEADBAND_KW ? "netzladen" : "solarladen";
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
