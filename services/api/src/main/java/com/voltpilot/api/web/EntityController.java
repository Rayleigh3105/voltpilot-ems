package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryRepository.RegistryState;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.EntityHistoryRepository;
import com.voltpilot.api.repo.SiteRepository;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The customer-facing entity surface (E1b "Geräte &amp; Entitäten"): the
 * site's v2 registry entities WITH their Soll/Ist reconciliation (registry
 * revision vs the edge-reported observed state - drift is SURFACED, never
 * silently resolved), the edge-local commissioning view, and the per-entity
 * history over the generic v2 telemetry rollups.
 *
 * <p>Tenant-scoped like every site route (RLS; foreign site = 404). Admins
 * read it through the {@code X-Tenant-Id} switcher; WRITES stay admin-only
 * under {@code /api/v1/admin/sites/{siteId}/v2-entities}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/entities")
public class EntityController {

    /** Per-entity Soll/Ist sync verdicts (portal renders the German copy). */
    static final String SYNC_IN_SYNC = "in_sync";
    static final String SYNC_PENDING = "pending";
    static final String SYNC_MISSING_ON_DEVICE = "missing_on_device";
    static final String SYNC_UNREPORTED = "unreported";
    static final String SYNC_NEVER_PUSHED = "never_pushed";

    public record ObservedDto(String health, Instant lastTelemetryAt, JsonNode channels,
            String appliedType, Instant reportedAt) {}

    /** {@code orphanedPin}: tri-state - true = the pinned edge source is no
     *  longer among the device's reported sources (identity churn; offer
     *  re-pin), false = pinned + reported, null = no pin or no local view
     *  reported yet (never claim an orphan the report cannot prove).
     *  {@code capacityKwp}: the adopted producer's nameplate, which sums into
     *  the plant total - the delete dialog names what gets subtracted instead
     *  of a vague warning (vp-bereinigung-ui-k3).
     *  {@code sourceKind}: {@code "composed"} marks a platform-SYNTHESIZED base
     *  row (grid-meter / house-load derived from the gateway). The customer
     *  delete gate mirrors the server (vp-komp-loeschen E2): a null-pin row is
     *  deletable UNLESS it carries this marker, so a never-connected producer
     *  can be removed while the plant's derived base stays protected. */
    public record EntityDto(UUID id, String entityType, String typeLabel, String role,
            String label, boolean control, UUID deviceId, JsonNode capabilities, JsonNode guards,
            String syncStatus, ObservedDto observed, String edgeSourceId, Boolean orphanedPin,
            java.math.BigDecimal capacityKwp, String sourceKind) {}

    /** One edge-local commissioning item. {@code adoptedEntityId} != null when a
     *  v2 entity was already adopted from this source (U2 "Vom Gerät gemeldet").
     *  {@code label} is ONLY the operator-given name (may be null); brand/model
     *  ride separately so consumers build display names via their own fallback
     *  chain (name > brand+model > id), never from a concatenation.
     *
     *  <p><b>Die sechs Verbindungsfelder (Anlagen-Zentrale Stufe 2, PR 2b)</b>
     *  sagen, WIE die Box dieses Gerät erreicht. Sie liegen seit
     *  {@code V20260819000000} in {@code entity_observed_state.edge_*} und
     *  wurden bis hierher nur von der Bestands-Übernahme gelesen - die Flächen
     *  mussten ihre Adressen aus {@code /register-write/targets} bzw. den
     *  gespeicherten Komponenten-Definitionen zusammensuchen. Derselbe Inhalt,
     *  zwei Pfade: das Struktur-Schaltbild UND die Geräteseite beschriften ihre
     *  Kanten jetzt aus DIESEM einen.
     *
     *  <p><b>Die Ehrlichkeitsregel ist die von {@code EdgeLink}:</b> {@code null}
     *  heißt „diese Box meldet (noch) keine Verbindungen" - NIE „dieses Gerät
     *  hat keine". Ein älterer Box-Stand lässt die Felder weg, und daraus darf
     *  nur „Weg unbekannt" folgen, nie eine erfundene Adresse.
     *
     *  <p>{@code unitId} ist die Modbus-Adresse, wie der jeweilige Transport sie
     *  nennt ({@code unit_id} bzw. beim Solarman-Weg {@code mb_slave_id}) - EIN
     *  Feld, weil es dieselbe Sache ist; {@code serial} ist die Logger-Nummer
     *  des Solarman-Wegs, die auf einer box-verwalteten Anlage nirgendwo sonst
     *  vorliegt. */
    public record LocalSetupDto(String id, String kind, String role, String brand, String model,
            String label, Instant reportedAt, String adoptedEntityId, String communication,
            String family, String host, Integer port, Integer unitId, String serial,
            Integer intervalS) {}

