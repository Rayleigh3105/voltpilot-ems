package com.voltpilot.api.web;

import com.voltpilot.api.fleet.FleetPflege;
import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.forecast.ForecastModels;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.AdminFleetRepository;
import com.voltpilot.api.repo.AdminFleetRepository.DeviceStats;
import com.voltpilot.api.repo.AdminFleetRepository.EdgeReleaseRow;
import com.voltpilot.api.repo.AdminFleetRepository.EdgeVersionRow;
import com.voltpilot.api.repo.AdminFleetRepository.ExportCeiling;
import com.voltpilot.api.repo.AdminFleetRepository.FleetSiteRow;
import com.voltpilot.api.repo.AdminFleetRepository.FleetBoxRow;
import com.voltpilot.api.repo.AdminFleetRepository.LeadFacts;
import com.voltpilot.api.repo.AdminFleetRepository.ForecastRow;
import com.voltpilot.api.repo.AdminFleetRepository.PvPeak;
import com.voltpilot.api.repo.AdminFleetRepository.SourceCounts;
import com.voltpilot.api.repo.AdminFleetRepository.UpdateStatusRow;
import com.voltpilot.api.web.dto.AdminFleetDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetEdgeDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetBoxDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetFeedInDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetForecastDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetKwpDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetSiteDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetSourcesDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetUpdateDto;
import com.voltpilot.api.web.dto.ControlStatusDto;
import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Der EINE Flotten-Endpunkt der Plattform-Übersicht:
 * {@code GET /api/v1/admin/fleet} (Admin-Umbau Stufe 2).
 *
 * <p>Stufe 1 hat den Puls client-seitig aggregiert - je Mandant
 * {@code /overview} + Anlagen + {@code /edge-versions}, dazu je Anlage die
 * Quellen und beim Aufklappen zwei Steuerungs-Belege. Das war bewusst so
 * (Captain-Entscheid Q3: erprobter Mechanismus, kleine Flotte), skaliert aber
 * mit der Zahl der Mandanten × Anlagen. Hier wird daraus EINE Antwort.
 *
 * <p><b>Sicherheits-Disziplin, unverändert vom bestehenden Muster
 * übernommen:</b> die Route liegt unter {@code /api/v1/admin/**} und die Klasse
 * trägt {@code @PreAuthorize("hasRole('platform-admin')")} wie
 * {@link AdminController} - ein Kunden-Token bekommt 403, ein anonymer Aufruf
 * 401. Die RLS-Umgehung ist auf {@link AdminFleetRepository} beschränkt
 * (dieselbe dedizierte BYPASSRLS-Rolle wie {@code TenantRepository} /
 * {@code AdminSiteRepository}), read-only, ohne einen einzigen Schreibpfad. Die
 * Kunden-Endpunkte bleiben unangetastet auf dem RLS-Pfad - hier wird nichts
 * aufgeweicht und nichts neu erfunden.
 *
 * <p>Die Anlagen-Fakten bleiben gruppiert; additiv reist jede aktive Box mit
 * ihrem eigenen Verbindungs- und Versionsstand.
 */
@RestController
@RequestMapping("/api/v1/admin/fleet")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFleetController {

    /**
     * Nachschau-Fenster für „wann lief der Optimierer zuletzt" - identisch zum
     * {@link OverviewController}: der Optimierer plant alle 15 Minuten, alles
     * Ältere ist für die Betriebsfrage ohnehin „kein aktueller Plan", und die
     * Grenze hält die Abfrage vom Scan über die ganze Plan-Historie ab.
     */
    private static final Duration PLAN_LOOKBACK = Duration.ofDays(7);

    /**
     * Fenster der kWp-Plausibilität. Lang genug, dass jede Anlage einen sonnigen
     * Tag darin hatte (eine Spitze entsteht nicht im Nebel), kurz genug, dass
     * eine gerade behobene Fehlkonfiguration nicht ewig nachhallt.
     */
    private static final Duration PV_PEAK_LOOKBACK = Duration.ofDays(30);

    /**
     * Fenster der Einspeisegrenze-Plausibilität. Wie beim PV-Fenster: lang genug,
     * dass die Anlage darin an mehreren sonnigen Tagen ihre Export-Decke erreicht
     * hat (ein „klebt wiederholt" braucht Tage), kurz genug, dass eine gerade
     * korrigierte Grenze nicht ewig nachhallt.
     */
    private static final Duration FEED_IN_LOOKBACK = Duration.ofDays(30);

    /**
     * Fenster der Prognose-Bewertung. Die Auswertung läuft täglich; zwei Wochen
     * glätten Wetterlagen, ohne eine seit Tagen kaputte Prognose zu verstecken.
     */
    private static final int FORECAST_LOOKBACK_DAYS = 14;

    private final AdminFleetRepository fleet;
    private final ForecastModelService forecastModels;

    public AdminFleetController(AdminFleetRepository fleet, ForecastModelService forecastModels) {
        this.fleet = fleet;
        this.forecastModels = forecastModels;
    }

    // Lesend ohne eigene Kennung: bestehender Plattform-Zaun, einschließlich Unterstützungsauswahl und Ende.
    @GetMapping
    public AdminFleetDto fleet() {
        Instant now = Instant.now();
        List<FleetSiteRow> siteRows = fleet.sites();

        Map<UUID, List<FleetBoxRow>> boxes = new HashMap<>();
        for (FleetBoxRow box : fleet.boxes()) {
            boxes.computeIfAbsent(box.siteId(), ignored -> new ArrayList<>()).add(box);
        }
        Map<UUID, LeadFacts> leadFacts = fleet.leadFactsPerSite();

        Map<UUID, DeviceStats> deviceStats = fleet.deviceStatsPerSite();
        Map<UUID, Instant> lastPlan = fleet.lastPlanPerSite(now.minus(PLAN_LOOKBACK));
        Map<UUID, ControlStatusDto> control = fleet.controlPerSite();
        Map<UUID, CurtailmentStatusDto> curtailment = fleet.curtailmentPerSite();
        Map<UUID, EdgeVersionRow> edge = fleet.edgeVersionPerSite();
        Map<UUID, UpdateStatusRow> update = fleet.updateStatusPerSite();
        List<EdgeReleaseRow> releases = fleet.releases();
        Map<UUID, SourceCounts> sources = fleet.sourceCountsPerSite();
        Set<UUID> unlinkedBattery = fleet.sitesWithUnlinkedBattery();
        Set<UUID> withBattery = fleet.sitesWithBattery();
        Map<UUID, BigDecimal> pvCapacity = fleet.pvCapacityPerSite();
        Map<UUID, PvPeak> pvPeak = fleet.pvPeakPerSite(now.minus(PV_PEAK_LOOKBACK));
        Map<UUID, BigDecimal> maxFeedIn = fleet.maxFeedInPerSite();
        Map<UUID, ExportCeiling> feedInCeiling = fleet.feedInCeilingPerSite(now.minus(FEED_IN_LOOKBACK));

        // Die UNTERSTE Präzedenz-Stufe (Umgebungs-Vorgabe, validiert - eine
        // krumme Env-Variable fällt auf das Basismodell zurück statt gar nichts
        // zu treffen); die zwei Journale darüber löst die Abfrage JE ANLAGE auf.
        List<ForecastRow> forecastRows = fleet.forecastAccuracy(
                LocalDate.now(HistoryRange.ZONE).minusDays(FORECAST_LOOKBACK_DAYS),
                List.of(forecastModels.envDefault(ForecastModels.KIND_LOAD),
                        forecastModels.envDefault(ForecastModels.KIND_PV)));
        Map<UUID, List<FleetForecastDto>> forecast = FleetPflege.forecastChecks(forecastRows);

        List<FleetSiteDto> out = new ArrayList<>(siteRows.size());
        for (FleetSiteRow site : siteRows) {
            UUID id = site.siteId();
            List<FleetBoxRow> siteBoxes = boxes.getOrDefault(id, List.of());
            LeadFacts facts = leadFacts.get(id);
            UUID leading = com.voltpilot.api.uems.FuehrendeBoxAbleitung.ableiten(
                    siteBoxes.stream().map(FleetBoxRow::deviceId).toList(),
                    facts == null ? null : facts.batteryDeviceId(),
                    facts == null ? null : facts.storedDeviceId()).box();
            List<FleetBoxDto> boxDtos = siteBoxes.stream().map(box -> new FleetBoxDto(
                    box.deviceId(), box.externalRef(), box.name(),
                    leading == null ? null : leading.equals(box.deviceId()),
                    box.lastSeenAt(), edgeDto(box.edge()), updateDto(box.update()))).toList();
            DeviceStats stats = deviceStats.get(id);
            int deviceCount = stats == null ? 0 : stats.deviceCount();
            int onlineCount = stats == null ? 0 : stats.onlineCount();
            int waitingCount = stats == null ? 0 : stats.waitingCount();

            FleetKwpDto kwp = FleetPflege.kwp(pvCapacity.get(id), pvPeak.get(id));
            FleetFeedInDto feedIn = FleetPflege.feedIn(maxFeedIn.get(id), feedInCeiling.get(id));
            List<FleetForecastDto> siteForecast = forecast.getOrDefault(id, List.of());
            boolean batteryWithoutDevice = unlinkedBattery.contains(id);

            SourceCounts counts = sources.get(id);
            EdgeVersionRow version = edge.get(id);
            UpdateStatusRow ota = update.get(id);

            out.add(new FleetSiteDto(
                    id,
                    site.siteName(),
                    site.tenantId(),
                    site.tenantName(),
                    site.plantKind(),
                    site.netzladenErlaubt(),
                    site.tarifArt(),
                    boxDtos,
                    deviceCount,
                    onlineCount,
                    waitingCount,
                    worstStatus(deviceCount, onlineCount, waitingCount),
                    stats == null ? null : stats.lastSeenAt(),
                    lastPlan.get(id),
                    withBattery.contains(id),
                    batteryWithoutDevice,
                    counts == null ? null : new FleetSourcesDto(
                            counts.total(), counts.ok(), counts.stale(), counts.never()),
                    edgeDto(version),
                    updateDto(ota),
                    control.get(id),
                    curtailment.get(id),
                    kwp,
                    feedIn,
                    siteForecast,
                    FleetPflege.flags(site.tarifArt(), batteryWithoutDevice, kwp, feedIn,
                            siteForecast)));
        }
        // Das Register reist als Ganzes mit (es ist klein und wird ohnehin je
        // Zeile GEBRAUCHT): der erste Eintrag ist der Soll-Stand, und ein
        // gemeldeter Stand lässt sich nur DARIN einordnen. Leer = kein Maßstab.
        List<AdminFleetDto.FleetReleaseDto> register = releases.stream()
                .map(r -> new AdminFleetDto.FleetReleaseDto(r.releaseSeq(), r.version()))
                .toList();
        return new AdminFleetDto(out, register, fleet.unterstuetzungBis(), fleet.unterstuetzungStandorte());
    }

    private static FleetEdgeDto edgeDto(EdgeVersionRow version) {
        return version == null ? null : new FleetEdgeDto(
                version.coreVersion(), version.paletteVersion(), version.reportedAt());
    }

    private static FleetUpdateDto updateDto(UpdateStatusRow update) {
        return update == null ? null : new FleetUpdateDto(
                update.version(), update.backend(), update.currentVersion(), update.targetVersion(),
                update.state(), update.reason(), update.lastKnownGood(), update.reportedAt());
    }

    /**
     * Der schlechteste Gerätezustand einer Anlage, im Vokabular des Portals:
     * {@code stale} (ein Gerät ist verstummt - ein Problem) schlägt
     * {@code waiting} (hat nie gesendet - Einrichtung) schlägt {@code online};
     * {@code null} für eine Anlage ohne Gerät. Wortgleich mit
     * {@link OverviewController} - dieselbe Frage darf nicht zwei Antworten
     * haben.
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
