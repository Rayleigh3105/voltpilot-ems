package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.OverviewRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.OverviewDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewDailySavingsDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewLiveDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewSiteDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewTotalsDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The tenant-wide fleet overview ({@code GET /api/v1/overview}) behind the
 * portal's adaptive Übersicht: per site the device status, the newest live
 * snapshot and today's planned savings, plus fleet totals and the 14-day
 * savings series for the hero. One request instead of 4-per-site polling.
 *
 * <p>Everything reads through the RLS-scoped app datasource - the aggregation
 * deliberately has NO site filter, so RLS is the only (and sufficient) fence:
 * the fleet is exactly the caller's tenant. Admins get another tenant's fleet
 * via the {@code X-Tenant-Id} switcher like every customer endpoint.
 *
 * <p>The savings windows are Europe/Berlin days ({@link HistoryRange}) computed
 * server-side - this replaces the portal's former client-side slot summing and
 * its browser-local-timezone day boundary.
 */
@RestController
@RequestMapping("/api/v1/overview")
public class OverviewController {

    /** Portal liveness window - keep in sync with api.ts ONLINE_WINDOW_MS. */
    private static final Duration ONLINE_WINDOW = Duration.ofMinutes(5);

    /** Days of the hero's savings mini chart (incl. today). */
    private static final int DAILY_SAVINGS_DAYS = 14;

    private final SiteRepository sites;
    private final OverviewRepository overview;

    public OverviewController(SiteRepository sites, OverviewRepository overview) {
        this.sites = sites;
        this.overview = overview;
    }

    @GetMapping
    public OverviewDto overview() {
        List<SiteDto> siteRows = sites.findAll();

        LocalDate today = LocalDate.now(HistoryRange.ZONE);
        HistoryRange.Window todayWindow = HistoryRange.DAY.window(today);
        Instant chartFrom = HistoryRange.DAY.window(today.minusDays(DAILY_SAVINGS_DAYS - 1)).from();

        Map<UUID, OverviewRepository.DeviceStats> deviceStats = overview.deviceStatsPerSite();
        Map<UUID, OverviewRepository.LiveRow> livePerSite = overview.latestLivePerSite();
        Map<UUID, BigDecimal> savingsPerSite =
                overview.savingsPerSite(todayWindow.from(), todayWindow.to());
        java.util.Set<UUID> unlinkedBattery = overview.sitesWithUnlinkedBattery();

        Instant freshnessCutoff = Instant.now().minus(ONLINE_WINDOW);
        int totalDevices = 0;
        int totalOnline = 0;
        int liveSitesCovered = 0;
        BigDecimal totalSavings = null;

        List<OverviewSiteDto> fleet = new java.util.ArrayList<>(siteRows.size());
        for (SiteDto site : siteRows) {
            OverviewRepository.DeviceStats stats = deviceStats.get(site.id());
            int deviceCount = stats == null ? 0 : stats.deviceCount();
            int onlineCount = stats == null ? 0 : stats.onlineCount();
            int waitingCount = stats == null ? 0 : stats.waitingCount();
            totalDevices += deviceCount;
            totalOnline += onlineCount;

            OverviewRepository.LiveRow liveRow = livePerSite.get(site.id());
            OverviewLiveDto live = liveRow == null ? null : new OverviewLiveDto(
                    liveRow.ts(), liveRow.pvKw(), liveRow.loadKw(), liveRow.gridKw(), liveRow.socPct());
            if (liveRow != null && !liveRow.ts().isBefore(freshnessCutoff)) {
                liveSitesCovered++;
            }

            BigDecimal savings = savingsPerSite.get(site.id());
            if (savings != null) {
                totalSavings = totalSavings == null ? savings : totalSavings.add(savings);
            }

            fleet.add(new OverviewSiteDto(
                    site.id(),
                    site.name(),
                    site.plantKind(),
                    site.netzladenErlaubt(),
                    unlinkedBattery.contains(site.id()),
                    deviceCount,
                    onlineCount,
                    waitingCount,
                    worstStatus(deviceCount, onlineCount, waitingCount),
                    stats == null ? null : stats.lastSeenAt(),
                    live,
                    savings));
        }

        List<OverviewDailySavingsDto> dailySavings = overview
                .dailySavings(chartFrom, todayWindow.to()).stream()
                .map(d -> new OverviewDailySavingsDto(d.day(), d.savingsEur()))
                .toList();

        return new OverviewDto(
                fleet,
                new OverviewTotalsDto(
                        siteRows.size(), totalDevices, totalOnline, totalSavings, liveSitesCovered),
                dailySavings);
    }

    /**
     * Worst device status of a site, in the portal's deviceLiveStatus
     * vocabulary: {@code stale} (a device went silent - a problem) beats
     * {@code waiting} (never sent - onboarding) beats {@code online};
     * {@code null} for a site without devices.
     */
    private static String worstStatus(int deviceCount, int onlineCount, int waitingCount) {
        if (deviceCount == 0) {
            return null;
        }
        int staleCount = deviceCount - onlineCount - waitingCount;
        if (staleCount > 0) {
            return "stale";
        }
        return waitingCount > 0 ? "waiting" : "online";
    }
}
