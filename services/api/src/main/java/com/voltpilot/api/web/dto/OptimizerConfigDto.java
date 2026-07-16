package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * The admin optimizer-config panel of one site (design
 * vp-admin-optimizer-ui-design §2.7): platform defaults vs. the per-site /
 * per-asset overrides, and the effective values the optimizer resolves.
 *
 * <p>{@code overrides} are the nullable DB columns (null = platform default
 * applies); {@code effective} is what the optimizer actually uses
 * (override ?? default). {@code defaults} mirrors the optimizer's env-level
 * tunables (the api receives the SAME {@code OPTIMIZER_*} variables - see
 * OptimizerProperties); the terminal-value fields are READ-ONLY here
 * (env-level, changing them is a redeploy, not an API write).
 *
 * <p>{@code site} echoes the levers that were ALREADY editable before this
 * panel - {@code netzladen_erlaubt}, {@code plant_kind},
 * {@code tarif_art}/{@code tarif_param_ct_kwh},
 * {@code anzulegender_wert_ct_kwh} - which stay writable via the existing
 * {@code PUT /api/v1/sites/{id}} (with the {@code X-Tenant-Id} switcher for
 * admins), NOT via this endpoint; they are included read-only so the panel can
 * render the whole picture in one call.
 *
 * <p>{@code hasBattery} is false for sites without a battery asset: the
 * optimizer never plans them and the battery overrides cannot be written
 * (409 on the PUT).
 *
 * <p>{@code peakShaving} (PS-1/PS-2, migration V20260716020000) is the
 * Lastspitzenkappung module: a non-null {@code leistungspreisEurKw} IS the
 * module-active flag. Configured HERE (admin-only, captain decision:
 * VoltPilot richtet vertragsnahe Module ein, nicht der Kunde) and echoed
 * read-only on the customer {@code SiteDto}.
 */
public record OptimizerConfigDto(
        UUID siteId,
        boolean hasBattery,
        PlatformDefaults defaults,
        Overrides overrides,
        Effective effective,
        PeakShaving peakShaving,
        SiteLevers site) {

    /** The optimizer's platform-wide tunables (env-level; read-only here). */
    public record PlatformDefaults(
            double wearCostCtPerKwh,
            double socMinPct,
            double socMaxPct,
            double terminalValueQuantile,
            Double terminalValueCtPerKwh) {
    }

    /** The nullable per-site / per-asset override columns (null = default). */
    public record Overrides(
            BigDecimal wearCostCtPerKwh,
            BigDecimal socMinPct,
            BigDecimal socMaxPct,
            BigDecimal backupReserveSocPct) {
    }

    /**
     * What the optimizer resolves: override ?? platform default. The backup
     * reserve has no platform default - null means "no reserve, the technical
     * SoC floor applies unchanged".
     */
    public record Effective(
            Double wearCostCtPerKwh,
            Double socMinPct,
            Double socMaxPct,
            BigDecimal backupReserveSocPct) {
    }

    /**
     * The peak-shaving module (Lastspitzenkappung, PS-1/PS-2).
     * {@code leistungspreisEurKw} is the RLM Leistungspreis in EUR per kW per
     * billing period - null = module OFF (no separate flag, the
     * max_feed_in_kw philosophy). {@code abrechnungLeistung} is
     * {@code jahr} | {@code monat} (the Europe/Berlin calendar period the
     * peak anchor spans; the DB default is {@code jahr}).
     * {@code peakReserveSocPct} is the PS-2 hard SoC floor reserved for
     * out-of-horizon peaks (stacks with the backup reserve: the highest
     * configured absolute floor binds); null = no peak reserve.
     */
    public record PeakShaving(
            BigDecimal leistungspreisEurKw,
            String abrechnungLeistung,
            BigDecimal peakReserveSocPct) {
    }

    /** Read-only echo of the site levers editable via PUT /api/v1/sites/{id}. */
    public record SiteLevers(
            boolean netzladenErlaubt,
            String plantKind,
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            BigDecimal anzulegenderWertCtKwh) {
    }
}
