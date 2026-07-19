package com.voltpilot.api.profile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.profile.UsageProfileDeriver.Emphasis;
import com.voltpilot.api.profile.UsageProfileDeriver.Signals;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.UsageProfileDto;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Composes the AE7 usage-profile read-model (contract usage-profile.md): gathers
 * the derivation signals for a site from the entity registry (roles), its ACTIVE
 * flows (strategy nodes) and its money master data (plant_kind, Leistungspreis),
 * then runs the pure {@link UsageProfileDeriver}. RLS-scoped through the app
 * datasource like every customer read (admins reach it via the X-Tenant-Id
 * switcher); the caller checks site existence for the 404.
 */
@Service
public class UsageProfileService {

    private static final Logger log = LoggerFactory.getLogger(UsageProfileService.class);
    private static final String STRATEGY_PREFIX = "vp.strategy.";

    private final SiteRepository sites;
    private final EntityRegistryRepository entities;
    private final EntityTypeCatalog catalog;
    private final FlowRepository flows;
    private final ObjectMapper mapper;

    public UsageProfileService(SiteRepository sites, EntityRegistryRepository entities,
            EntityTypeCatalog catalog, FlowRepository flows, ObjectMapper mapper) {
        this.sites = sites;
        this.entities = entities;
        this.catalog = catalog;
        this.flows = flows;
        this.mapper = mapper;
    }

    /** The full profile read-model for a site, or null when RLS hides it (=> 404). */
    public UsageProfileDto profile(UUID siteId) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            return null;
        }
        Signals signals = signals(siteId, site);
        String derived = UsageProfileDeriver.deriveDefault(signals);
        String effective = UsageProfileDeriver.effectiveProfile(signals);
        Emphasis emphasis = UsageProfileDeriver.emphasisFor(effective);
        return new UsageProfileDto(effective, derived, site.usageProfileOverride(),
                new UsageProfileDto.Emphasis(emphasis.money(), emphasis.peak(), emphasis.flow(),
                        emphasis.devices()),
                new UsageProfileDto.Signals(signals.hasStorage(), signals.hasPv(),
                        signals.hasControllableConsumer(),
                        List.copyOf(signals.activeStrategyNodeTypes()), signals.plantKind(),
                        signals.hasLeistungspreis()));
    }

    Signals signals(UUID siteId, SiteDto site) {
        boolean hasStorage = false;
        boolean hasPv = false;
        boolean hasControllableConsumer = false;
        for (EntityRegistryRepository.EntityRow row : entities.entitiesForSite(siteId)) {
            EntityTypeCatalog.EntityType type = catalog.find(row.entityType());
            String category = type == null ? "" : type.category();
            boolean controllable = row.control() || (type != null && type.controllable());
            switch (category) {
                case "storage":
                    hasStorage = true;
                    break;
                case "producer":
                    hasPv = true;
                    break;
                case "consumer":
                    if (controllable) {
                        hasControllableConsumer = true;
                    }
                    break;
                default:
                    break;
            }
        }
        return new Signals(hasStorage, hasPv, hasControllableConsumer, activeStrategyNodeTypes(siteId),
                site.plantKind(), site.leistungspreisEurKw() != null, site.usageProfileOverride());
    }

    /** The vp.strategy.* node types present in the site's ACTIVE flows. */
    private Set<String> activeStrategyNodeTypes(UUID siteId) {
        Set<String> types = new LinkedHashSet<>();
        List<String> docs = new ArrayList<>(flows.activeDocuments(siteId));
        for (String documentJson : docs) {
            if (documentJson == null) {
                continue;
            }
            try {
                JsonNode doc = mapper.readTree(documentJson);
                for (JsonNode node : doc.path("nodes")) {
                    String nodeType = node.path("type").asText();
                    if (nodeType.startsWith(STRATEGY_PREFIX)) {
                        types.add(nodeType);
                    }
                }
            } catch (Exception e) {
                log.warn("active flow document for site {} unreadable, skipped: {}", siteId,
                        e.getMessage());
            }
        }
        return types;
    }
}
