package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.entities.EntityTypeCatalog;
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

    public AdminEntityTypeCatalogController(EntityTypeCatalog catalog) {
        this.catalog = catalog;
    }

    @GetMapping("/api/v1/admin/entity-type-catalog")
    public JsonNode catalog() {
        return catalog.document();
    }
}
