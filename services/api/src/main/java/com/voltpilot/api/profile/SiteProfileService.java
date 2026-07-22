package com.voltpilot.api.profile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowService;
import com.voltpilot.api.flows.FlowTemplateService;
import com.voltpilot.api.profile.SiteProfileCatalog.Profile;
import com.voltpilot.api.profile.UsageProfileDeriver.Signals;
import com.voltpilot.api.repo.FlowGatedNodeRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.repo.SiteProfileStateRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.SiteProfilesDto;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Modus-Profile shelf service (Portal v3 M3, spec
 * {@code docs/portal-v3/M3-profile.md}): it merges the STORED customer intent
 * ({@link SiteProfileStateRepository}) with the derivation signals
 * ({@link UsageProfileService}) into the shelf read-model, and performs the two
 * transitions.
 *
 * <p><b>Every profile is a direct customer toggle.</b> There is no "angefragt"
 * state and no VoltPilot-request wall (owner decision). Switching a profile ON
 * makes the SERVER (a) enable exactly that profile's gated node types for the
 * site, (b) seed its starter flow, (c) persist {@code an}. Switching it OFF
 * deactivates its flows, disables the node types again and persists {@code aus}
 * so a re-derived signal cannot silently re-enable it.
 *
 * <p><b>The gate is opened, never faked</b> (BUILD.md §4.9): the enablement is
 * an authorized, audited server-side effect of an explicit customer action -
 * written through the RLS-scoped app datasource for the caller's own site. The
 * activation path still re-checks it, the peak-shaving configuration gate still
 * holds, and the edge guard chain / §14a / EEG protections are untouched.
 */
@Service
public class SiteProfileService {

    private static final Logger log = LoggerFactory.getLogger(SiteProfileService.class);

    private static final String ORIGIN_MASTERDATA = "masterdata";
    private static final String ORIGIN_FLOW = "flow";

    private final SiteRepository sites;
    private final SiteProfileStateRepository states;
    private final UsageProfileService usageProfiles;
    private final FlowGatedNodeRepository gatedNodes;
    private final FlowRepository flows;
    private final FlowService flowService;
    private final FlowTemplateService templates;
    private final FlowCatalog catalog;
    private final ObjectMapper mapper;

    public SiteProfileService(SiteRepository sites, SiteProfileStateRepository states,
            UsageProfileService usageProfiles, FlowGatedNodeRepository gatedNodes,
            FlowRepository flows, FlowService flowService, FlowTemplateService templates,
            FlowCatalog catalog, ObjectMapper mapper) {
        this.sites = sites;
        this.states = states;
        this.usageProfiles = usageProfiles;
        this.gatedNodes = gatedNodes;
        this.flows = flows;
        this.flowService = flowService;
        this.templates = templates;
        this.catalog = catalog;
        this.mapper = mapper;
    }

    // -- read ---------------------------------------------------------------

