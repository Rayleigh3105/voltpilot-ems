package com.voltpilot.api.web;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.voltpilot.api.measurement.CustomMeasurementPoint.Definition;
import com.voltpilot.api.measurement.MeasurementBudget;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MeasurementConfigPublisher;
import com.voltpilot.api.measurement.MeasurementSelectionService;
import com.voltpilot.api.measurement.MeasurementHistoryService;
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
import java.time.Instant;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
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
 *
 * <p>Seit UEMS AP-07 IP-14 traegt dieser Controller den LESEPFAD der Messdatenstrecke
 * (Verlauf mit Herkunft, Rueckfall auf die Speicherklassen, Export mit Herkunfts-Spalten).
 * Damit gilt fuer ihn die Rechte-Regel der UEMS-Arbeitsregeln: jede Route nennt direkt
 * darueber ihr Recht mit einer Kennung aus {@code docs/contracts/v2/rechte-matrix.json}
 * ({@code RechteKennungenDerRoutenTest} erzwingt es). AP-03 ist NICHT gebaut - durchgesetzt
 * wird heute {@code authenticated()} plus die Zeilen-Abschirmung des Kundenbereichs; ein
 * fremdes Geraet ist 404, nie 403. Eine Durchsetzung je Standort entsteht erst mit AP-03.
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
    private final MeasurementHistoryService history;

    public DeviceMeasurementSelectionController(MeasurementSelectionService selections,
            MeasurementCatalog catalog, ObjectProvider<MeasurementConfigPublisher> publisher,
            MeasurementHistoryService history) {
        this.selections = selections;
        this.catalog = catalog;
        this.publisher = publisher;
        this.history = history;
    }

    /**
     * Recht: {@code messwerte.ansehen}; die Marken des Verlaufs zusaetzlich
     * {@code ereignisse.ansehen} (AP-07 §4.10 „Ereignisse einsehen: wie Verlauf").
     */
    @GetMapping("/{pointKey}/history")
    public MeasurementHistoryService.History history(@PathVariable UUID deviceId,
            @PathVariable String pointKey, @RequestParam(defaultValue = "24h") String range,
            @RequestParam(required = false) Instant from,
            @RequestParam(required = false) Instant to,
            @RequestParam(defaultValue = "decoded") String representation,
            @RequestParam(required = false) UUID siteId,
            @RequestParam(required = false) UUID entityId) {
        return history.history(deviceId, pointKey, range, from, to, representation, siteId,
                entityId);
    }

    /**
     * Recht: {@code export.standort} (AP-07 §4.10 „Export mit Herkunfts-Spalten"); der
     * gelesene Inhalt ist der des Verlaufs, also zusaetzlich {@code messwerte.ansehen}.
     */
    @GetMapping(value = "/{pointKey}/export", produces = "text/csv")
    public ResponseEntity<byte[]> export(@PathVariable UUID deviceId,
            @PathVariable String pointKey, @RequestParam(defaultValue = "24h") String range,
            @RequestParam(required = false) Instant from,
            @RequestParam(required = false) Instant to,
            @RequestParam(defaultValue = "decoded") String representation,
            @RequestParam(required = false) UUID siteId,
            @RequestParam(required = false) UUID entityId) {
        var result = history.history(deviceId, pointKey, range, from, to, representation, siteId,
                entityId);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=messwert-" + pointKey.replaceAll("[^a-zA-Z0-9._-]", "_") + ".csv")
                .body(history.csv(result));
    }

    /**
     * Desired state + immutable history + current annual-volume estimate.
     *
     * <p>{@code entityId} scopes selections and paper trail to ONE component of
     * this device; without it the answer is the whole device, which before
     * Stufe 3b was the only thing a selection could belong to. The revision and
     * the volume estimate stay device-wide either way.
     *
     * <p>Recht: {@code mess_selektion.bearbeiten} - dies ist ihre Lese-Haelfte.
     */
    @GetMapping
    public State state(@PathVariable UUID deviceId,
            @RequestParam(required = false) UUID entityId) {
        return selections.state(deviceId, entityId);
    }

    /**
     * Full generated catalog, paged and searchable by German/source label,
     * selector/address/API key/measurand, unit, group and point key. Facet counts
     * in the response drive the group and semantic-status filters.
     *
     * <p>Recht: {@code mess_selektion.bearbeiten} - die Auswahlliste dazu.
     */
    @GetMapping("/catalog")
    public MeasurementCatalog.SearchResult catalog(
            @PathVariable UUID deviceId,
            @RequestParam(required = false) UUID entityId,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) Set<String> family,
            @RequestParam(required = false) String group,
            @RequestParam(required = false) String semanticStatus,
            @RequestParam(required = false) Boolean recorded,
            @RequestParam(defaultValue = "false") boolean availableOnly,
            @RequestParam(defaultValue = "false") boolean selectedOnly,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "100") int limit) {
        try {
            return catalog.search(q, family, group, semanticStatus, recorded, availableOnly,
                    selectedOnly,
                    selections.availableFamilies(deviceId, entityId),
                    selections.selectedCadences(deviceId, entityId),
                    selections.recordedPointKeys(deviceId),
                    selections.latestObservations(deviceId), offset, limit);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    e.getMessage());
        }
    }

    /**
     * Volume/device-load preview before the confirmation click; writes nothing.
     *
     * <p>Recht: {@code mess_selektion.bearbeiten} - die Vorschau vor ihrem Schreibvorgang.
     */
    @GetMapping("/estimate")
    public MeasurementBudget.Estimate estimate(
            @PathVariable UUID deviceId,
            @RequestParam(required = false) UUID entityId,
            @RequestParam String pointKey,
            @RequestParam(defaultValue = "true") boolean enabled,
            @RequestParam(required = false) Integer cadenceS) {
        return selections.preview(deviceId, entityId, pointKey, enabled, cadenceS);
    }

    /**
     * The same preview for a not-yet-created free register.
     *
     * <p>Recht: {@code mess_selektion.bearbeiten} - dieselbe Vorschau, sie schreibt nichts.
     */
    @PostMapping("/custom/estimate")
    public MeasurementBudget.Estimate estimateCustom(@PathVariable UUID deviceId,
            @RequestParam(required = false) UUID entityId,
            @Valid @RequestBody Definition definition) {
        return selections.previewCustom(deviceId, entityId, definition);
    }

    /**
     * Revisioned enable/disable. Disabling is an update, never a delete.
     *
     * <p>Recht: {@code mess_selektion.bearbeiten}.
     */
    @PutMapping("/{pointKey}")
    public State change(@PathVariable UUID deviceId, @PathVariable String pointKey,
            @RequestParam(required = false) UUID entityId,
            @Valid @RequestBody SelectionChangeRequest request,
            @AuthenticationPrincipal Jwt caller) {
        State state = selections.change(deviceId, entityId, pointKey,
                new Change(request.expectedRevision().longValue(), request.idempotencyKey(),
                        request.enabled().booleanValue(), request.cadenceS()), actor(caller));
        publish(deviceId, state);
        return state;
    }

    /**
     * “Eigenen Messwert hinzufügen”: validated, read-only free register.
     *
     * <p>Recht: {@code mess_selektion.bearbeiten}.
     */
    @PostMapping("/custom")
    public State custom(@PathVariable UUID deviceId,
            @RequestParam(required = false) UUID entityId,
            @Valid @RequestBody CustomPointRequest request,
            @AuthenticationPrincipal Jwt caller) {
        State state = selections.addCustom(deviceId, entityId,
                new CustomChange(request.expectedRevision(), request.idempotencyKey(),
                        request.definition()), actor(caller));
        publish(deviceId, state);
        return state;
    }

    /**
     * One retained document per DEVICE: a component-scoped write must still
     * publish the device's complete desired state, never the filtered view it
     * returned to the caller.
     */
    private void publish(UUID deviceId, State state) {
        MeasurementConfigPublisher p = publisher.getIfAvailable();
        if (p == null) return;
        p.publish(selections.requireDevice(deviceId),
                state.entityId() == null ? state : selections.state(deviceId));
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
