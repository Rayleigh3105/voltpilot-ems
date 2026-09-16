package com.voltpilot.api.web;

import com.voltpilot.api.chargers.ChargerComponentComposer;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.profile.AnwendungDerivation;
import com.voltpilot.api.profile.AnwendungKatalog;
import com.voltpilot.api.profile.UsageProfileDeriver;
import com.voltpilot.api.repo.OverviewRepository;
import com.voltpilot.api.repo.SiteProfileStateRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.RollenZuordnungService;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;
import com.voltpilot.api.uems.StandortLesemodellService;
import com.voltpilot.api.web.dto.OverviewDto;
import com.voltpilot.api.web.dto.OverviewDto.EnergyTodayDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewDailySavingsDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewLiveDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewSiteDto;
import com.voltpilot.api.web.dto.OverviewDto.OverviewTotalsDto;
import com.voltpilot.api.web.dto.OverviewDto.RoleCountsDto;
import com.voltpilot.api.web.dto.RollenDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.TeilansichtDto;
import com.voltpilot.api.zugriff.TeilansichtDienst;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 * <p>Everything reads through the RLS-scoped app datasource - die Aggregation
 * hat bewusst KEIN eigenes Anlagen-Prädikat, RLS ist der Zaun: der Mandant
 * (V2) und seit UEMS AP-03 IP-5 der Standort ({@code site_scope}). Die Flotte
 * ist damit genau die Menge der SICHTBAREN Anlagen des Aufrufers, und
 * {@code totals} summiert über genau diese Menge - nie mandantenweit (IP-10,
 * Regel R-A2). Additiv trägt die Antwort {@code teilansicht {sichtbar,
 * gesamt}}. Admins get another tenant's fleet via the {@code X-Tenant-Id}
 * switcher like every customer endpoint.
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

    /**
     * Nachschau-Fenster für „wann lief der Optimierer zuletzt". Der Optimierer
     * plant alle 15 Minuten; ein Lauf, der älter als das hier ist, ist für die
     * Betriebsfrage ohnehin „kein aktueller Plan" - und die Grenze hält die
     * Abfrage von einem Scan über die ganze Plan-Historie ab.
     */
    private static final Duration PLAN_LOOKBACK = Duration.ofDays(7);

    private final SiteRepository sites;
    private final OverviewRepository overview;
    private final EntityTypeCatalog catalog;
    private final AnwendungKatalog anwendungen;
    private final SiteProfileStateRepository profileStates;
    private final StandortLesemodellService standortLesemodell;
    private final RollenZuordnungService rollen;
    private final TeilansichtDienst teilansicht;

    public OverviewController(SiteRepository sites, OverviewRepository overview,
            EntityTypeCatalog catalog, AnwendungKatalog anwendungen,
            SiteProfileStateRepository profileStates,
            StandortLesemodellService standortLesemodell,
            RollenZuordnungService rollen,
            TeilansichtDienst teilansicht) {
        this.sites = sites;
        this.overview = overview;
        this.catalog = catalog;
        this.anwendungen = anwendungen;
        this.profileStates = profileStates;
        this.standortLesemodell = standortLesemodell;
        this.rollen = rollen;
        this.teilansicht = teilansicht;
    }

    // Rechte: lesendes Aggregat, keine eigene Kennung (AP-03 §4.5 R-A2, §6.2 IP-10).
    // authenticated() plus Mandanten-/Standort-RLS: nur die sichtbare Menge, wie bei GET /standorte.
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
        // U5 portfolio rollup: per-site entity role counts + usage profile, both
        // in ONE round trip so the portfolio table renders without N calls.
        Map<UUID, Map<String, Integer>> entityCounts = overview.entityTypeCountsPerSite();
        Map<UUID, Set<String>> strategyNodes = overview.activeNodeTypesPerSite();
        Map<UUID, Instant> lastPlan = overview.lastPlanPerSite(Instant.now().minus(PLAN_LOOKBACK));
        // Stufe 4: die Flotten-Zeile trägt ihre aktiven Anwendungen und die
        // Zahlen, aus denen das Portfolio-Cockpit seine Bausteine komponiert.
        Map<UUID, BigDecimal> storagePerSite = overview.storageCapacityPerSite();
        Map<UUID, OverviewRepository.EnergyRow> energyToday =
                overview.energyPerSite(todayWindow.from(), todayWindow.to());
        Set<UUID> gridLimitSites = overview.sitesWithGridLimit();
        Map<UUID, Map<String, String>> storedStates = profileStates.findAllForTenant();
        // UEMS AP-02 IP-3: der Standort je Anlage heute - additiv, null solange
        // eine Anlage keinem Standort zugeordnet ist (heute: jede).
        Map<UUID, StandortBezug> standortJeAnlage = standortLesemodell.bezugJeAnlage();
        // Nur die Live-Anzeige liest die kanonischen Rollen, je Rolle eine Flotten-Abfrage.
        // Ohne Zuordnung bleibt die Roh-Telemetrie unverändert.
        Map<UUID, RollenDto.KanonischerWert> pvKanonisch = rollen.rollenJeAnlage("pv");
        Map<UUID, RollenDto.KanonischerWert> verbrauchKanonisch = rollen.rollenJeAnlage("consumer");
        Map<UUID, RollenDto.KanonischerWert> netzKanonisch = rollen.rollenJeAnlage("grid");

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
            OverviewLiveDto live = liveDto(liveRow, pvKanonisch.get(site.id()),
                    verbrauchKanonisch.get(site.id()), netzKanonisch.get(site.id()));
            if (liveRow != null && !liveRow.ts().isBefore(freshnessCutoff)) {
                liveSitesCovered++;
            }

            BigDecimal savings = savingsPerSite.get(site.id());
            if (savings != null) {
                totalSavings = totalSavings == null ? savings : totalSavings.add(savings);
            }

            Map<String, Integer> typeCounts = entityCounts.getOrDefault(site.id(), Map.of());
            OverviewRepository.EnergyRow energy = energyToday.get(site.id());
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
                    savings,
                    roleCounts(typeCounts),
                    usageProfile(site, typeCounts,
                            strategyNodes.getOrDefault(site.id(), Set.of())),
                    lastPlan.get(site.id()),
                    storagePerSite.get(site.id()),
                    energy == null ? null : new EnergyTodayDto(energy.pvKwh(), energy.loadKwh(),
                            energy.gridImportKwh(), energy.gridExportKwh()),
                    typeCounts.getOrDefault(ChargerComponentComposer.TYPE_EV_CHARGER, 0),
                    aktiveAnwendungen(site, typeCounts,
                            strategyNodes.getOrDefault(site.id(), Set.of()),
                            liveRow != null, gridLimitSites.contains(site.id()),
                            storedStates.getOrDefault(site.id(), Map.of())),
                    standortJeAnlage.get(site.id())));
        }

        OverviewRepository.StorageTotals storage = overview.storageTotals();

        List<OverviewDailySavingsDto> dailySavings = overview
                .dailySavings(chartFrom, todayWindow.to()).stream()
                .map(d -> new OverviewDailySavingsDto(d.day(), d.savingsEur()))
                .toList();

        // Die Teilansicht (IP-10): über wie viele Standorte diese Antwort entstand und wie viele der
        // Kundenbereich hat - eine ANZAHL, keine Summe. Jede Zahl darüber steht in `totals`, und die entsteht
        // über `fleet` und sonst nichts.
        TeilansichtDto teilansichtDto = teilansicht.jetzt();

        return new OverviewDto(
                fleet,
                new OverviewTotalsDto(
                        siteRows.size(), totalDevices, totalOnline, totalSavings, liveSitesCovered,
                        storage.capacityKwh(), storage.powerKw()),
                dailySavings,
                teilansichtDto);
    }

    /** Rollen lenken ausschließlich die Live-Anzeige um; null bleibt unbekannt, nie Rohwert/0. */
    private static OverviewLiveDto liveDto(OverviewRepository.LiveRow liveRow,
            RollenDto.KanonischerWert pv, RollenDto.KanonischerWert verbrauch,
            RollenDto.KanonischerWert netz) {
        if (liveRow == null) return null;
        return new OverviewLiveDto(liveRow.ts(), rollenWert(pv, liveRow.pvKw()),
                rollenWert(verbrauch, liveRow.loadKw()), rollenWert(netz, liveRow.gridKw()), liveRow.socPct());
    }

    private static BigDecimal rollenWert(RollenDto.KanonischerWert rolle, BigDecimal rohwert) {
        if (rolle == null || !rolle.zuordnungVorhanden()) return rohwert;
        return rolle.wert() == null ? null : BigDecimal.valueOf(rolle.wert());
    }

    /**
     * Σ v2 entities per role for the portfolio "Entitäten" badge: count each
     * entity_type into its role via the catalog category (storage→storage,
     * producer→pv, meter→grid, consumer→consumer). One entity counts once
     * (a battery-hybrid is one storage entity, never also pv); unknown
     * categories are ignored. A registry-less site yields all zeros.
     */
    private RoleCountsDto roleCounts(Map<String, Integer> typeCounts) {
        int pv = 0;
        int storage = 0;
        int consumer = 0;
        int grid = 0;
        for (Map.Entry<String, Integer> e : typeCounts.entrySet()) {
            EntityTypeCatalog.EntityType type = catalog.find(e.getKey());
            String category = type == null ? "" : type.category();
            int n = e.getValue();
            switch (category) {
                case "storage" -> storage += n;
                case "producer" -> pv += n;
                case "consumer" -> consumer += n;
                case "meter" -> grid += n;
                default -> { /* unknown/other category: not counted */ }
            }
        }
        return new RoleCountsDto(pv, storage, consumer, grid);
    }

    /**
     * The site's effective AE7 usage profile (arbitrage | peak | private) for
     * the portfolio Profil-Chip - the SAME {@link UsageProfileDeriver} the
     * profile endpoint runs, fed the signals derivable from this ONE overview
     * pass: the entity mix (catalog category), the strategy nodes of the site's
     * ACTIVE flows (extracted in SQL - see
     * {@link OverviewRepository#activeStrategyNodeTypesPerSite()}), and the money
     * master data (plantKind / Leistungspreis / override).
     */
    private String usageProfile(SiteDto site, Map<String, Integer> typeCounts,
            Set<String> strategyNodeTypes) {
        boolean hasStorage = false;
        boolean hasPv = false;
        boolean hasControllableConsumer = false;
        // Der Ladepunkt-Anteil ist die EINE Divergenz, die der 7-Arg-Konstruktor
        // hinterlassen hat: er stempelte hasChargePoint auf false, also konnte
        // das Overview NIE `laden` melden, während `GET /sites/{id}/profile` es
        // sehr wohl tut - dieselbe Frage mit zwei Antworten. Die Regel ist die
        // von UsageProfileService.signals: der Ladepunkt keyt auf den TYP.
        boolean hasChargePoint =
                typeCounts.containsKey(ChargerComponentComposer.TYPE_EV_CHARGER);
        for (String entityType : typeCounts.keySet()) {
            EntityTypeCatalog.EntityType type = catalog.find(entityType);
            String category = type == null ? "" : type.category();
            switch (category) {
                case "storage" -> hasStorage = true;
                case "producer" -> hasPv = true;
                case "consumer" -> hasControllableConsumer =
                        hasControllableConsumer || (type != null && type.controllable());
                default -> { /* meter/other: no signal */ }
            }
        }
        // Only Leistungspreis/strategy-nodes/plantKind/override steer the derived
        // profile (deriveDefault); the entity signals are reported for parity
        // with the profile endpoint, never decisive here.
        return UsageProfileDeriver.effectiveProfile(new UsageProfileDeriver.Signals(
                hasStorage, hasPv, hasControllableConsumer, hasChargePoint, strategyNodeTypes,
                site.plantKind(), site.leistungspreisEurKw() != null, site.usageProfileOverride()));
    }

    /**
     * Die AKTIVEN Anwendungen dieser Anlage (Anwendungs-Programm Stufe 4) —
     * derselbe Vorrang wie im Regal ({@code SiteProfileService.shelf}): ein
     * gespeichertes {@code aus} gewinnt, sonst ein gespeichertes {@code an},
     * sonst die reine Ableitung.
     *
     * <p><b>Warum das hier steht und nicht im Portal:</b> das Portfolio-Cockpit
     * komponiert seine Bausteine aus der VEREINIGUNG über alle Anlagen, und der
     * gespeicherte Kundenwille ({@code site_profile_state}) liegt allein auf dem
     * Server. Ohne ihn bliebe eine abgeschaltete Anwendung sichtbar — das wäre
     * eine Fläche, die dem Kunden widerspricht.
     *
     * <p><b>⚠ Die Übersicht rechnet KEINE Voraussetzungs-Chips</b> (dafür gibt
     * es {@code GET /sites/{id}/profiles}) — {@code hasMeasurement} und
     * {@code hasGridLimit} gehen trotzdem WAHRHEITSGEMÄSS hinein, damit die
     * Eingabe nie eine Behauptung enthält, die niemand geprüft hat.
     */
    private List<String> aktiveAnwendungen(SiteDto site, Map<String, Integer> typeCounts,
            Set<String> activeNodeTypes, boolean hasLive, boolean hasGridLimit,
            Map<String, String> stored) {
        boolean hasStorage = false;
        boolean hasPv = false;
        boolean hasControllableConsumer = false;
        boolean hasChargePoint = typeCounts.containsKey(ChargerComponentComposer.TYPE_EV_CHARGER);
        for (String entityType : typeCounts.keySet()) {
            EntityTypeCatalog.EntityType type = catalog.find(entityType);
            String category = type == null ? "" : type.category();
            switch (category) {
                case "storage" -> hasStorage = true;
                case "producer" -> hasPv = true;
                case "consumer" -> hasControllableConsumer =
                        hasControllableConsumer || (type != null && type.controllable());
                default -> { /* meter/other: no signal */ }
            }
        }
        // `hasCustomerRule` beantwortet nur den Leer-Zustand einer
        // Regel-Anwendung (den die Übersicht nicht rendert); die Ableitung
        // selbst konsultiert es nicht.
        AnwendungDerivation.Input in = new AnwendungDerivation.Input(hasStorage, hasPv,
                hasControllableConsumer, hasChargePoint, hasLive,
                site.leistungspreisEurKw() != null, hasGridLimit, activeNodeTypes, false,
                site.plantKind(), site.tarifArt(), site.netzladenErlaubt());
        List<String> aktiv = new java.util.ArrayList<>();
        for (AnwendungKatalog.Anwendung a : anwendungen.alle()) {
            String state = stored.get(a.id());
            if (SiteProfileStateRepository.STATE_AUS.equals(state)) {
                continue;
            }
            if (SiteProfileStateRepository.STATE_AN.equals(state)
                    || AnwendungDerivation.derivedActive(a.id(), in)) {
                aktiv.add(a.id());
            }
        }
        return List.copyOf(aktiv);
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
