package com.voltpilot.api.web;

import com.voltpilot.api.repo.SimulationDefaultsRepository;
import com.voltpilot.api.repo.SimulationDefaultsRepository.SimulationDefaults;
import com.voltpilot.api.simulation.SimulationClient;
import com.voltpilot.api.simulation.SimulationJobRegistry;
import com.voltpilot.api.simulation.SimulationPayload;
import com.voltpilot.api.web.dto.SimulationRequestDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Ersparnis-Simulation for the customer's own Anlage (async job: POST starts,
 * GET polls). Tenant-scoped exactly like every site route: the master-data
 * read runs under RLS (foreign site = 404 before anything happens), and a
 * poll is only answered for a job STARTED through this site's route (the
 * {@link SimulationJobRegistry} scope check) - the Python service itself
 * knows neither tenants nor tokens. Admins reach any tenant through the
 * {@code X-Tenant-Id} switcher like every customer endpoint; pure prospect
 * calculations live on the separate platform-admin route.
 *
 * <p>Defaults come from the site (tariff, plant kind, anzulegender Wert,
 * coordinates, battery asset incl. Speicherschonung, PV asset); every body
 * field OVERRIDES its default - the what-if instrument the captain asked for
 * ("meinen Speicher je nach Modell nutzen").
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/simulation")
public class SimulationController {

    private final SimulationDefaultsRepository defaults;
    private final SimulationClient client;
    private final SimulationJobRegistry registry;

    public SimulationController(SimulationDefaultsRepository defaults,
            SimulationClient client, SimulationJobRegistry registry) {
        this.defaults = defaults;
        this.client = client;
        this.registry = registry;
    }

    @PostMapping
    @Recht(value = "messwerte.ansehen", ziel = RechtZiel.ANLAGE)
    public ResponseEntity<Map<String, Object>> start(@PathVariable UUID siteId,
            @RequestBody(required = false) SimulationRequestDto request) {
        SimulationDefaults site = defaults.findForSite(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        Map<String, Object> payload = SimulationPayload.forSite(request, site);
        String simulationId = client.submit(payload);
        registry.registerSiteJob(simulationId, siteId);
        return ResponseEntity.accepted().body(Map.of("simulationId", simulationId));
    }

    @GetMapping("/{simulationId}")
    public Map<String, Object> status(@PathVariable UUID siteId,
            @PathVariable String simulationId) {
        if (defaults.findForSite(siteId) == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        if (!registry.isSiteJob(simulationId, siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Simulation nicht gefunden.");
        }
        Map<String, Object> status = client.status(simulationId);
        if (status == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Simulation nicht gefunden.");
        }
        return status;
    }

    /**
     * The German reason must reach the portal as {@code {"message": ...}}
     * (the MastrController pattern - Boot's default error body strips the
     * reason), including the simulation service's relayed 400/429 copy.
     */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