    public record RegistrySummaryDto(String revision, Instant composedAt, UUID deviceId,
            String reportedRevision, Instant reportedAt) {}

    /** The whole surface. staleOnDevice = edge-applied entities the registry
     *  no longer contains (cleared on the next converged push). */
    public record SiteEntitiesDto(RegistrySummaryDto registry, List<EntityDto> entities,
            List<LocalSetupDto> localSetup, List<String> staleOnDevice) {}

    public record EntityHistoryDto(String range, Instant from, Instant to, int bucketMinutes,
            Map<String, List<EntityHistoryRepository.Bucket>> channels) {}

    private final SiteRepository sites;
    private final EntityRegistryRepository registry;
    private final EntityObservedRepository observed;
    private final EntityHistoryRepository history;
    private final EntityTypeCatalog catalog;
    private final ObjectMapper mapper;

    public EntityController(SiteRepository sites, EntityRegistryRepository registry,
            EntityObservedRepository observed, EntityHistoryRepository history,
            EntityTypeCatalog catalog, ObjectMapper mapper) {
        this.sites = sites;
        this.registry = registry;
        this.observed = observed;
        this.history = history;
        this.catalog = catalog;
        this.mapper = mapper;
    }

    @GetMapping
    public SiteEntitiesDto list(@PathVariable UUID siteId) {
        requireSite(siteId);
        List<EntityRow> rows = registry.entitiesForSite(siteId);
        RegistryState state = registry.registryState(siteId);
        List<ObservedRow> observedRows = observed.forSite(siteId);

        // Which edge source each already-adopted entity came from (U2 matcher).
        Map<String, String> adoptedBySource = new LinkedHashMap<>();
        for (EntityRow row : rows) {
            if (row.edgeSourceId() != null) {
                adoptedBySource.put(row.edgeSourceId(), row.id().toString());
            }
        }

        Map<String, ObservedRow> byEntity = new LinkedHashMap<>();
        List<ObservedRow> localRows = new ArrayList<>();
        String reportedRevision = null;
        Instant reportedAt = null;
        for (ObservedRow row : observedRows) {
            if ("local".equals(row.source())) {
                localRows.add(row);
            } else {
                byEntity.put(row.entityId(), row);
            }
            if (row.appliedRevision() != null) {
                reportedRevision = row.appliedRevision();
            }
            reportedAt = row.reportedAt();
        }

        List<LocalSetupDto> localSetup = new ArrayList<>();
        java.util.Set<String> reportedSourceIds = new java.util.HashSet<>();
        for (ObservedRow row : localRows) {
            String sourceId = row.entityId().replaceFirst("^local:", "");
            reportedSourceIds.add(sourceId);
            EntityObservedRepository.EdgeLink link = row.edgeLink();
            JsonNode conn = link == null ? null : parse(link.connectionJson());
            localSetup.add(new LocalSetupDto(sourceId, row.entityType(), row.edgeRole(),
                    row.edgeBrand(), row.edgeModel(), row.label(), row.reportedAt(),
                    adoptedBySource.get(sourceId),
                    link == null ? null : blankToNull(link.communication()),
                    link == null ? null : blankToNull(link.family()),
                    connText(conn, "ip", "host"), connInt(conn, "port"),
                    // EIN Feld für dieselbe Sache: der Solarman-Weg nennt die
                    // Modbus-Adresse `mb_slave_id`, jeder andere `unit_id`.
                    connInt(conn, "unit_id", "mb_slave_id"), connText(conn, "serial"),
                    link == null ? null : link.intervalS()));
        }

        List<EntityDto> entities = new ArrayList<>();
        for (EntityRow row : rows) {
            ObservedRow obs = byEntity.remove(row.id().toString());
            // Orphan verdict only when the device actually reported a local
            // view - an edge that never sent local_setup proves nothing.
            Boolean orphanedPin = row.edgeSourceId() == null || localRows.isEmpty() ? null
                    : !reportedSourceIds.contains(row.edgeSourceId());
            entities.add(new EntityDto(row.id(), row.entityType(),
                    catalog.labelFor(row.entityType()), row.role(), row.label(), row.control(),
                    row.deviceId(), parse(row.capabilitiesJson()), parse(row.guardConfigJson()),
                    syncStatus(state, obs, !observedRows.isEmpty(), reportedRevision),
                    obs == null ? null
                            : new ObservedDto(obs.health(), obs.lastTelemetryAt(),
                                    parse(obs.channelsJson()), obs.entityType(),
                                    obs.reportedAt()),
                    row.edgeSourceId(), orphanedPin, row.capacityKwp(), row.sourceKind()));
        }
        // Whatever the edge still reports that the registry no longer knows.
        List<String> staleOnDevice = new ArrayList<>(byEntity.keySet());

        RegistrySummaryDto summary = state == null ? null
                : new RegistrySummaryDto(state.revision(), state.composedAt(), state.deviceId(),
                        reportedRevision, reportedAt);
        return new SiteEntitiesDto(summary, entities, localSetup, staleOnDevice);
    }