    /** The shelf of a site, or null when RLS hides it (=&gt; 404). */
    public SiteProfilesDto profiles(UUID siteId) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            return null;
        }
        return shelf(siteId, site);
    }

    private SiteProfilesDto shelf(UUID siteId, SiteDto site) {
        Signals signals = usageProfiles.signals(siteId, site);
        Map<String, String> stored = states.findBySite(siteId);
        Set<String> enabled = gatedNodes.enabledNodeTypes(siteId);
        Map<String, FlowVersionRow> strategyFlows = activeStrategyFlows(siteId);

        List<SiteProfilesDto.Profile> cards = new ArrayList<>();
        for (Profile p : SiteProfileCatalog.profiles()) {
            String state = stored.get(p.id());
            boolean derived = derivedActive(p, site, signals, strategyFlows.keySet());
            boolean active = SiteProfileStateRepository.STATE_AUS.equals(state) ? false
                    : SiteProfileStateRepository.STATE_AN.equals(state) || derived;
            List<SiteProfilesDto.Requirement> requirements = requirements(p, site, signals);
            FlowVersionRow flow = strategyFlows.get(p.strategyType());
            List<String> gated = List.copyOf(SiteProfileCatalog.gatedNodeTypes(p, catalog));
            cards.add(new SiteProfilesDto.Profile(p.id(), p.label(), state, derived, active,
                    unlocks(p), requirements, active ? blockedReason(p, requirements) : null,
                    active ? (flow != null ? ORIGIN_FLOW : ORIGIN_MASTERDATA) : null,
                    flow == null ? null
                            : new SiteProfilesDto.FlowRef(flow.flowId().toString(), flow.name()),
                    gated, gated.isEmpty() || enabled.containsAll(gated)));
        }
        return new SiteProfilesDto(cards);
    }

    // -- write --------------------------------------------------------------

    /**
     * Toggle one profile. Returns the recomputed shelf; a foreign/unknown site
     * is a 404 through RLS, an unknown profile/state a 400.
     */
    @Transactional
    public SiteProfilesDto setState(UUID siteId, String profileId, String state) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        Profile profile = SiteProfileCatalog.find(profileId);
        if (profile == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekanntes Profil: " + profileId + ".");
        }
        if (!SiteProfileStateRepository.STATE_AN.equals(state)
                && !SiteProfileStateRepository.STATE_AUS.equals(state)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "state muss \"an\" oder \"aus\" sein.");
        }
        UUID tenantId = TenantContext.get();
        if (SiteProfileStateRepository.STATE_AN.equals(state)) {
            switchOn(siteId, tenantId, profile, site);
        } else {
            switchOff(siteId, tenantId, profile);
        }
        states.upsert(tenantId, siteId, profile.id(), state);
        return shelf(siteId, site);
    }

    private void switchOn(UUID siteId, UUID tenantId, Profile profile, SiteDto site) {
        // OPEN(O1, BUILD.md §8 / M3-profile.md): the toggle is INTENT. A bare
        // customer switch must not start UNCONTRACTED market participation, so
        // the market strategy is only really opened when the site actually has
        // market access - a dynamic tariff and/or Direktvermarktung, the same
        // master data the surface derivation and the optimizer's pricing layer
        // read. Without it the profile still switches on (and says so honestly
        // via blockedReason), but its gated node stays closed and no starter
        // flow is seeded, so NOTHING trades. Toggling NEVER writes that master
        // data - a tariff or a DV contract is a real-world fact, entered on the
        // Vergütung form. If the owner answers O1 with "an explicit contract
        // flag is required", this ONE condition changes.
        if (SiteProfileCatalog.MARKTVERMARKTUNG.equals(profile.id()) && !hasMarketAccess(site)) {
            log.info("Marktoptimierung switched on for site {} without market access - "
                    + "intent stored, gated node NOT opened, no starter flow seeded", siteId);
            return;
        }
        for (String nodeType : SiteProfileCatalog.gatedNodeTypes(profile, catalog)) {
            gatedNodes.upsert(tenantId, siteId, nodeType, true);
        }
        if (profile.usageProfile() != null) {
            FlowTemplateService.AutoStartOutcome outcome =
                    templates.autoStart(siteId, tenantId, profile.usageProfile());
            if (!outcome.created()) {
                // already_has_flow / no_battery are honest, expected outcomes -
                // the card surfaces them, they never fail the toggle.
                log.debug("auto-start for profile {} on site {} skipped: {}", profile.id(), siteId,
                        outcome.reason());
            }
        }
    }

    private void switchOff(UUID siteId, UUID tenantId, Profile profile) {
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            if ("active".equals(row.lifecycle()) && carries(row, profile.strategyType())) {
                flowService.deactivate(siteId, row.flowId());
            }
        }
        for (String nodeType : SiteProfileCatalog.gatedNodeTypes(profile, catalog)) {
            gatedNodes.upsert(tenantId, siteId, nodeType, false);
        }
    }

    // -- derivation ---------------------------------------------------------

    /**
     * Whether the derivation alone activates this profile - the SAME signals
     * the portal's {@code activeModes(site)} reads (M0 {@code surface.ts}); the
     * derived value is never stored (the AE7 rule).
     */
    private boolean derivedActive(Profile profile, SiteDto site, Signals signals,
            Set<String> activeStrategyTypes) {
        boolean strategyNode = signals.activeStrategyNodeTypes().contains(profile.strategyType())
                || activeStrategyTypes.contains(profile.strategyType());
        switch (profile.id()) {
            case SiteProfileCatalog.EIGENVERBRAUCH:
                return (signals.hasStorage() && signals.hasPv() && !isDirektvermarktung(site))
                        || strategyNode;
            case SiteProfileCatalog.MARKTVERMARKTUNG:
                return isDirektvermarktung(site)
                        || (site.netzladenErlaubt() && "dynamisch".equals(site.tarifArt()))
                        || strategyNode;
            case SiteProfileCatalog.LASTSPITZENKAPPUNG:
                return signals.hasLeistungspreis() || strategyNode;
            default:
                return strategyNode;
        }
    }

    /** Market access = a dynamic tariff and/or Direktvermarktung (see OPEN(O1)). */
    private boolean hasMarketAccess(SiteDto site) {
        return "dynamisch".equals(site.tarifArt()) || isDirektvermarktung(site);
    }

    private boolean isDirektvermarktung(SiteDto site) {
        return "direktvermarktung".equals(site.plantKind());
    }

    private List<SiteProfilesDto.Requirement> requirements(Profile profile, SiteDto site,
            Signals signals) {
        List<SiteProfilesDto.Requirement> chips = new ArrayList<>();
        switch (profile.id()) {
            case SiteProfileCatalog.EIGENVERBRAUCH:
                chips.add(new SiteProfilesDto.Requirement("PV-Erzeugung", signals.hasPv()));
                chips.add(new SiteProfilesDto.Requirement("Speicher", signals.hasStorage()));
                break;
            case SiteProfileCatalog.MARKTVERMARKTUNG:
                chips.add(new SiteProfilesDto.Requirement("Dynamischer Tarif oder "
                        + "Direktvermarktung", hasMarketAccess(site)));
                chips.add(new SiteProfilesDto.Requirement("Speicher", signals.hasStorage()));
                break;
            case SiteProfileCatalog.LASTSPITZENKAPPUNG:
                chips.add(new SiteProfilesDto.Requirement("Leistungspreis hinterlegt",
                        signals.hasLeistungspreis()));
                chips.add(new SiteProfilesDto.Requirement("Speicher", signals.hasStorage()));
                break;
            default:
                chips.add(new SiteProfilesDto.Requirement("Leistungsmessung",
                        signals.hasLeistungspreis()));
                break;
        }
        return chips;
    }

    /**
     * The honest German sentence for a profile that IS switched on but cannot
     * fully run yet - specific about what is missing, never a request prompt.
     */
    private String blockedReason(Profile profile, List<SiteProfilesDto.Requirement> requirements) {
        if (SiteProfileCatalog.ATYPISCHE_NETZNUTZUNG.equals(profile.id())) {
            return "VoltPilot berechnet die Netzentgelt-Ersparnis der atypischen Netznutzung für "
                    + "Ihre Anlage noch nicht - es wird dafür nichts gesteuert.";
        }
        boolean allMet = requirements.stream().allMatch(SiteProfilesDto.Requirement::met);
        if (allMet) {
            return null;
        }
        switch (profile.id()) {
            case SiteProfileCatalog.MARKTVERMARKTUNG:
                if (!met(requirements, 0)) {
                    return "Für den Handel fehlt der Marktzugang: Ihre Anlage hat weder einen "
                            + "dynamischen Stromtarif noch eine Direktvermarktung hinterlegt. "
                            + "Solange wird nichts am Markt gehandelt.";
                }
                return "Ohne Speicher kann VoltPilot am Markt nichts verschieben.";
            case SiteProfileCatalog.LASTSPITZENKAPPUNG:
                if (!met(requirements, 0)) {
                    return "Ihr Leistungspreis ist noch nicht hinterlegt - ohne ihn kann VoltPilot "
                            + "Ihre Lastspitze nicht bewerten und kappt sie noch nicht.";
                }
                return "Ohne Speicher lässt sich Ihre Lastspitze nicht kappen.";
            case SiteProfileCatalog.EIGENVERBRAUCH:
            default:
                if (!met(requirements, 0)) {
                    return "Ohne PV-Erzeugung gibt es keinen Eigenverbrauch zu optimieren.";
                }
                return "Ohne Speicher kann VoltPilot Ihren Solarstrom nicht in den Abend "
                        + "verschieben.";
        }
    }

    private boolean met(List<SiteProfilesDto.Requirement> requirements, int index) {
        return index < requirements.size() && requirements.get(index).met();
    }

    /** What switching this profile on adds to the surface (M0 manifests). */
    private SiteProfilesDto.Unlocks unlocks(Profile profile) {
        switch (profile.id()) {
            case SiteProfileCatalog.EIGENVERBRAUCH:
                return new SiteProfilesDto.Unlocks(List.of("erloes-historie"),
                        List.of("eigenverbrauch"), "eigenverbrauchswert");
            case SiteProfileCatalog.MARKTVERMARKTUNG:
                return new SiteProfilesDto.Unlocks(
                        List.of("fahrplan", "marktpreise", "prognosequalitaet", "erloes-historie"),
                        List.of("handel"), "einspeisung");
            case SiteProfileCatalog.LASTSPITZENKAPPUNG:
                return new SiteProfilesDto.Unlocks(List.of("lastspitzen", "erloes-historie"),
                        List.of("peak-band"), "lastspitzen");
            default:
                return new SiteProfilesDto.Unlocks(List.of(), List.of(), null);
        }
    }

    /** The ACTIVE flow carrying each strategy node type (first wins). */
    private Map<String, FlowVersionRow> activeStrategyFlows(UUID siteId) {
        Map<String, FlowVersionRow> byType = new LinkedHashMap<>();
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            if (!"active".equals(row.lifecycle())) {
                continue;
            }
            for (String type : nodeTypes(row)) {
                byType.putIfAbsent(type, row);
            }
        }
        return byType;
    }

    private boolean carries(FlowVersionRow row, String nodeType) {
        return nodeTypes(row).contains(nodeType);
    }

    private List<String> nodeTypes(FlowVersionRow row) {
        List<String> types = new ArrayList<>();
        if (row.documentJson() == null) {
            return types;
        }
        try {
            JsonNode doc = mapper.readTree(row.documentJson());
            for (JsonNode node : doc.path("nodes")) {
                types.add(node.path("type").asText());
            }
        } catch (Exception e) {
            log.warn("flow document {} unreadable, skipped: {}", row.flowId(), e.getMessage());
        }
        return types;
    }
}
