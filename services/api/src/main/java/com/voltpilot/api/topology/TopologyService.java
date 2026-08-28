package com.voltpilot.api.topology;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.topology.TopologyRepository.LatestValue;
import com.voltpilot.api.topology.TopologyRepository.RoleOverride;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Composes the Anlagen-Topologie-Read-Model (AE1) for one site: the v2 entities
 * with each capability's resolved role (stored override else
 * {@link TopologyDeriver#defaultRole}) + maßgeblich flag + latest live value,
 * plus the server-derived hub topology. RLS-scoped (the repositories carry no
 * tenant predicate; the caller's session tenant fences every read). A fresh
 * site yields empty {@code entities} + empty {@code topology}.
 */
@Service
public class TopologyService {

    /** Liveness window mirroring the portal/edge 5-min device window. */
    private static final Duration LIVENESS_WINDOW = Duration.ofMinutes(5);

    /** One capability with its resolved role/primary/unit + latest value. */
    public record CapabilityDto(String channel, String unit, String role, boolean primary,
            Double value) {}

    /**
     * One entity as the read-model exposes it (camelCase, the EntityController
     * style). {@code connection} is only set for a charge point ({@code haus} |
     * {@code eigen}, Cockpit Phase 1 / C1) and is the ONE extra input the
     * portal needs to reproduce this server's role resolution
     * ({@code rollen.isAutoAssigned}) instead of guessing it.
     */
    public record EntityTopologyDto(UUID id, String entityType, String typeLabel, String label,
            String category, String health, String connection, List<CapabilityDto> capabilities) {}

    /** The whole read-model: the entity graph + the derived hub topology. */
    public record TopologyResponse(String schemaVersion, List<EntityTopologyDto> entities,
            TopologyDeriver.Topology topology) {}

    /** One capability→role assignment (role = null/blank REVERTS to the default). */
    public record Assignment(UUID entityId, String channel, String role, boolean primary) {}

    /** The role vocabulary a stored override may name (topology.DefaultRole set). */
    private static final Set<String> ROLE_VOCAB = Set.of("pv", "storage", "grid", "consumer",
            TopologyDeriver.ROLE_CHARGING, TopologyDeriver.ROLE_CHARGING_OWN);

    private final EntityRegistryRepository registry;
    private final TopologyRepository repo;
    private final EntityTypeCatalog catalog;
    private final ObjectMapper mapper;
    private final DeviceChargerStatusRepository chargers;

    public TopologyService(EntityRegistryRepository registry, TopologyRepository repo,
            EntityTypeCatalog catalog, ObjectMapper mapper,
            DeviceChargerStatusRepository chargers) {
        this.registry = registry;
        this.repo = repo;
        this.catalog = catalog;
        this.mapper = mapper;
        this.chargers = chargers;
    }

    /**
     * Apply a batch of capability→role assignment overrides for one site and
     * return the recomputed read-model. Shared verbatim by the admin
     * ({@code /admin/sites/{id}/topology-roles}) and the customer
     * ({@code /sites/{id}/topology-roles}) surfaces - a role assignment is
     * presentation-level and NEVER widens control (guards/arbitration key on
     * capabilities, not roles), so the customer twin needs no extra gate beyond
     * RLS. Every assignment must target a v2 entity visible under the session
     * tenant (RLS: a foreign entity yields null =&gt; 404); an unknown role is
     * 400; a blank role clears the override (revert to the DefaultRole mapping).
     */
    public TopologyResponse applyAssignments(UUID siteId, List<Assignment> assignments) {
        List<Assignment> batch = assignments == null ? List.of() : assignments;
        UUID tenantId = TenantContext.get();
        for (Assignment a : batch) {
            if (a.entityId() == null || a.channel() == null || a.channel().isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Jede Zuordnung braucht entityId und channel.");
            }
            if (registry.entityForSite(siteId, a.entityId()) == null) {
                // RLS hides sites/entities outside the session tenant.
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
            }
            String role = a.role() == null ? "" : a.role().trim();
            if (role.isEmpty()) {
                repo.deleteOverride(siteId, a.entityId(), a.channel());
                continue;
            }
            if (!ROLE_VOCAB.contains(role)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Unbekannte Rolle \"" + role
                                + "\" (erlaubt: pv, storage, grid, consumer, charging, "
                                + "charging-own).");
            }
            repo.upsertOverride(tenantId, siteId, a.entityId(), a.channel(), role, a.primary());
        }
        return topology(siteId);
    }

    public TopologyResponse topology(UUID siteId) {
        List<EntityRow> rows = registry.entitiesForSite(siteId);
        Map<String, LatestValue> latest = indexLatest(repo.latestValues(siteId, channelKeys(rows)));
        Map<String, RoleOverride> overrides = indexOverrides(repo.overrides(siteId));
        Set<String> rolesWithExplicitPrimary = new HashSet<>();
        for (RoleOverride ov : overrides.values()) {
            if (ov.primary() && ov.role() != null && !ov.role().isBlank()) {
                rolesWithExplicitPrimary.add(ov.role());
            }
        }
        // WHERE each charge point hangs - the ONE extra input the charging roles
        // need (C2). One small indexed read; a site without a charge point gets
        // an empty map and resolves byte-identically to before.
        Map<UUID, String> connections = chargers.connectionsByEntity(siteId);
        Instant now = Instant.now();
        Set<String> firstSeen = new HashSet<>();

        List<EntityTopologyDto> entities = new ArrayList<>();
        List<TopologyDeriver.EntityInput> derivIn = new ArrayList<>();
        for (EntityRow row : rows) {
            String category = categoryOf(row.entityType());
            String connection = connections.get(row.id());
            List<CapabilityDto> caps = new ArrayList<>();
            List<TopologyDeriver.CapabilityInput> derivCaps = new ArrayList<>();
            Instant newest = null;
            for (JsonNode m : measures(row.capabilitiesJson())) {
                String channel = m.path("channel").asText(null);
                if (channel == null || channel.isBlank()) {
                    continue;
                }
                String unit = m.path("unit").asText(null);
                RoleOverride ov = overrides.get(overrideKey(row.id(), channel));
                String role;
                boolean primary;
                if (ov != null) {
                    role = ov.role();
                    primary = ov.primary();
                } else {
                    role = TopologyDeriver.defaultRole(row.entityType(), category, channel,
                            connection);
                    primary = !role.isEmpty() && !rolesWithExplicitPrimary.contains(role)
                            && !firstSeen.contains(role);
                }
                if (!role.isEmpty()) {
                    firstSeen.add(role);
                }
                LatestValue lv = latest.get(valueKey(row.id().toString(), channel));
                Double value = lv == null ? null : lv.value();
                if (lv != null && (newest == null || lv.receivedAt().isAfter(newest))) {
                    newest = lv.receivedAt();
                }
                caps.add(new CapabilityDto(channel, unit, role.isEmpty() ? null : role, primary,
                        value));
                derivCaps.add(new TopologyDeriver.CapabilityInput(channel, role, primary, value));
            }
            String health = health(newest, now);
            entities.add(new EntityTopologyDto(row.id(), row.entityType(),
                    catalog.labelFor(row.entityType()), row.label(), category, health, connection,
                    caps));
            derivIn.add(new TopologyDeriver.EntityInput(row.id().toString(), row.entityType(),
                    label(row), category, health, derivCaps));
        }

        TopologyDeriver.Topology topo = TopologyDeriver.derive(new TopologyDeriver.Input(derivIn));
        return new TopologyResponse(TopologyDeriver.SCHEMA_VERSION, entities, topo);
    }

    /**
     * The (entity, channel) pairs this read-model will actually read - the exact
     * set the loop below looks up, so the repository can probe them one by one
     * instead of scanning the site's whole telemetry_v2 history (see
     * {@link TopologyRepository#latestValues(UUID, java.util.List)}). The channel
     * filter MUST stay identical to the loop's ({@code null}/blank skipped),
     * otherwise a channel would silently lose its value. Deduplicated: a
     * capabilities document listing a channel twice must not double the probes.
     */
    private List<TopologyRepository.ChannelKey> channelKeys(List<EntityRow> rows) {
        Set<TopologyRepository.ChannelKey> keys = new LinkedHashSet<>();
        for (EntityRow row : rows) {
            for (JsonNode m : measures(row.capabilitiesJson())) {
                String channel = m.path("channel").asText(null);
                if (channel == null || channel.isBlank()) {
                    continue;
                }
                keys.add(new TopologyRepository.ChannelKey(row.id().toString(), channel));
            }
        }
        return List.copyOf(keys);
    }

    private String categoryOf(String entityType) {
        EntityTypeCatalog.EntityType t = catalog.find(entityType);
        return t == null ? "" : t.category();
    }

    private static String label(EntityRow row) {
        return row.label() == null ? "" : row.label();
    }

    private Iterable<JsonNode> measures(String capabilitiesJson) {
        if (capabilitiesJson == null || capabilitiesJson.isBlank()) {
            return List.of();
        }
        try {
            JsonNode measure = mapper.readTree(capabilitiesJson).path("measure");
            return measure.isArray() ? measure : List.of();
        } catch (Exception e) {
            return List.of();
        }
    }

    private static String health(Instant newest, Instant now) {
        if (newest == null) {
            return "never";
        }
        return Duration.between(newest, now).compareTo(LIVENESS_WINDOW) <= 0 ? "ok" : "stale";
    }

    private static Map<String, LatestValue> indexLatest(List<LatestValue> values) {
        Map<String, LatestValue> m = new LinkedHashMap<>();
        for (LatestValue v : values) {
            m.put(valueKey(v.entityId(), v.channel()), v);
        }
        return m;
    }

    private static Map<String, RoleOverride> indexOverrides(List<RoleOverride> overrides) {
        Map<String, RoleOverride> m = new LinkedHashMap<>();
        for (RoleOverride o : overrides) {
            m.put(overrideKey(o.entityId(), o.capability()), o);
        }
        return m;
    }

    private static String valueKey(String entityId, String channel) {
        return entityId + "|" + channel;
    }

    private static String overrideKey(UUID entityId, String capability) {
        return entityId + "|" + capability;
    }
}