    /**
     * Per-entity channel history: day = live 15-min buckets from raw v2
     * telemetry, week = hourly rollup, month/year = Berlin-daily rollup.
     */
    @GetMapping("/{entityId}/history")
    public EntityHistoryDto history(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @RequestParam(defaultValue = "day") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate at) {
        requireSite(siteId);
        EntityRow entity = registry.entityForSite(siteId, entityId);
        if (entity == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        HistoryRange parsed = HistoryRange.parse(range);
        if (parsed == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "range must be one of day|week|month|year");
        }
        LocalDate anchor = at != null ? at : LocalDate.now(HistoryRange.ZONE);
        HistoryRange.Window window = parsed.window(anchor);
        // The entity's type/device drive the MIG-B2 v1 splice for a COMPOSED
        // entity (audit H1): telemetry_v2 is fed forward only, so without it a
        // migrated plant's explorer is empty for its whole pre-migration history.
        Map<String, List<EntityHistoryRepository.Bucket>> channels =
                history.history(siteId, entityId.toString(), parsed, window.from(), window.to(),
                        entity.entityType(), entity.deviceId());
        return new EntityHistoryDto(parsed.name().toLowerCase(), window.from(), window.to(),
                parsed.bucketMinutes(), channels);
    }

    /**
     * The per-entity Soll/Ist verdict. Deliberately layered: no composed Soll
     * yet beats everything (there is nothing the edge could echo), then the
     * device's report decides.
     */
    private static String syncStatus(RegistryState state, ObservedRow obs, boolean deviceReported,
            String reportedRevision) {
        if (state == null) {
            return SYNC_NEVER_PUSHED;
        }
        if (obs != null) {
            return state.revision().equals(obs.appliedRevision()) ? SYNC_IN_SYNC : SYNC_PENDING;
        }
        if (deviceReported) {
            // The edge reports entities, but not this one: the current Soll
            // has not reached it yet (or the entity was just created).
            return state.revision().equals(reportedRevision) ? SYNC_MISSING_ON_DEVICE
                    : SYNC_PENDING;
        }
        return SYNC_UNREPORTED;
    }

    /**
     * Ein Textfeld des gemeldeten Verbindungs-Blocks, unter dem ersten Namen,
     * den dieser Transport benutzt - sonst {@code null}. Ein leerer String ist
     * keine Adresse und wird deshalb wie „nicht gemeldet" behandelt.
     */
    private static String connText(JsonNode conn, String... names) {
        if (conn == null || !conn.isObject()) {
            return null;
        }
        for (String name : names) {
            JsonNode v = conn.get(name);
            if (v != null && v.isTextual() && !v.asText().isBlank()) {
                return v.asText().trim();
            }
        }
        return null;
    }

    /** Dasselbe für eine Zahl. {@code null} = nicht gemeldet, nie eine 0. */
    private static Integer connInt(JsonNode conn, String... names) {
        if (conn == null || !conn.isObject()) {
            return null;
        }
        for (String name : names) {
            JsonNode v = conn.get(name);
            if (v != null && v.isNumber()) {
                return v.asInt();
            }
        }
        return null;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private JsonNode parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
    }
}
