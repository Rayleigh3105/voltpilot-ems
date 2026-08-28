package com.voltpilot.api.profile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargerComponentComposer;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.profile.UsageProfileDeriver.Emphasis;
import com.voltpilot.api.profile.UsageProfileDeriver.Signals;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.TopologyDeriver;
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

    /**
     * The derivation signals of one site.
     *
     * <p><b>hasPv / hasStorage are CAPABILITY-based, not category-based (MIG
     * §4).</b> Keying on the entity category {@code producer} was measured wrong
     * on every real hybrid plant: a battery-hybrid is category {@code storage}
     * and already MEASURES {@code pv_power_kw}, so a correctly composed hybrid
     * site reported {@code hasPv: false} - the Eigenverbrauch mode could never
     * fire and the portal kept asking for the PV it already had. The rule is now
     * the SAME one the AE1 topology uses
     * ({@link com.voltpilot.api.topology.TopologyDeriver#defaultRole}): a
     * capability that resolves to role {@code pv} means PV, one that resolves to
     * {@code storage} means storage - so profile and topology can no longer
     * disagree about the same plant.
     *
     * <p>{@code hasControllableConsumer} additionally requires a non-empty
     * {@code actuate} list: a consumer-category entity nobody can switch (the
     * synthesized {@code house-load}) must never light up device-automation
     * affordances.
     *
     * <p>{@code hasChargePoint} is the Lastmanagement-Stufe-3 signal and keys on
     * the entity TYPE, not a capability: a Ladepunkt is recognisable as a thing,
     * and its measure channels ({@code power_kw}) are the same ones every other
     * consumer has.
     */
    Signals signals(UUID siteId, SiteDto site) {
        return plantSignals(siteId, site).signals();
    }

    /**
     * Die AE7-Signale PLUS {@code hasMeasurement} - in EINEM Durchlauf über die
     * Entitäten. Der Anwendungs-Katalog braucht die Messwert-Tatsache für die
     * Basis-Anwendung „Anlage beobachten"; sie in {@link Signals} aufzunehmen
     * hätte den AE7-Vertrag samt seiner geteilten Vektoren geändert, ein
     * zweiter Lesepfad wäre eine zweite Abfrage auf einem heißen Pfad.
     *
     * @param signals        die unveränderten AE7-Signale
     * @param hasMeasurement ≥ 1 Entität deklariert einen Messkanal
     */
    record PlantSignals(Signals signals, boolean hasMeasurement) {}

    PlantSignals plantSignals(UUID siteId, SiteDto site) {
        boolean hasStorage = false;
        boolean hasPv = false;
        boolean hasControllableConsumer = false;
        boolean hasChargePoint = false;
        boolean hasMeasurement = false;
        for (EntityRegistryRepository.EntityRow row : entities.entitiesForSite(siteId)) {
            if (ChargerComponentComposer.TYPE_EV_CHARGER.equals(row.entityType())) {
                hasChargePoint = true;
            }
            EntityTypeCatalog.EntityType type = catalog.find(row.entityType());
            String category = type == null ? "" : type.category();
            if (capabilities(row.capabilitiesJson()).path("measure").size() > 0) {
                hasMeasurement = true;
            }
            for (String role : measuredRoles(row.entityType(), category,
                    row.capabilitiesJson())) {
                if (TopologyDeriver.ROLE_PV.equals(role)) {
                    hasPv = true;
                } else if (TopologyDeriver.ROLE_STORAGE.equals(role)) {
                    hasStorage = true;
                }
            }
            boolean controllable = (row.control() || (type != null && type.controllable()))
                    && hasActuate(row.capabilitiesJson());
            if ("consumer".equals(category) && controllable) {
                hasControllableConsumer = true;
            }
        }
        return new PlantSignals(new Signals(hasStorage, hasPv, hasControllableConsumer,
                hasChargePoint, activeStrategyNodeTypes(siteId), site.plantKind(),
                site.leistungspreisEurKw() != null, site.usageProfileOverride()), hasMeasurement);
    }

    /** The topology roles this entity's measure channels resolve to. */
    private Set<String> measuredRoles(String entityType, String category,
            String capabilitiesJson) {
        Set<String> roles = new LinkedHashSet<>();
        for (JsonNode m : capabilities(capabilitiesJson).path("measure")) {
            // ⚠ Der Entitäts-TYP muss mit (Cockpit Phase 1 / C2): der Katalogtyp
            // ev-charger deklariert soc_pct, und ohne ihn zählte der Ladestand
            // des AUTOS hier als Speicher-Nachweis - eine Anlage mit einer
            // Wallbox und ohne Batterie bekäme das Speicher-Profil.
            String role = TopologyDeriver.defaultRole(entityType, category,
                    m.path("channel").asText(null), "");
            if (role != null && !role.isEmpty()) {
                roles.add(role);
            }
        }
        return roles;
    }

    /** Does the entity actually declare a command? (an empty list is not control) */
    private boolean hasActuate(String capabilitiesJson) {
        return capabilities(capabilitiesJson).path("actuate").size() > 0;
    }

    private JsonNode capabilities(String capabilitiesJson) {
        if (capabilitiesJson == null || capabilitiesJson.isBlank()) {
            return mapper.createObjectNode();
        }
        try {
            return mapper.readTree(capabilitiesJson);
        } catch (Exception e) {
            log.warn("entity capabilities unreadable, treated as empty: {}", e.getMessage());
            return mapper.createObjectNode();
        }
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
