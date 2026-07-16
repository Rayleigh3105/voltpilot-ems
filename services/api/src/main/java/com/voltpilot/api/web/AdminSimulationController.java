package com.voltpilot.api.web;

import com.voltpilot.api.simulation.SimulationClient;
import com.voltpilot.api.simulation.SimulationJobRegistry;
import com.voltpilot.api.simulation.SimulationPayload;
import com.voltpilot.api.web.dto.SimulationRequestDto;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Vertrieb "Ersparnis-Rechner": platform-admin-only prospect simulations
 * with EXPLICIT inputs - no site, no tenant, no {@code X-Tenant-Id} needed
 * (V1 is deliberately stateless: nothing about the prospect is persisted, the
 * result lives in the simulation service's job cache only). Validation of
 * completeness happens in the simulation service, whose German messages are
 * relayed; polls are scoped to admin-started jobs.
 */
@RestController
@RequestMapping("/api/v1/admin/simulation")
@PreAuthorize("hasRole('platform-admin')")
public class AdminSimulationController {

    private final SimulationClient client;
    private final SimulationJobRegistry registry;

    public AdminSimulationController(SimulationClient client, SimulationJobRegistry registry) {
        this.client = client;
        this.registry = registry;
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> start(
            @RequestBody(required = false) SimulationRequestDto request) {
        Map<String, Object> payload = SimulationPayload.forProspect(request);
        String simulationId = client.submit(payload);
        registry.registerAdminJob(simulationId);
        return ResponseEntity.accepted().body(Map.of("simulationId", simulationId));
    }

    @GetMapping("/{simulationId}")
    public Map<String, Object> status(@PathVariable String simulationId) {
        if (!registry.isAdminJob(simulationId)) {
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

    /** German reason into the body (the MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
