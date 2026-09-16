package com.voltpilot.api.web.dto;

import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The fleet overview behind {@code GET /api/v1/overview} (see
 * docs/contracts/openapi.yaml): one aggregate the portal's adaptive Übersicht
 * renders for customers with several sites - per-site status + live snapshot +
 * today's planned savings, plus fleet totals and the per-day savings series for
 * the hero's 14-day mini chart.
 *
 * <p>Everything is read through the RLS-scoped app datasource: der
 * Mandanten-Zaun und - seit UEMS AP-03 IP-5 - der Standort-Zaun
 * {@code site_scope}. <b>Liste UND Summen entstehen darum über genau die
 * SICHTBAREN Anlagen</b>, nie mandantenweit (IP-10, Regel R-A2). {@code totals}
 * ist die Summe über {@code sites} und über nichts sonst; {@link TeilansichtDto}
 * sagt additiv, über wie viele Standorte das war.
 */
public record OverviewDto(
        List<OverviewSiteDto> sites,
        OverviewTotalsDto totals,
        List<OverviewDailySavingsDto> dailySavings,
        TeilansichtDto teilansicht) {

    /**
     * One site of the fleet.
     *
     * <p>{@code onlineCount}/{@code waitingCount}/{@code worstStatus} derive from
     * each device's newest telemetry ARRIVAL ({@code max(received_at)} - the
     * store-and-forward liveness rule, see migration V20260703000000), with the
     * same 5-minute window the portal uses ({@code api.ts ONLINE_WINDOW_MS}).
     * {@code worstStatus}: {@code stale} (a device went silent) beats
     * {@code waiting} (a device never sent) beats {@code online}; {@code null}
     * for a site without devices.
     *
     * <p>{@code live} is the site's newest telemetry OBSERVATION (one row), with
     * PV/load/grid replaced by their canonical display role only where explicitly assigned
     * (an assigned but silent role remains null). Storage and timestamp retain raw telemetry. The
     * portal decides freshness from its {@code ts}. {@code plannedSavingsTodayEur}
     * is the ex-ante optimizer number for today's Europe/Berlin day (latest run
     * per 15-min slot, the HistoryRepository.savings semantics); {@code null}
     * when no plan covers today - never a misleading zero.
     *
     * <p>{@code netzladenErlaubt} is the per-site grid-charging switch (badge
     * "Netzladen aktiv" vs. "Nur Solarladen (EEG)" on the fleet site card).
     *
     * <p>{@code batteryWithoutDevice} = the site has a battery asset with NO
     * controlling device: the optimizer plans it but can never publish the plan
     * to the edge. The portal shows a plain-German warning linking to the fix.
     *
     * <p>{@code roleCounts} (U5) is the Σ v2 entities per role (pv/storage/
     * consumer/grid), derived from the site's {@code measurement_point} entities
     * via the {@link com.voltpilot.api.entities.EntityTypeCatalog} category→role
     * map - the portfolio table's "Entitäten" column ("🔋2 ☀️3 ⚡1"); all zero
     * for a v1/registry-less site. {@code usageProfile} is the site's effective
     * AE7 profile ({@code arbitrage} | {@code peak} | {@code private}, the same
     * {@link com.voltpilot.api.profile.UsageProfileDeriver} the profile endpoint
     * runs) - the portfolio Profil-Chip, without an N-per-site round trip.
     *
     * <p>{@code storageCapacityKwh} ist die Speicher-Kapazität DIESER Anlage
     * (Stufe 4) — das GEWICHT des Portfolio-Ladestands. Ohne sie wäre der
     * Flotten-Ladestand das ungewichtete Mittel über Anlagen, und ein
     * 10-kWh-Haus zöge einen 120-kWh-Betrieb gleich stark. {@code null} = keine
     * Batterie (nie eine 0).
     *
     * <p>{@code energyToday} sind die Energie-Summen des laufenden
     * Europe/Berlin-Tages aus {@code telemetry_rollup_15m} — Energie darf man
     * summieren, anders als einen Prozentsatz. Jedes Feld einzeln {@code null},
     * wenn keine Viertelstunde diesen Kanal getragen hat.
     *
     * <p>{@code chargePointCount} ist die Zahl der {@code ev-charger}-Entitäten
     * (die Rollen-Zählung fasst sie unter {@code consumer} zusammen und kann
     * sie deshalb nicht beantworten).
     *
     * <p>{@code anwendungen} sind die AKTIVEN Anwendungen dieser Anlage — der
     * gespeicherte Kundenwille über der Ableitung, dieselbe Regel wie
     * {@code GET /sites/{id}/profiles}. Das Portfolio-Cockpit komponiert seine
     * Bausteine aus der VEREINIGUNG über die Anlagen; ohne dieses Feld müsste
     * es raten, und ein abgeschaltetes {@code marktvermarktung} bliebe
     * sichtbar.
     *
     * <p>{@code lastPlanGeneratedAt} ist der Zeitpunkt des JÜNGSTEN
     * Optimierer-Laufs dieser Anlage (Admin-Umbau Stufe 1, Spalte „Plan" der
     * Plattform-Übersicht). Der Optimierer plant alle 15 Minuten neu, das Alter
     * IST also die Aussage - anders als {@code plannedSavingsTodayEur}, das nur
     * „für heute existiert irgendein Plan" beantwortet. {@code null} = kein Lauf
     * im Nachschau-Fenster ({@link com.voltpilot.api.repo.OverviewRepository#lastPlanPerSite}),
     * nie ein erfundenes Alter.
     */
    public record OverviewSiteDto(
            UUID id,
            String name,
            String plantKind,
            boolean netzladenErlaubt,
            boolean batteryWithoutDevice,
            int deviceCount,
            int onlineCount,
            int waitingCount,
            String worstStatus,
            Instant lastSeenAt,
            OverviewLiveDto live,
            BigDecimal plannedSavingsTodayEur,
            RoleCountsDto roleCounts,
            String usageProfile,
            Instant lastPlanGeneratedAt,
            BigDecimal storageCapacityKwh,
            EnergyTodayDto energyToday,
            int chargePointCount,
            List<String> anwendungen,
            // UEMS AP-02 IP-3, additiv am Ende: der Standort der Anlage heute
            // ({id, name, kurzzeichen, gueltigAb}) oder null, solange sie keinem
            // zugeordnet ist — heute jede Bestandsanlage (die Zuordnung legt erst
            // die Bestandsübernahme IP-9 an).
            StandortBezug standort) {
    }

    /**
     * Die Energie-Summen eines Tages (kWh). Jedes Feld einzeln {@code null},
     * wenn die Anlage diesen Kanal nicht misst oder der Tag noch keine
     * verdichtete Viertelstunde hat — nie eine erfundene 0.
     */
    public record EnergyTodayDto(BigDecimal pvKwh, BigDecimal loadKwh, BigDecimal gridImportKwh,
            BigDecimal gridExportKwh) {
    }

    /**
     * Σ v2 entities per topology role for the portfolio "Entitäten" badge (U5).
     * An entity's role is its {@code entity_type}'s catalog category mapped to a
     * role: storage→storage, producer→pv, meter→grid, consumer→consumer; unknown
     * categories are not counted. Counts entities (one per entity), so a
     * battery-hybrid is one storage entity - not double-counted into pv.
     */
    public record RoleCountsDto(int pv, int storage, int consumer, int grid) {
    }

    /** Newest telemetry row of a site (observation time + the four channels). */
    public record OverviewLiveDto(
            Instant ts,
            BigDecimal pvKw,
            BigDecimal loadKw,
            BigDecimal gridKw,
            BigDecimal socPct) {
    }

    /**
     * Fleet totals. {@code plannedSavingsTodayEur} sums the sites' non-null
     * values ({@code null} when NO site has a plan today). {@code liveSitesCovered}
     * counts sites whose live snapshot is inside the 5-minute freshness window -
     * the portal only sums live power over those and says so.
     */
    /**
     * Die Summen über die SICHTBAREN Anlagen - jedes Feld entsteht über genau die Anlagen in
     * {@link OverviewDto#sites()}. {@code storageCapacityKwh}/{@code storagePowerKw} kommen aus
     * {@code OverviewRepository.storageTotals()}, das dafür seit IP-10 über {@code site} joint; die übrigen
     * summiert der Controller in der Schleife über dieselbe Liste. Kein Feld trägt eine mandantenweite Summe
     * (AP-03 §6.2 Punkt 6).
     */
    public record OverviewTotalsDto(
            int sites,
            int devices,
            int online,
            BigDecimal plannedSavingsTodayEur,
            int liveSitesCovered,
            BigDecimal storageCapacityKwh,
            BigDecimal storagePowerKw) {
    }

    /** One Europe/Berlin day of fleet-wide ex-ante savings (the hero mini chart). */
    public record OverviewDailySavingsDto(LocalDate day, BigDecimal savingsEur) {
    }
}
