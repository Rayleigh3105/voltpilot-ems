package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.repo.ConsumerMetricsRepository;
import java.util.List;
import java.util.Map;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Serves the data-driven entity-type catalog to the portal admin editor (the
 * flow-catalog precedent: client and server validate against ONE truth -
 * {@code entitytypes/catalog.json}). Adding a type is catalog data + an
 * optional edge driver, never a schema release.
 */
@RestController
@PreAuthorize("hasRole('platform-admin')")
public class AdminEntityTypeCatalogController {

    private final EntityTypeCatalog catalog;
    private final ConsumerMetricsRepository fleet;

    public AdminEntityTypeCatalogController(EntityTypeCatalog catalog,
            ConsumerMetricsRepository fleet) {
        this.catalog = catalog;
        this.fleet = fleet;
    }

    @GetMapping("/api/v1/admin/entity-type-catalog")
    public JsonNode catalog() {
        return catalog.document();
    }

    /**
     * The "Steuerbare Gerätetypen" list for the platform layer (captain D11,
     * 2026-08-10): per controllable CONSUMER type its platform-wide driver
     * certification status (DATA from the catalog - a bench session ends as a
     * PR that sets it) plus the fleet-wide connected-device count. Read-only,
     * no switch on this list; the honest initial state is "nur Simulator" for
     * every real type.
     */
    @GetMapping("/api/v1/admin/consumer-device-types")
    public List<ConsumerDeviceType> consumerDeviceTypes() {
        Map<String, Integer> connected = fleet.connectedCountByType();
        return catalog.all().stream()
                .filter(t -> "consumer".equals(t.category()) && t.controllable() && !t.composed())
                .map(t -> new ConsumerDeviceType(t.type(), t.label(),
                        t.certificationStatus() == null ? "not_certified" : t.certificationStatus(),
                        t.certifiedAt(), t.certificationNotes(),
                        connected.getOrDefault(t.type(), 0)))
                .toList();
    }

    /** One row of the "Steuerbare Gerätetypen" list. */
    public record ConsumerDeviceType(String type, String label, String certificationStatus,
            String certifiedAt, String certificationNotes, int connectedCount) {}
}
