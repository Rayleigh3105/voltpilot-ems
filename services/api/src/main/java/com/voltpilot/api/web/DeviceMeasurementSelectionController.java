package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Definition;
import com.voltpilot.api.measurement.MeasurementBudget;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.measurement.MeasurementSelectionService.Actor;
import com.voltpilot.api.measurement.MeasurementSelectionService.Change;
import com.voltpilot.api.measurement.MeasurementSelectionService.CustomChange;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Auswahl- und Budget-API eines Geraets. Tenant isolation is intentionally the
 * normal device/RLS path: a foreign device is 404 before catalog or state data
 * is returned, and platform admins use the existing X-Tenant-Id switcher.
 */
@RestController
@RequestMapping("/api/v1/devices/{deviceId}/measurement-selection")
public class DeviceMeasurementSelectionController {

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record SelectionChangeRequest(@NotNull @PositiveOrZero Long expectedRevision,
            @NotNull UUID idempotencyKey, @NotNull Boolean enabled, Integer cadenceS) {
        @JsonAnySetter
        public void rejectUnknownProperty(String name, Object ignored) {
            throw new IllegalArgumentException("Unbekanntes Feld „" + name + "“.");
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public record CustomPointRequest(@NotNull @PositiveOrZero Long expectedRevision,
            @NotNull UUID idempotencyKey, @Valid @NotNull Definition definition) {
        @JsonAnySetter
        public void rejectUnknownProperty(String name, Object ignored) {
            throw new IllegalArgumentException("Unbekanntes Feld „" + name + "“.");
        }
    }

    private final MeasurementSelectionService selections;
    private final MeasurementCatalog catalog;
    private final ObjectProvider<MeasurementConfigPublisher> publisher;

    public DeviceMeasurementSelectionController(MeasurementSelectionService selections,
            MeasurementCatalog catalog, ObjectProvider<MeasurementConfigPublisher> publisher) {
        this.selections = selections;
        this.catalog = catalog;
        this.publisher = publisher;
    }

    /** Desired state + immutable history + current annual-volume estimate. */
    @GetMapping
    public State state(@PathVariable UUID deviceId) {
        return selections.state(deviceId);
    }

    /**
     * Full generated catalog, paged and searchable by German/source label,
     * selector/address/API key/measurand, unit, group and point key. Facet counts
     * in the response drive the group and semantic-status filters.
     */
    @GetMapping("/catalog")
    public MeasurementCatalog.SearchResult catalog(
            @PathVariable UUID deviceId,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) Set<String> family,
            @RequestParam(required = false) String group,
            @RequestParam(required = false) String semanticStatus,
            @RequestParam(required = false) Boolean recorded,
            @RequestParam(defaultValue = "false") boolean availableOnly,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "100") int limit) {
        try {
            return catalog.search(q, family, group, semanticStatus, recorded, availableOnly,
                    selections.availableFamilies(deviceId), selections.selectedCadences(deviceId),
                    offset, limit);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    e.getMessage());
        }
    }

    /** Volume/device-load preview before the confirmation click; writes nothing. */
    @GetMapping("/estimate")
    public MeasurementBudget.Estimate estimate(
            @PathVariable UUID deviceId,
            @RequestParam String pointKey,
            @RequestParam(defaultValue = "true") boolean enabled,
            @RequestParam(required = false) Integer cadenceS) {
        return selections.preview(deviceId, pointKey, enabled, cadenceS);
    }

    /** The same preview for a not-yet-created free register. */
    @PostMapping("/custom/estimate")
    public MeasurementBudget.Estimate estimateCustom(@PathVariable UUID deviceId,
            @Valid @RequestBody Definition definition) {
        return selections.previewCustom(deviceId, definition);
    }

    /** Revisioned enable/disable. Disabling is an update, never a delete. */
    @PutMapping("/{pointKey}")
    public State change(@PathVariable UUID deviceId, @PathVariable String pointKey,
            @Valid @RequestBody SelectionChangeRequest request,
            @AuthenticationPrincipal Jwt caller) {
        State state = selections.change(deviceId, pointKey,
                new Change(request.expectedRevision().longValue(), request.idempotencyKey(),
                        request.enabled().booleanValue(), request.cadenceS()), actor(caller));
        publish(deviceId, state);
        return state;
    }

    /** “Eigenen Messwert hinzufügen”: validated, read-only free register. */
    @PostMapping("/custom")
    public State custom(@PathVariable UUID deviceId,
            @Valid @RequestBody CustomPointRequest request,
            @AuthenticationPrincipal Jwt caller) {
        State state = selections.addCustom(deviceId,
                new CustomChange(request.expectedRevision(), request.idempotencyKey(),
                        request.definition()), actor(caller));
        publish(deviceId, state);
        return state;
    }

    private void publish(UUID deviceId, State state) {
        MeasurementConfigPublisher p = publisher.getIfAvailable();
        if (p != null) p.publish(selections.requireDevice(deviceId), state);
    }

    private static Actor actor(Jwt caller) {
        if (caller == null) {
            return new Actor("unbekannt", null);
        }
        Object name = caller.getClaims().get("preferred_username");
        if (name == null) {
            name = caller.getClaims().get("name");
        }
        String display = name == null ? null : name.toString().trim();
        return new Actor(caller.getSubject(), display == null || display.isBlank() ? null : display);
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, String>> handle(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(
                Map.of("message", e.getReason() == null ? "Anfrage abgelehnt." : e.getReason()));
    }
}
