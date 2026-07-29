package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.profile.UsageProfileService;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.web.dto.UsageProfileDto;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The AE7 auto-start-flow seeding hook (spec §3, contract usage-profile.md):
 * seeds a new/converted site with a starter flow DRAFT matching its derived
 * usage profile, so onboarding never dead-ends on an empty editor. Reuses the
 * E3a machinery ({@link FlowTemplates} for the shape, {@link FlowClaims} for the
 * derived claims, {@link FlowRepository#insertDraft} for persistence) - not a
 * new engine. Idempotent: skipped when the site already has any flow.
 */
@Service
public class FlowTemplateService {

    private static final String BATTERY_TYPE = "battery-hybrid";

    /** Outcome of a seed attempt (created, or skipped with a reason). */
    public record AutoStartOutcome(boolean created, String reason, String profile, UUID flowId,
            Integer version, String name, String message) {}

    private final FlowRepository flows;
    private final EntityRegistryRepository entities;
    private final FlowCatalog catalog;
    private final UsageProfileService profiles;
    private final ObjectMapper mapper;

    public FlowTemplateService(FlowRepository flows, EntityRegistryRepository entities,
            FlowCatalog catalog, UsageProfileService profiles, ObjectMapper mapper) {
        this.flows = flows;
        this.entities = entities;
        this.catalog = catalog;
        this.profiles = profiles;
        this.mapper = mapper;
    }

    /**
     * Seed the site's profile-appropriate starter flow if it has none yet.
     * {@code tenantId} is the current tenant (from the RLS context / switcher).
     */
    @Transactional
    public AutoStartOutcome autoStart(UUID siteId, UUID tenantId) {
        return autoStart(siteId, tenantId, null);
    }

    /**
     * Seed a starter flow for a SPECIFIC AE7 profile instead of the derived one
     * (Portal v3 M3): switching a Modus-Profil on seeds THAT profile's starter,
     * not whatever the site currently derives. {@code usageProfile} null =
     * derive (the pre-M3 behaviour, byte-identical).
     */
    @Transactional
    public AutoStartOutcome autoStart(UUID siteId, UUID tenantId, String usageProfile) {
        UsageProfileDto profile = profiles.profile(siteId);
        if (profile == null) {
            return new AutoStartOutcome(false, "not_found", null, null, null, null,
                    "Anlage nicht gefunden.");
        }
        if (!flows.versionsForSite(siteId).isEmpty()) {
            return new AutoStartOutcome(false, "already_has_flow", profile.usageProfile(), null,
                    null, null, "Diese Anlage hat bereits einen Flow - kein Start-Flow angelegt.");
        }
        UUID batteryId = firstBatteryHybrid(siteId);
        if (batteryId == null) {
            return new AutoStartOutcome(false, "no_battery", profile.usageProfile(), null, null,
                    null, "Kein Batteriespeicher an dieser Anlage - der Start-Flow braucht einen "
                            + "Speicher.");
        }

        String kind = usageProfile != null && !usageProfile.isBlank() ? usageProfile
                : profile.usageProfile();
        // No starter for the private household default (self-consumption is the
        // platform's BASE behaviour, not a strategy node) or any unknown profile.
        if (FlowTemplates.strategyNodeType(kind) == null) {
            return new AutoStartOutcome(false, "no_template", kind, null, null, null,
                    "Für dieses Nutzungsprofil gibt es keine Start-Vorlage - der "
                            + "Eigenverbrauch ist bereits das Grundverhalten.");
        }
        ObjectNode doc = FlowTemplates.starterFlow(mapper, kind, batteryId.toString());
        FlowTemplates.applyDerivedClaims(doc, catalog);
        UUID flowId = UUID.randomUUID();
        String name = FlowTemplates.templateName(kind);
        stampIdentity(doc, flowId, siteId, tenantId, name);
        flows.insertDraft(tenantId, siteId, flowId, 1, name, "edge", doc.toString());
        return new AutoStartOutcome(true, null, kind, flowId, 1, name,
                "Start-Flow \"" + name + "\" angelegt (Entwurf) - im Editor verfeinerbar.");
    }

    private UUID firstBatteryHybrid(UUID siteId) {
        for (EntityRegistryRepository.EntityRow row : entities.entitiesForSite(siteId)) {
            if (BATTERY_TYPE.equals(row.entityType())) {
                return row.id();
            }
        }
        return null;
    }

    private void stampIdentity(ObjectNode doc, UUID flowId, UUID siteId, UUID tenantId,
            String name) {
        doc.put("schema_version", "1.0");
        doc.put("name", name);
        doc.put("runtime", "edge");
        doc.put("flow_id", flowId.toString());
        doc.put("flow_version", 1);
        doc.put("site_id", siteId.toString());
        if (tenantId != null) {
            doc.put("tenant_id", tenantId.toString());
        }
        doc.put("lifecycle", "draft");
    }
}
