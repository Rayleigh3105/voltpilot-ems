package com.voltpilot.api.topology;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.topology.TopologyRepository.LatestValue;
import com.voltpilot.api.topology.TopologyRepository.RoleOverride;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

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

    /** One entity as the read-model exposes it (camelCase, the EntityController style). */
    public record EntityTopologyDto(UUID id, String entityType, String typeLabel, String label,
            String category, String health, List<CapabilityDto> capabilities) {}

    /** The whole read-model: the entity graph + the derived hub topology. */
    public record TopologyResponse(String schemaVersion, List<EntityTopologyDto> entities,
            TopologyDeriver.Topology topology) {}

    private final EntityRegistryRepository registry;
    private final TopologyRepository repo;
    private final EntityTypeCatalog catalog;
    private final ObjectMapper mapper;

    public TopologyService(EntityRegistryRepository registry, TopologyRepository repo,
            EntityTypeCatalog catalog, ObjectMapper mapper) {
        this.registry = registry;
        this.repo = repo;
        this.catalog = catalog;
        this.mapper = mapper;
    }

    public TopologyResponse topology(UUID siteId) {
        List<EntityRow> rows = registry.entitiesForSite(siteId);
        Map<String, LatestValue> latest = indexLatest(repo.latestValues(siteId));
        Map<String, RoleOverride> overrides = indexOverrides(repo.overrides(siteId));
        Set<String> rolesWithExplicitPrimary = new HashSet<>();
        for (RoleOverride ov : overrides.values()) {
            if (ov.primary() && ov.role() != null && !ov.role().isBlank()) {
                rolesWithExplicitPrimary.add(ov.role());
            }
        }
        Instant now = Instant.now();
        Set<String> firstSeen = new HashSet<>();

        List<EntityTopologyDto> entities = new ArrayList<>();
        List<TopologyDeriver.EntityInput> derivIn = new ArrayList<>();
        for (EntityRow row : rows) {
            String category = categoryOf(row.entityType());
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
                    role = TopologyDeriver.defaultRole(category, channel);
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
                    catalog.labelFor(row.entityType()), row.label(), category, health, caps));
            derivIn.add(new TopologyDeriver.EntityInput(row.id().toString(), row.entityType(),
                    label(row), category, health, derivCaps));
        }

        TopologyDeriver.Topology topo = TopologyDeriver.derive(new TopologyDeriver.Input(derivIn));
        return new TopologyResponse(TopologyDeriver.SCHEMA_VERSION, entities, topo);
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
