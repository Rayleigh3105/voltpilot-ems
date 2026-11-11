package com.voltpilot.api.web;

import com.voltpilot.api.fernwartung.FernwartungRepository.DienstAbruf;
import com.voltpilot.api.fernwartung.FernwartungService;
import com.voltpilot.api.repo.FleetMetricsRepository;
import com.voltpilot.api.web.dto.AdminPlattformDiensteDto;
import com.voltpilot.api.werkstatt.DienstAnsichtService;
import java.time.Instant;
import java.util.Comparator;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Die Dienste-Zeile der neuen Plattform-Übersicht (Lücke L1, E7): {@code GET
 * /api/v1/admin/plattform/dienste}. Liefert dieselben Werte, die die API
 * längst für Prometheus rechnet ({@link FleetMetricsRepository}), zusätzlich
 * im Lesemodell - kein neuer Sammler, keine neue Tabelle.
 *
 * <p>Sicherheits-Disziplin wie {@link AdminFleetController}:
 * {@code @PreAuthorize("hasRole('platform-admin')")}, die RLS-Umgehung bleibt
 * auf {@link FleetMetricsRepository} (BYPASSRLS-Rolle {@code voltpilot_admin})
 * beschränkt; Fernwartung und Werkstatt werden über ihre eigenen, bereits
 * admin-geschützten Dienste gelesen, nie über eine zweite Abfrage derselben
 * Tabellen.
 */
@RestController
@RequestMapping("/api/v1/admin/plattform/dienste")
@PreAuthorize("hasRole('platform-admin')")
public class AdminPlattformDiensteController {

    private final FleetMetricsRepository fleetMetrics;
    private final FernwartungService fernwartung;
    private final DienstAnsichtService werkstattDienst;

    public AdminPlattformDiensteController(FleetMetricsRepository fleetMetrics,
            FernwartungService fernwartung, DienstAnsichtService werkstattDienst) {
        this.fleetMetrics = fleetMetrics;
        this.fernwartung = fernwartung;
        this.werkstattDienst = werkstattDienst;
    }

    @GetMapping
    public AdminPlattformDiensteDto dienste() {
        Instant optimierer = fleetMetrics.newestPlanAt();
        Instant preise = fleetMetrics.newestPriceFetchAt();
        Instant messwerte = fleetMetrics.newestTelemetryAt();
        Instant tunnelDienst = fernwartung.uebersicht().abrufe().stream()
                .map(DienstAbruf::zuletztAm)
                .filter(java.util.Objects::nonNull)
                .max(Comparator.naturalOrder())
                .orElse(null);
        Instant werkstatt = werkstattDienst.gemeldet().map(g -> g.gemeldetAm()).orElse(null);
        return AdminPlattformDiensteDto.of(optimierer, preise, messwerte, tunnelDienst, werkstatt);
    }
}
