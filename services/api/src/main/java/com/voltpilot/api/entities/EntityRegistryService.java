package com.voltpilot.api.entities;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentAuthority;
import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Grund;
import com.voltpilot.api.uems.RuheRegel;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The v2 entity registry (E1a pilot minimum): composes the three pilot entity
 * types - battery-hybrid, producer, grid-meter - from a v1 site's existing
 * master data, stores them on {@code measurement_point}
 * (entity_type/capabilities/guard_config), and pushes the set to the site's
 * gateway device as ONE retained message on {@code …/v2/entities}
 * (docs/contracts/v2/edge-entity-config.md).
 *
 * <p>NOTHING converts automatically: the bootstrap runs per site, explicitly,
 * through the platform-admin endpoint (the E13a cutover uses it). It is
 * idempotent - re-running refreshes the same rows from the current master data.
 *
 * <p>Guard limits + failsafe land in the registry per decision D-9 (a failsafe
 * carried only in a plan dies with the plan); {@code charge_from_grid_allowed}
 * mirrors {@code site.netzladen_erlaubt} explicitly (D-8: absent would read as
 * NOT allowed on the edge - stored explicitly for registry clarity).
 */
@Service
public class EntityRegistryService {

    private static final Logger log = LoggerFactory.getLogger(EntityRegistryService.class);

    /** Platform SoC window defaults, mirroring the optimizer's 5-95 % band. */
    private static final double DEFAULT_SOC_MIN_PCT = 5;
    private static final double DEFAULT_SOC_MAX_PCT = 95;

    static final String TYPE_BATTERY_HYBRID = "battery-hybrid";
    static final String TYPE_PRODUCER = "producer";
    static final String TYPE_GRID_METER = "grid-meter";
    static final String TYPE_HOUSE_LOAD = "house-load";

    static final String ROLE_GRID_METER = "grid-meter";
    static final String ROLE_HOUSE_LOAD = "house-load";

    /**
     * THE LABEL RULE (Label-Hygiene, migration {@code V20260812000000}, concept
     * vp-entity-alias-k1 "Pfad B"): {@code measurement_point.label} carries ONLY
     * the name a HUMAN gave - the rename pencil, the adopt dialog, the
     * Verbraucher-Assistent. <b>The composition writes NO label at all.</b>
     *
     * <p>That invariant ({@code label != null => human-given}) is what lets the
     * customer-facing name chain put the alias FIRST, above the edge label
     * ({@code entityLabel.deviceName}), without a second column and without a
     * flag threaded through every DTO and all three topology derivations.
     *
     * <p>Composed rows used to carry three provenance constants
     * ("Batteriespeicher (Hybrid-Wechselrichter)", "Netzanschluss/Hausverbrauch
     * (Messung über Wechselrichter)"). They said HOW a value is measured, never
     * what a device is CALLED - and ranked above the edge name they would have
     * renamed a Deye PV row to "Batteriespeicher (…)". They are gone; the
     * provenance line has said it better since M6 ("gemessen über Deye SUN-30K"),
     * and an unnamed row falls back to its role word.
     *
     * <p><b>So: never re-introduce a composed default label here.</b> A name the
     * platform invents is indistinguishable from one the customer chose.
     */
    private static final String COMPOSED_LABEL = null;

    /** Outcome of a best-effort registry push. */
    public record PushOutcome(boolean attempted, boolean published, String reason,
            UUID deviceId) {

        static PushOutcome notConfigured() {
            return new PushOutcome(false, false, "mqtt_not_configured", null);
        }

        static PushOutcome noGateway() {
            return new PushOutcome(false, false, "no_gateway_device", null);
        }

        static PushOutcome result(boolean ok, UUID deviceId) {
            return new PushOutcome(true, ok, ok ? null : "publish_failed", deviceId);
        }
    }

    private final EntityRegistryRepository repo;
    private final ObjectProvider<EntityRegistryPublisher> publisher;
    private final ObjectMapper mapper;
    private final EntityTypeCatalog catalog;
    private final AssetRepository assets;
    private final FlowClaimRepository claims;
    private final DeviceOverrideRepository overrides;
    private final LeadDeviceService leadDevices;
    private final Clock clock;

    /**
     * The @Autowired is LOAD-BEARING (the BrokerAuthzReloader two-constructor
     * footgun): with the package-private test-seam constructor below and no
     * annotation, Spring cannot pick an injection constructor and crash-loops
     * with "No default constructor found".
     */
    @org.springframework.beans.factory.annotation.Autowired
    public EntityRegistryService(EntityRegistryRepository repo,
            ObjectProvider<EntityRegistryPublisher> publisher, ObjectMapper mapper,
            EntityTypeCatalog catalog, AssetRepository assets, FlowClaimRepository claims,
            DeviceOverrideRepository overrides, LeadDeviceService leadDevices) {
        this(repo, publisher, mapper, catalog, assets, claims, overrides, leadDevices,
                Clock.systemUTC());
    }

    EntityRegistryService(EntityRegistryRepository repo,
            ObjectProvider<EntityRegistryPublisher> publisher, ObjectMapper mapper,
            EntityTypeCatalog catalog, AssetRepository assets, FlowClaimRepository claims,
            DeviceOverrideRepository overrides, LeadDeviceService leadDevices, Clock clock) {
        this.repo = repo;
        this.publisher = publisher;
        this.mapper = mapper;
        this.catalog = catalog;
        this.assets = assets;
        this.claims = claims;
        this.overrides = overrides;
        this.leadDevices = leadDevices;
        this.clock = clock;
    }

    /**
     * Create/refresh the pilot entities of one site from its current master
     * data, then best-effort push the registry to the gateway device. Returns
     * the resulting entity rows + the push outcome.
     */
    @Transactional
    public BootstrapResult bootstrap(UUID siteId) {
        UUID tenantId = TenantContext.get();
        List<String> skipped = new ArrayList<>();

        BatteryAsset battery = repo.batteryAsset(siteId);
        // Die führende Box (IP-5): EINMAL aufgelöst, dieselbe für beide Kompositionen hier und
        // für den Push am Ende - bis IP-6 trägt sie die ganze Anlagen-Summe.
        UUID gateway = leadDevices.fuehrendeBox(siteId).box();
        if (battery != null) {
            UUID pointId = repo.batteryHybridPointId(siteId);
            if (pointId == null) {
                pointId = repo.createBatteryHybridPoint(tenantId, siteId, COMPOSED_LABEL,
                        gateway);
            }
            repo.setEntityConfig(pointId, TYPE_BATTERY_HYBRID,
                    write(batteryCapabilities(battery)),
                    write(batteryGuards(battery, repo.netzladenErlaubt(siteId))));
        } else {
            skipped.add("battery-hybrid: no battery asset on this site");
        }

        synthesizeGatewayPoints(tenantId, siteId, gateway, skipped);

        for (EntityRow point : repo.pointsForSite(siteId)) {
            switch (point.role()) {
                case "pv-generation" -> repo.setEntityConfig(point.id(), TYPE_PRODUCER,
                        write(producerCapabilities(point)), write(producerGuards(point)));
                case ROLE_GRID_METER -> repo.setEntityConfig(point.id(), TYPE_GRID_METER,
                        write(gridMeterCapabilities()), write(gridMeterGuards()));
                case ROLE_HOUSE_LOAD -> repo.setEntityConfig(point.id(), TYPE_HOUSE_LOAD,
                        write(houseLoadCapabilities()), write(houseLoadGuards()));
                default -> {
                    // battery-hybrid handled above; future roles are E1b+.
                }
            }
        }

        PushOutcome push = pushRegistryBestEffort(siteId);
        return new BootstrapResult(repo.entitiesForSite(siteId), skipped, push);
    }

    /** Rows + skips + push outcome of one bootstrap run. */
    public record BootstrapResult(List<EntityRow> entities, List<String> skipped,
            PushOutcome push) {}

    /**
     * THE COMPOSITION CONTRACT (MIG §2, measured on the captain's real fleet -
     * do not "restore the symmetry" without re-measuring):
     *
     * <ul>
     *   <li><b>battery-hybrid</b> from the battery ASSET - unchanged. It already
     *       carries {@code pv_power_kw}, so it alone covers the PV role of a
     *       hybrid site.</li>
     *   <li><b>producer</b> ONLY from a {@code pv-generation} measurement POINT
     *       (a genuinely separate AC-coupled array, recorded by the customer or
     *       adopted from an edge-reported source). <b>The {@code pv} ASSET never
     *       becomes an entity</b>: it is the site AGGREGATE, and the topology
     *       sums per role, so composing it next to the hybrid DOUBLE-COUNTS the
     *       PV (measured: 5,85 kW read as 11,7 kW).</li>
     *   <li><b>grid-meter</b> and <b>house-load</b> are SYNTHESIZED from the
     *       gateway device when no such point exists: v1 renders Netz + Haus
     *       from the gateway's own {@code power_kw} / {@code load_kw}, and
     *       without an entity owning those channels both nodes vanish from the
     *       v2 Energiefluss. Both are measure-only ({@code control = false}, no
     *       {@code actuate}) - the DB CHECK enforces it - so nothing composed
     *       here can ever reach a device.</li>
     * </ul>
     *
     * <p>Synthesis needs an unambiguous gateway; without one (no claimed device)
     * nothing is composed - a device-less site keeps its honest v1 face.
     */
    private void synthesizeGatewayPoints(UUID tenantId, UUID siteId, UUID gateway,
            List<String> skipped) {
        if (gateway == null) {
            skipped.add("grid-meter/house-load: no unambiguous gateway device to measure through");
            return;
        }
        ensureComposedPoint(tenantId, siteId, ROLE_GRID_METER, gateway);
        ensureComposedPoint(tenantId, siteId, ROLE_HOUSE_LOAD, gateway);
    }

    /**
     * Create the measure-only point for a role once; an existing one wins.
     * Deliberately UNNAMED ({@link #COMPOSED_LABEL}) - the surfaces derive the
     * role word, and a name the platform invents would be indistinguishable
     * from one the customer chose.
     */
    private void ensureComposedPoint(UUID tenantId, UUID siteId, String role, UUID gateway) {
        if (repo.pointIdByRole(siteId, role) != null) {
            return;
        }
        repo.createComposedPoint(tenantId, siteId, role, COMPOSED_LABEL, gateway);
    }

    /** What the automatic composition did with one site (MIG §6). */
    public enum BackfillOutcome {
        /** Composed now - stamp the marker. */
        MIGRATED,
        /** Already carries v2 entities (admin bootstrap / earlier run) - stamp, compose nothing. */
        ALREADY_V2,
        /**
         * No unambiguous gateway device: composing would replace the honest v1
         * onboarding guide with an empty Energiefluss on a plant that has no
         * telemetry and no gateway to push a registry to. Do NOT stamp - the
         * site is picked up automatically on a later boot once a device is
         * claimed (MIG §7, the Mienbach case).
         */
        SKIPPED_NO_GATEWAY
    }

    /**
     * The guarded unit of the automatic composition: compose this site's pilot
     * entities unless it is already complete or has no gateway. Runs under the
     * caller-established {@link TenantContext} through the RLS-scoped
     * repository, exactly like the admin bootstrap endpoint - ONE composition
     * truth, no SQL twin. Every automatic trigger goes through here (device
     * claim, battery save, the periodic reconciler), so they can never disagree
     * about WHAT gets composed.
     *
     * <p><b>Two reasons to compose, and the second one is not cosmetic.</b> The
     * obvious one is a site with no entity rows at all. The second is a site
     * whose composition is BEHIND its master data: a device claimed before the
     * battery was entered composes the gateway-synthesized grid-meter and
     * house-load, and without this rule the battery-hybrid - the row carrying
     * PV + Speicher of a hybrid inverter - would never appear, because
     * {@code hasEntities} is already true. Keyed on the battery POINT (not its
     * entity config) on purpose: deleting a composed entity keeps its point, so
     * a deliberate delete is never silently re-composed.
     *
     * <p>Re-running {@link #bootstrap} is safe by construction - it creates
     * what is missing and refreshes composed configs from the v1 master data
     * they are derived from, which is the documented maintenance rule for
     * composed pilot entities.
     */
    @Transactional
    public BackfillOutcome bootstrapIfEligible(UUID siteId) {
        BatteryAsset battery = repo.batteryAsset(siteId);
        boolean batteryUncomposed = battery != null && repo.batteryHybridPointId(siteId) == null;
        if (repo.hasEntities(siteId) && !batteryUncomposed) {
            return BackfillOutcome.ALREADY_V2;
        }
        if (!leadDevices.fuehrendeBox(siteId).bestimmt()) {
            return BackfillOutcome.SKIPPED_NO_GATEWAY;
        }
        bootstrap(siteId);
        return BackfillOutcome.MIGRATED;
    }

    // ---- Conversion preview (MIG: dry-run, writes NOTHING) ------------------

    /** One entity a bootstrap run would create or refresh, for operator review. */
    public record PlannedEntity(UUID pointId, String action, String entityType, String label,
            List<String> roles, com.fasterxml.jackson.databind.JsonNode capabilities,
            com.fasterxml.jackson.databind.JsonNode guards) {}

    /**
     * A read-only preview of exactly what {@link #bootstrap(UUID)} would
     * create/refresh from the site's CURRENT master data, plus the resolved
     * gateway device and the derived per-capability roles - so the operator can
     * review before applying. Writes NOTHING (no measurement_point row, no
     * registry state, no MQTT push).
     */
    public record ConversionPreview(boolean alreadyConverted, UUID gatewayDevice,
            String gatewayReason, List<PlannedEntity> plan, List<String> skipped) {}

    /**
     * Dry-run the conversion of one v1 site to the v2 pilot entity model. This
     * is the review step of the migration runbook: it composes the SAME
     * capabilities/guards {@link #bootstrap} would write and reports them
     * without touching any table. {@code action} is {@code "create"} for a row
     * that would newly become a v2 entity and {@code "refresh"} for one already
     * stamped (re-run). v1 tables (asset/site/telemetry) are only READ.
     */
    @Transactional(readOnly = true)
    public ConversionPreview preview(UUID siteId) {
        List<PlannedEntity> plan = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        // Only used by the battery-hybrid branch below, where the row is NOT in
        // the pointsForSite loop's own switch (it is "counted from the asset").


        BatteryAsset battery = repo.batteryAsset(siteId);
        if (battery != null) {
            UUID pointId = repo.batteryHybridPointId(siteId);
            ObjectNode caps = batteryCapabilities(battery);
            ObjectNode guards = batteryGuards(battery, repo.netzladenErlaubt(siteId));
            // LOCKSTEP with bootstrap(): a CREATE composes no label at all
            // (Label-Hygiene), a REFRESH keeps whatever a human named it - the
            // preview must never claim the conversion renames a customer's row.
            plan.add(new PlannedEntity(pointId, pointId != null ? "refresh" : "create",
                    TYPE_BATTERY_HYBRID, pointId == null ? COMPOSED_LABEL : labelOfPoint(siteId,
                            pointId),
                    rolesFor(TYPE_BATTERY_HYBRID, caps), caps, guards));
        } else {
            skipped.add("battery-hybrid: no battery asset on this site");
        }

        boolean hasGridPoint = false;
        boolean hasHousePoint = false;
        for (EntityRow point : repo.pointsForSite(siteId)) {
            String action = point.entityType() != null ? "refresh" : "create";
            switch (point.role()) {
                case "pv-generation" -> {
                    ObjectNode caps = producerCapabilities(point);
                    plan.add(new PlannedEntity(point.id(), action, TYPE_PRODUCER, point.label(),
                            rolesFor(TYPE_PRODUCER, caps), caps, producerGuards(point)));
                }
                case ROLE_GRID_METER -> {
                    hasGridPoint = true;
                    ObjectNode caps = gridMeterCapabilities();
                    plan.add(new PlannedEntity(point.id(), action, TYPE_GRID_METER, point.label(),
                            rolesFor(TYPE_GRID_METER, caps), caps, gridMeterGuards()));
                }
                case ROLE_HOUSE_LOAD -> {
                    hasHousePoint = true;
                    ObjectNode caps = houseLoadCapabilities();
                    plan.add(new PlannedEntity(point.id(), action, TYPE_HOUSE_LOAD, point.label(),
                            rolesFor(TYPE_HOUSE_LOAD, caps), caps, houseLoadGuards()));
                }
                case "battery-hybrid" -> {
                    // counted from the battery asset above.
                }
                default -> skipped.add(point.role()
                        + ": no v2 mapping in the pilot conversion (E1a types only)");
            }
        }

        LeadDeviceService.FuehrendeBox lead = leadDevices.fuehrendeBox(siteId);
        UUID gateway = lead.box();
        // The synthesized gateway points (MIG §2.3/§2.4) - LOCKSTEP with
        // synthesizeGatewayPoints() in bootstrap(), or the preview lies about
        // what the conversion will do.
        if (gateway == null) {
            skipped.add("grid-meter/house-load: no unambiguous gateway device to measure through");
        } else {
            if (!hasGridPoint) {
                ObjectNode caps = gridMeterCapabilities();
                plan.add(new PlannedEntity(null, "create", TYPE_GRID_METER, COMPOSED_LABEL,
                        rolesFor(TYPE_GRID_METER, caps), caps, gridMeterGuards()));
            }
            if (!hasHousePoint) {
                ObjectNode caps = houseLoadCapabilities();
                plan.add(new PlannedEntity(null, "create", TYPE_HOUSE_LOAD, COMPOSED_LABEL,
                        rolesFor(TYPE_HOUSE_LOAD, caps), caps, houseLoadGuards()));
            }
        }
        return new ConversionPreview(repo.hasEntities(siteId), gateway, gatewayReason(lead),
                plan, skipped);
    }

    /**
     * The stored label of one of the site's measurement points, or null. Used
     * by {@link #preview} so a REFRESH reports the name a human actually gave
     * instead of a composed default (there is none any more).
     */
    private String labelOfPoint(UUID siteId, UUID pointId) {
        // ⚠ NOT `.map(EntityRow::label).findFirst()`: an unnamed point maps to a
        // null element, and Optional/findFirst throws NPE on one - which since
        // the Label-Hygiene is the NORMAL case for a composed row.
        return repo.pointsForSite(siteId).stream()
                .filter(p -> pointId.equals(p.id()))
                .findFirst().map(EntityRow::label).orElse(null);
    }

    /**
     * The default topology roles a would-be entity's measure channels resolve
     * to, in canonical order (pv, storage, consumer, grid, charging,
     * charging-own) - exactly what the
     * AE1 read-model {@link com.voltpilot.api.topology.TopologyDeriver} derives,
     * so the preview and the live topology never disagree.
     */
    private List<String> rolesFor(String entityType, ObjectNode capabilities) {
        EntityTypeCatalog.EntityType type = catalog.find(entityType);
        String category = type == null ? "" : type.category();
        java.util.LinkedHashSet<String> found = new java.util.LinkedHashSet<>();
        for (JsonNode m : capabilities.path("measure")) {
            String channel = m.path("channel").asText(null);
            // Der Entitäts-TYP entscheidet mit (Cockpit Phase 1 / C2). Hier ist
            // kein Anschluss bekannt und keiner nötig: gefragt wird nur, OB der
            // Kanal einer Rolle zufällt, nicht welcher der beiden Lade-Rollen.
            String role = com.voltpilot.api.topology.TopologyDeriver.defaultRole(entityType,
                    category, channel, "");
            if (role != null && !role.isEmpty()) {
                found.add(role);
            }
        }
        List<String> canonical = List.of(
                com.voltpilot.api.topology.TopologyDeriver.ROLE_PV,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_STORAGE,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_CONSUMER,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_GRID,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_CHARGING,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_CHARGING_OWN);
        return canonical.stream().filter(found::contains).toList();
    }

    /** The v1->v2 history cutover status of one site (null instant = un-migrated). */
    public record HistoryCutover(Instant cutoverAt) {}

    /**
     * Set the site's history cutover instant (MIG runbook: called when the site
     * goes live on v2 so the portal history splices there). Null = "now".
     * Returns null when the site is not visible under the caller's tenant.
     */
    @Transactional
    public HistoryCutover setHistoryCutover(UUID siteId, Instant at) {
        Instant when = at != null ? at : clock.instant();
        if (!repo.setV2HistoryCutover(siteId, when)) {
            return null;
        }
        return new HistoryCutover(when);
    }

    /**
     * Clear the site's history cutover (MIG rollback: the portal history reverts
     * to pure v1). Returns false when the site is not visible under the tenant.
     */
    @Transactional
    public boolean clearHistoryCutover(UUID siteId) {
        return repo.setV2HistoryCutover(siteId, null);
    }

    /** The site's current history cutover status. */
    @Transactional(readOnly = true)
    public HistoryCutover historyCutover(UUID siteId) {
        return new HistoryCutover(repo.v2HistoryCutover(siteId));
    }

    /**
     * Why no unambiguous gateway device could be resolved (for the preview), in the preview's
     * own closed vocabulary (openapi {@code gatewayReason}); {@code null} when a box leads. The
     * named reason of {@link LeadDeviceService} maps onto it 1:1 - a stored lead box that is not
     * (or no longer) registered in this site is the {@code no_gateway_device} case.
     */
    private static String gatewayReason(LeadDeviceService.FuehrendeBox lead) {
        return switch (lead.grund()) {
            case GESPEICHERT, SPEICHER, EINZIGE -> null;
            case KEINE_BOX -> "no_claimed_device";
            case KEINE_WAHL -> "multiple_devices_no_battery_link";
            case GESPEICHERT_NICHT_IN_ANLAGE -> "no_gateway_device";
        };
    }

    /**
     * Compose the current registry push payload and publish it retained to the
     * site's gateway device. Never throws; a missing publisher/gateway or a
     * broker failure is reported in the outcome only.
     */
    public PushOutcome pushRegistryBestEffort(UUID siteId) {
        UUID tenantId = TenantContext.get();
        LeadDeviceService.FuehrendeBox lead = leadDevices.fuehrendeBox(siteId);
        UUID gateway = lead.box();
        if (gateway == null) {
            log.warn("v2 entity registry for site {} not pushed: no unambiguous gateway device "
                    + "({})", siteId, lead.grund().code());
            return PushOutcome.noGateway();
        }
        // The composed revision is the Soll the edge is expected to echo in
        // its heartbeat (E1b bidirectional sync) - recorded even when the
        // best-effort publish fails or MQTT is not configured (the Soll
        // changed regardless; retained delivery converges later).
        Instant now = clock.instant();
        byte[] payload = composePush(tenantId, siteId, gateway, now, repo.entitiesForSite(siteId),
                repo.componentAuthority(siteId));
        repo.upsertRegistryState(siteId, tenantId, gateway, now.toString());
        EntityRegistryPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            return PushOutcome.notConfigured();
        }
        return PushOutcome.result(pub.publishRegistry(tenantId, siteId, gateway, payload), gateway);
    }

    // ---- E1b: catalog-driven entity CRUD (arbitrary types) ------------------

    /**
     * Create a v2-native entity of an open catalog type (wallbox, heating-rod,
     * generic-load, ...). Pilot types whose config is COMPOSED from v1 master
     * data (catalog {@code composed}) are refused with a German hint - their
     * truth lives in the battery editor / measurement points / bootstrap, and
     * a second source of it would drift. Capabilities/guards default from the
     * catalog (bounded by {@code maxPowerKw} when given); explicit JSON
     * overrides are validated against the contract shapes.
     */
    @Transactional
    public EntityRow createEntity(UUID siteId, String entityType, String label,
            BigDecimal maxPowerKw, JsonNode capabilities, JsonNode guards) {
        EntityTypeCatalog.EntityType type = catalog.find(entityType);
        if (type == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannter Entitätstyp \"" + entityType
                            + "\". Verfügbare Typen liefert der Typkatalog.");
        }
        if (type.composed()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieser Entitätstyp wird aus den Stammdaten der Anlage abgeleitet "
                            + "(Speicher, Messpunkte + Bootstrap) und kann nicht direkt "
                            + "angelegt werden.");
        }
        ObjectNode caps = capabilities != null ? validatedCapabilities(capabilities)
                : defaultCapabilities(type, maxPowerKw);
        ObjectNode g = guards != null ? validatedGuards(guards)
                : defaultGuards(type, maxPowerKw);
        boolean control = type.controllable() && caps.path("actuate").size() > 0;
        UUID tenantId = TenantContext.get();
        UUID pointId = repo.createEntityPoint(tenantId, siteId, entityType, label, control);
        repo.setEntityConfig(pointId, entityType, write(caps), write(g));
        pushRegistryBestEffort(siteId);
        return repo.entityForSite(siteId, pointId);
    }

    /**
     * ADOPT an edge-reported source into a v2 entity (U2, report §3.3): the
     * customer's :8484 device reports a source (go-e wallbox, AC-coupled PV, a
     * grid meter); this creates the matching entity in ONE step, prefilled from
     * the report + the type catalog, and PINS it to the reporting source
     * ({@code edgeSourceId}) so the "Vom Gerät gemeldet" matcher is
     * deterministic. Idempotent: re-adopting the same source returns the
     * existing entity (never a duplicate - the partial-unique index would
     * refuse it anyway).
     *
     * <p><b>One point per (site, source), always.</b> Deleting a COMPOSED entity
     * keeps its point and only clears the entity config, so the pin survives -
     * a re-adoption RE-COMPOSES that very row (kWp applied as a delta, since the
     * aggregate still carries what it contributed) instead of inserting a second
     * row the unique index refuses with an opaque 500.
     *
     * <p>Two paths behind one call, mirroring {@link #createEntity} vs the v1
     * measurement-point capture the panel it replaces did:
     * <ul>
     *   <li>a NON-composed consumer type (wallbox/heating-rod/generic-load) is a
     *       v2-native entity - created exactly like {@code createEntity}, then
     *       stamped with the source id;</li>
     *   <li>a COMPOSED producer / grid-meter is recorded as a read-only source
     *       measurement point (its kWp / MaStR SEE # are the customer-only
     *       master data captured HERE - the ErzeugerSourcesPanel job, §3.4) and
     *       composed into its entity from the catalog. A producer's kWp also
     *       sums into the aggregate {@code asset.pv} the optimizer reads, exactly
     *       as the retired panel did.</li>
     * </ul>
     * The battery-hybrid type is never adopted here (it is the primary inverter,
     * set up via the battery editor + bootstrap).
     */
    @Transactional
    public EntityRow adopt(UUID siteId, String edgeSourceId, String entityType, String label,
            BigDecimal maxPowerKw, BigDecimal capacityKwp, String registryUnitId) {
        if (edgeSourceId == null || edgeSourceId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "sourceId ist erforderlich.");
        }
        // NOT entityByEdgeSource: deleting a COMPOSED entity only clears its
        // config and leaves the point pinned to this source. Missing that row
        // would fall through to an INSERT the partial-unique index refuses (500).
        EntityRow existing = repo.pointByEdgeSource(siteId, edgeSourceId);
        if (existing != null && existing.entityType() != null) {
            return existing; // idempotent re-adoption
        }
        EntityTypeCatalog.EntityType type = catalog.find(entityType);
        if (type == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Unbekannter Entitätstyp \"" + entityType
                            + "\". Verfügbare Typen liefert der Typkatalog.");
        }
        UUID tenantId = TenantContext.get();
        if (!type.composed()) {
            if (existing != null) {
                // A de-entitied COMPOSED point still holds the pin; release it
                // (with its kWp) so the v2-native entity can take the source.
                releaseStalePoint(tenantId, siteId, existing);
            }
            EntityRow created = createEntity(siteId, entityType, label, maxPowerKw, null, null);
            repo.setEdgeSource(created.id(), edgeSourceId);
            return repo.entityForSite(siteId, created.id());
        }
        String role = switch (entityType) {
            case TYPE_PRODUCER -> "pv-generation";
            case TYPE_GRID_METER -> "grid-meter";
            default -> throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieser Entitätstyp wird über den Wechselrichter/Speicher der Anlage "
                            + "eingerichtet und kann nicht als Quelle übernommen werden.");
        };
        BigDecimal capacity = TYPE_PRODUCER.equals(entityType) ? capacityKwp : null;
        String cleanLabel = label == null || label.isBlank() ? null : label;
        String cleanRegistryUnit =
                registryUnitId == null || registryUnitId.isBlank() ? null : registryUnitId;
        // A previously deleted composed entity left its point pinned to this
        // source: re-compose THAT row (one point per source - the unique index).
        BigDecimal previousCapacity = existing == null ? null : existing.capacityKwp();
        UUID pointId;
        if (existing != null) {
            pointId = existing.id();
            repo.updateAdoptedPoint(pointId, role, cleanLabel, capacity, cleanRegistryUnit);
        } else {
            pointId = repo.createAdoptedPoint(tenantId, siteId, role, cleanLabel, false, null,
                    capacity, cleanRegistryUnit, edgeSourceId);
        }
        // Compose the entity config from the catalog (same as the bootstrap).
        if (TYPE_PRODUCER.equals(entityType)) {
            EntityRow probe = new EntityRow(pointId, role, label, null, null, null, null, null,
                    capacity, null, false, null, null, null, edgeSourceId, null, null, null, 1,
                    cleanRegistryUnit);
            repo.setEntityConfig(pointId, TYPE_PRODUCER, write(producerCapabilities(probe)),
                    write(producerGuards(probe)));
            // Only the DELTA on a re-compose - the aggregate still carries what
            // the deleted entity's point contributed (its kWp was never removed).
            BigDecimal deltaKwp = orZero(capacity).subtract(orZero(previousCapacity));
            if (deltaKwp.signum() != 0) {
                assets.addPvCapacity(tenantId, siteId, deltaKwp);
            }
        } else {
            if (previousCapacity != null && previousCapacity.signum() != 0) {
                assets.addPvCapacity(tenantId, siteId, previousCapacity.negate());
            }
            repo.setEntityConfig(pointId, TYPE_GRID_METER, write(gridMeterCapabilities()),
                    write(gridMeterGuards()));
        }
        pushRegistryBestEffort(siteId);
        return repo.entityForSite(siteId, pointId);
    }

    /**
     * Edit an entity: the label always; capabilities/guards/rated power only
     * for non-composed types (composed configs are maintained through their v1
     * master data and would silently drift otherwise - never two truths).
     * Returns the fresh row, or null when the entity is not visible under the
     * caller's tenant (404 upstream).
     */
    @Transactional
    public EntityRow updateEntity(UUID siteId, UUID pointId, String label, BigDecimal maxPowerKw,
            JsonNode capabilities, JsonNode guards) {
        EntityRow row = repo.entityForSite(siteId, pointId);
        if (row == null) {
            return null;
        }
        if (label != null) {
            repo.updateLabel(pointId, label.isBlank() ? null : label);
        }
        boolean configEdit = capabilities != null || guards != null || maxPowerKw != null;
        if (configEdit) {
            EntityTypeCatalog.EntityType type = catalog.find(row.entityType());
            if (type != null && type.composed()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Die Konfiguration dieses Entitätstyps wird aus den Stammdaten der "
                                + "Anlage abgeleitet - bitte dort pflegen (Speicher-Editor, "
                                + "Messpunkte, Netzladen-Schalter).");
            }
            ObjectNode caps;
            ObjectNode g;
            if (capabilities == null && guards == null && type != null) {
                // Only the rated power changed: recompose the defaults with it.
                caps = defaultCapabilities(type, maxPowerKw);
                g = defaultGuards(type, maxPowerKw);
            } else {
                caps = capabilities != null ? validatedCapabilities(capabilities)
                        : (ObjectNode) parseOr(row.capabilitiesJson(), mapper.createObjectNode());
                g = guards != null ? validatedGuards(guards)
                        : (ObjectNode) parseOr(row.guardConfigJson(), mapper.createObjectNode());
            }
            repo.setEntityConfig(pointId, row.entityType(), write(caps), write(g));
        }
        pushRegistryBestEffort(siteId);
        return repo.entityForSite(siteId, pointId);
    }

    /**
     * Remove an entity. A v1-BACKED row (pv-generation / grid-meter
     * measurement point) only loses its entity config - the v1 master data
     * stays; a v2-native row (battery-hybrid bootstrap row, open types) is
     * deleted outright. The re-push makes the edge clear the removed entity's
     * retained config + command. Returns false when not visible (404).
     */
    @Transactional
    public boolean deleteEntity(UUID siteId, UUID pointId) {
        return deleteEntity(siteId, pointId, false);
    }

    /**
     * Remove an entity, optionally PURGING its measurement point outright
     * ({@code purgePoint} - the duplicate-cleanup lever, vp-vier-erzeuger-p9):
     * the default keep-the-point behavior deliberately leaves a composed row
     * (with its source pin and its kWp contribution) in place so a re-adoption
     * re-composes it, but that also means a WRONGLY created duplicate (the
     * Pilsting ghost) reappears as "Neues Gerät gefunden" forever. The purge
     * releases the point's kWp from the aggregate {@code asset.pv} and deletes
     * the row, freeing its edge source for a clean adoption or re-pin.
     */
    @Transactional
    public boolean deleteEntity(UUID siteId, UUID pointId, boolean purgePoint) {
        EntityRow row = repo.entityForSite(siteId, pointId);
        if (row == null) {
            return false;
        }
        if (purgePoint) {
            releaseStalePoint(TenantContext.get(), siteId, row);
        } else if ("pv-generation".equals(row.role()) || "grid-meter".equals(row.role())) {
            repo.clearEntityConfig(pointId);
        } else {
            repo.deletePoint(pointId);
        }
        pushRegistryBestEffort(siteId);
        return true;
    }

    /**
     * RE-PIN an entity to a (different) edge source - the repair lever for
     * identity churn (vp-vier-erzeuger-p9): a source that was deleted +
     * re-added on the device minted a new id, so the entity's pin points into
     * the void ({@code orphanedPin}) and the SAME physical device shows up as
     * "Neues Gerät gefunden". Re-pinning reconnects the existing entity (its
     * label, kWp, history) instead of adopting a duplicate; it also repairs a
     * crossed pin (entity A pinned to device B's source).
     *
     * <p>Pin mechanics only - the caller validates that the target source is
     * currently reported and role-compatible (it holds the observed rows). A
     * target source already pinned to ANOTHER entity is refused with 409; a
     * stale DE-ENTITIED point holding the pin (deleted composed entity) is
     * released (kWp delta + point delete) so the pin can move - the same rule
     * {@link #adopt} applies. Returns null when the entity is not visible
     * under the caller's tenant (404 upstream). Idempotent for the same
     * source id.
     */
    @Transactional
    public EntityRow repin(UUID siteId, UUID entityId, String edgeSourceId) {
        return repin(siteId, entityId, edgeSourceId, false, Set.of());
    }

    /**
     * Re-pin, optionally SWAPPING with the entity that currently holds the
     * target source (vp-bereinigung-ui-k3). Without {@code allowSwap} a taken
     * source is still the documented 409 - the swap must be an explicit,
     * confirmed customer decision, never a silent steal.
     *
     * <p><b>Why the swap lives HERE and not in the portal:</b> a client-side
     * "release, then set" is two requests, and a failure between them strands
     * the customer with BOTH components unassigned - exactly the half-repaired
     * state the cleanup is supposed to end. Inside this one transaction the
     * pins either both move or neither does.
     *
     * <p>What the other entity gets back is deliberately NOT always this
     * entity's previous source: it receives it only when that source is STILL
     * REPORTED ({@code reportedSourceIds}). Handing over a vanished id would
     * merely move the orphan defect to the other component; instead its pin is
     * cleared, which reads as the honest "noch keinem Gerät zugeordnet" and is
     * one click away from being fixed.
     */
    @Transactional
    public EntityRow repin(UUID siteId, UUID entityId, String edgeSourceId, boolean allowSwap,
            Set<String> reportedSourceIds) {
        EntityRow entity = repo.entityForSite(siteId, entityId);
        if (entity == null) {
            return null;
        }
        if (edgeSourceId == null || edgeSourceId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "sourceId ist erforderlich.");
        }
        if (edgeSourceId.equals(entity.edgeSourceId())) {
            return entity;
        }
        EntityRow holder = repo.pointByEdgeSource(siteId, edgeSourceId);
        if (holder != null && !holder.id().equals(entityId)) {
            if (holder.entityType() != null) {
                if (!allowSwap) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            "Dieses Gerät ist bereits mit einer anderen Komponente verbunden. "
                                    + "Bitte lösen Sie zuerst die bestehende Verbindung.");
                }
                String giveBack = entity.edgeSourceId() != null
                        && reportedSourceIds.contains(entity.edgeSourceId())
                                ? entity.edgeSourceId() : null;
                // Clear first: the pin is unique per (site, source), so the two
                // updates cannot cross without releasing the target.
                repo.setEdgeSource(holder.id(), null);
                repo.setEdgeSource(entityId, edgeSourceId);
                if (giveBack != null) {
                    repo.setEdgeSource(holder.id(), giveBack);
                }
                pushRegistryBestEffort(siteId);
                return repo.entityForSite(siteId, entityId);
            }
            releaseStalePoint(TenantContext.get(), siteId, holder);
        }
        repo.setEdgeSource(entityId, edgeSourceId);
        // The pin is part of the pushed registry (`edge_source_id`, PR #272), so
        // the device must learn about a re-pin like it learns about an adopt or
        // a delete - otherwise it keeps serving per-source values against the
        // OLD assignment and the portal and the device disagree.
        pushRegistryBestEffort(siteId);
        return repo.entityForSite(siteId, entityId);
    }

    private static BigDecimal orZero(BigDecimal value) {
        return value == null ? BigDecimal.ZERO : value;
    }

    /**
     * Drop a de-entitied adopted point (and its kWp contribution) so its edge
     * source can be adopted as a v2-native entity instead - the pin is unique
     * per (site, source), so the stale row would otherwise refuse the new one.
     */
    private void releaseStalePoint(UUID tenantId, UUID siteId, EntityRow stale) {
        if (stale.capacityKwp() != null && stale.capacityKwp().signum() != 0) {
            assets.addPvCapacity(tenantId, siteId, stale.capacityKwp().negate());
        }
        repo.deletePoint(stale.id());
    }

    private ObjectNode defaultCapabilities(EntityTypeCatalog.EntityType type,
            BigDecimal maxPowerKw) {
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        for (JsonNode m : type.defaultMeasure()) {
            measure.add(m.deepCopy());
        }
        ArrayNode actuate = caps.putArray("actuate");
        for (JsonNode a : type.defaultActuate()) {
            ObjectNode cap = (ObjectNode) a.deepCopy();
            if (maxPowerKw != null && ("setpoint_kw".equals(cap.path("command").asText())
                    || "limit_kw".equals(cap.path("command").asText()))) {
                cap.put("max", maxPowerKw.doubleValue());
            }
            actuate.add(cap);
        }
        return caps;
    }

    private ObjectNode defaultGuards(EntityTypeCatalog.EntityType type, BigDecimal maxPowerKw) {
        ObjectNode guards = mapper.createObjectNode();
        if ("consumer".equals(type.category()) && maxPowerKw != null) {
            guards.putObject("limits").put("max_consumption_kw", maxPowerKw.doubleValue());
        }
        guards.putObject("failsafe").put("behavior", type.defaultFailsafe());
        return guards;
    }

    private static final java.util.Set<String> COMMAND_VOCAB =
            java.util.Set.of("setpoint_kw", "on_off", "limit_pct", "limit_kw", "mode");
    private static final java.util.Set<String> FAILSAFE_VOCAB =
            java.util.Set.of("self-consumption", "off", "release", "measure-only");
    private static final java.util.Set<String> NUMERIC_LIMIT_KEYS = java.util.Set.of(
            "max_charge_kw", "max_discharge_kw", "soc_min_pct", "soc_max_pct",
            "max_generation_kw", "max_consumption_kw",
            // The consumer cycle-guard limits (Verbrauchssteuerung Inkrement 3,
            // edge-entity.schema.json guard_limits - additive).
            "min_on_seconds", "min_off_seconds", "max_starts_per_day", "ramp_kw_per_min");

    /** Contract-shape validation of an explicit capabilities override. */
    private ObjectNode validatedCapabilities(JsonNode node) {
        if (!node.isObject()) {
            throw badConfig("capabilities muss ein Objekt sein");
        }
        for (String key : new String[] {"measure", "actuate"}) {
            JsonNode list = node.get(key);
            if (list != null && !list.isArray()) {
                throw badConfig("capabilities." + key + " muss eine Liste sein");
            }
        }
        for (JsonNode m : node.path("measure")) {
            if (!m.isObject() || !m.path("channel").asText("").matches("^[a-z][a-z0-9_]{0,63}$")) {
                throw badConfig("Jeder Messkanal braucht einen gültigen channel-Namen");
            }
        }
        for (JsonNode a : node.path("actuate")) {
            if (!a.isObject() || !COMMAND_VOCAB.contains(a.path("command").asText(""))) {
                throw badConfig("Unbekanntes Kommando in capabilities.actuate "
                        + "(erlaubt: setpoint_kw, on_off, limit_pct, limit_kw, mode)");
            }
        }
        return (ObjectNode) node;
    }

    /** Contract-shape validation of an explicit guards override. */
    private ObjectNode validatedGuards(JsonNode node) {
        if (!node.isObject()) {
            throw badConfig("guards muss ein Objekt sein");
        }
        String behavior = node.path("failsafe").path("behavior").asText("");
        if (!FAILSAFE_VOCAB.contains(behavior)) {
            throw badConfig("guards.failsafe.behavior muss eines von "
                    + "self-consumption, off, release, measure-only sein");
        }
        JsonNode limits = node.get("limits");
        if (limits != null) {
            if (!limits.isObject()) {
                throw badConfig("guards.limits muss ein Objekt sein");
            }
            java.util.Iterator<String> names = limits.fieldNames();
            while (names.hasNext()) {
                String key = names.next();
                JsonNode v = limits.get(key);
                if (NUMERIC_LIMIT_KEYS.contains(key)) {
                    if (!v.isNumber() || v.asDouble() < 0) {
                        throw badConfig("guards.limits." + key + " muss eine Zahl >= 0 sein");
                    }
                } else if ("charge_from_grid_allowed".equals(key)) {
                    if (!v.isBoolean()) {
                        throw badConfig("guards.limits.charge_from_grid_allowed muss true/false sein");
                    }
                } else {
                    throw badConfig("Unbekannter Schlüssel guards.limits." + key);
                }
            }
        }
        return (ObjectNode) node;
    }

    private static ResponseStatusException badConfig(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    /**
     * Das Gerät, dem der Push dieser Anlage zugestellt würde, oder {@code null}:
     * die führende Box des {@link LeadDeviceService} (IP-5), dieselbe wie in
     * {@link #pushRegistryBestEffort}. Die Bestands-Übernahme (Stufe 2) fragt es
     * VOR dem Schreiben: eine Autorität ohne Empfänger wäre genau der
     * Halbzustand, den sie ausschließt.
     */
    public UUID gatewayDeviceFor(UUID siteId) {
        return leadDevices.fuehrendeBox(siteId).box();
    }

    /**
     * Ob diese Anlage GERAETE hat, aber kein eindeutiges Empfaenger-Geraet - der
     * Fall {@code multiple_devices_no_battery_link} von {@link #gatewayReason},
     * also der Grund {@code keine_wahl} des {@link LeadDeviceService}: mehrere
     * beanspruchte Geraete, keiner davon als steuerndes Geraet des Speichers
     * hinterlegt und keine Box ausdruecklich gewaehlt.
     *
     * <p>⚠ Bewusst NICHT wahr, wenn die Anlage GAR KEIN Geraet hat: dort gibt es
     * kein Geraet, das einen Stand haben koennte, und ein Satz ueber „mehrere
     * Geraete" waere dann schlicht falsch. Diese eine Unterscheidung ist der
     * ganze Grund, warum es die Methode neben {@link #gatewayDeviceFor} gibt.
     * Ebenso NICHT wahr fuer {@code gespeichert_nicht_in_anlage}: der Satz der
     * Flaeche nennt „mehrere Geraete und keinen zugeordneten Speicher" als
     * Ursache, und die traegt dieser Fall nicht (er kann auch EINE Box haben).
     */
    public boolean gatewayAmbiguous(UUID siteId) {
        return leadDevices.fuehrendeBox(siteId).grund() == Grund.KEINE_WAHL;
    }

    /** The registry_push payload (edge-entity.schema.json $defs/registry_push). */
    byte[] composePush(UUID tenantId, UUID siteId, UUID deviceId, Instant now,
            List<EntityRow> rows) {
        return composePush(tenantId, siteId, deviceId, now, rows, null);
    }

    byte[] composePush(UUID tenantId, UUID siteId, UUID deviceId, Instant now,
            List<EntityRow> rows, String componentAuthority) {
        ObjectNode push = mapper.createObjectNode();
        push.put("schema_version", "1.0");
        push.put("tenant_id", tenantId.toString());
        push.put("site_id", siteId.toString());
        push.put("device_id", deviceId.toString());
        push.put("revision", now.toString());
        push.put("published_at", now.toString());
        // Einheitsmodell Stufe 1: WER die Geräte-Konfiguration dieser Anlage
        // besitzt. Nur ein ausdrückliches "portal" macht die Box zum Ausführenden
        // - ABWESEND heißt box, damit ein älterer Cloud-Stand nie versehentlich
        // als Übernahme gelesen werden kann. Deshalb wird das Feld auch nur dann
        // gesetzt: eine box-verwaltete Anlage sendet exakt die Bytes von vorher.
        if (ComponentAuthority.isPortalManaged(componentAuthority)) {
            push.put("component_authority", ComponentAuthority.PORTAL);
        }
        // Steuerung Stufe 4 (§3.7 B5): „Automatik pausieren". Fahrplan UND Regeln
        // ruhen bis zu diesem Zeitpunkt, jede Komponente fällt auf ihren
        // Registry-Failsafe (Speicher = Eigenverbrauch, Gerät = release/off) -
        // die Zahl dafür kann nur die Box rechnen, deshalb reist hier ein ENDE
        // und kein Sollwert. Additiv und ABSOLUT: eine Box, die beim Ablauf
        // offline war, hebt die Sperre nach ihrer eigenen Uhr wieder auf, statt
        // auf eine Nachricht zu warten, die nie kommt. Ohne Pause fehlt das
        // Feld - die Nutzlast ist dann byte-gleich zu vorher.
        //
        // UEMS AP-01 IP-4 (R0): die Ruhe bis zum Start hat KEIN Ende. Sie trägt
        // zusätzlich `automation_paused_until_revoked: true` (die Box ruht bis auf
        // Widerruf) und als Ende nur das rollierende jetzt + 4 h für eine ÄLTERE
        // Box, die das neue Feld überliest; der Erneuerungs-Takt schiebt es weiter.
        // Eine Pause von Hand bleibt byte-gleich: ihr Ende, kein zweites Feld.
        overrides.activePause(siteId).ifPresent(pause -> {
            RuheRegel.PushFelder felder = RuheRegel.push(pause.endsAt(), now);
            push.put(RuheRegel.FELD_ENDE, felder.ende().toString());
            if (felder.bisAufWiderruf()) {
                push.put(RuheRegel.FELD_WIDERRUF, true);
            }
        });
        // The consumer cycle-guard limits (min-on/min-off/starts per day) live
        // in consumer_profile - the ONE profile truth - and ride the push as
        // guards.limits fields (D-9: limits live in registry config, never in
        // plans). Merged at COMPOSE time so a profile change re-pushes cleanly.
        java.util.Map<UUID, EntityRegistryRepository.ConsumerCycleLimits> cycle =
                repo.consumerCycleLimits(siteId);
        // The Inkrement-6 deadline duties (flex_requirements, D-20): composed
        // from the ACTIVE policy of every ENABLED consumer, so a policy
        // activation/deactivation/pause re-pushes cleanly too.
        java.util.Map<UUID, EntityRegistryRepository.ConsumerFlexSource> flex =
                repo.activeConsumerPolicies(siteId);
        // Steuerung Stufe 3 (§3.7 A3): WELCHE Komponenten eine aktive Kundenregel
        // beansprucht. Der Edge speist für sie KEINEN Fahrplan-Sollwert mehr ein -
        // die Regel gewinnt, weil kein Konkurrent existiert; Arbiter und D-4/D-5/D-6
        // bleiben unangetastet. Additiv wie edge_source_id (D-17) und
        // flex_requirements (D-20): ohne Beanspruchung ist die Nutzlast byte-gleich.
        java.util.Map<UUID, String> claimed = claims.claimedEntities(siteId);
        // Cockpit Phase 1 / E1: WELCHE OCPP-Ladesaeule eine Komponente IST.
        // Additiv wie edge_source_id (D-17): ohne Ladepunkt ist die Nutzlast
        // byte-gleich, und ohne dieses Feld veroeffentlicht die Box gar keine
        // Ladepunkt-Telemetrie je Entitaet.
        java.util.Map<UUID, String> chargePoints = repo.chargePointIdsByEntity(siteId);
        // Befund L4: die im Portal GESPEICHERTE Rollen-Zuordnung (AE1
        // entity_role_assignment). Bis dahin schrieb PUT …/topology-roles nur
        // die Tabelle und der Push trug sie nicht - die Box loeste IMMER ueber
        // topology.DefaultRole auf, also zeigten Portal und :8484 zwei
        // Energiefluesse, die sich widersprechen konnten. Additiv wie
        // edge_source_id (D-17) und charge_point_id (E1): ohne eine einzige
        // gespeicherte Zuordnung ist die Nutzlast byte-gleich zu vorher.
        java.util.Map<UUID, java.util.List<EntityRegistryRepository.RoleAssignment>> roles =
                repo.roleAssignments(siteId);
        ArrayNode entities = push.putArray("entities");
        for (EntityRow row : rows) {
            ObjectNode d = descriptor(row);
            EntityRegistryRepository.ConsumerCycleLimits cl = cycle.get(row.id());
            if (cl != null) {
                mergeCycleLimits(d, cl);
            }
            if (claimed.containsKey(row.id())) {
                d.put("owner_claimed", true);
            }
            String chargePointId = chargePoints.get(row.id());
            if (chargePointId != null && !chargePointId.isBlank()) {
                d.put("charge_point_id", chargePointId);
            }
            java.util.List<EntityRegistryRepository.RoleAssignment> assigned = roles.get(row.id());
            if (assigned != null && !assigned.isEmpty()) {
                ArrayNode block = mapper.createArrayNode();
                for (EntityRegistryRepository.RoleAssignment ra : assigned) {
                    if (ra.channel() == null || ra.channel().isBlank()
                            || ra.role() == null || ra.role().isBlank()) {
                        // Eine Zuordnung ohne Kanal oder ohne Rolle ist keine
                        // Aussage - der Loeschweg der Zuordnung ist das ENTFERNEN
                        // der Zeile, nie eine leere Rolle.
                        continue;
                    }
                    ObjectNode one = mapper.createObjectNode();
                    one.put("channel", ra.channel());
                    one.put("role", ra.role());
                    if (ra.primary()) {
                        // ABSENT = false (Vertrag): nur eine ausdrueckliche
                        // massgebliche Messung reist, damit ein Push ohne sie
                        // die Vorgabe-Regel der Box unangetastet laesst.
                        one.put("primary", true);
                    }
                    block.add(one);
                }
                if (!block.isEmpty()) {
                    d.set("role_assignment", block);
                }
            }
            EntityRegistryRepository.ConsumerFlexSource fs = flex.get(row.id());
            if (fs != null) {
                ArrayNode reqs = flexRequirementsFor(parseOr(fs.documentJson(), null),
                        fs.ratedPowerKw(), mapper);
                if (reqs != null) {
                    d.set("flex_requirements", reqs);
                }
            }
            entities.add(d);
        }
        try {
            return mapper.writeValueAsBytes(push);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialize v2 entity registry push", e);
        }
    }

    /**
     * The registry-push {@code flex_requirements} block of ONE consumer
     * (Verbrauchssteuerung Inkrement 6, D-20; edge-entity.schema.json
     * $defs/flex_requirement): the ACTIVE policy's required_by_deadline
     * flexible tasks, with the run power and the D-14 command RESOLVED here -
     * the cloud is the one truth for policy semantics, the edge fallback never
     * re-derives targets. Rules, each refusing the ENTRY (never guessing):
     * only {@code kind=flexible_task} + {@code enforcement=required_by_deadline}
     * + active; a complete recurrence (days/from/to) and a demand
     * (runtime_minutes and/or energy_kwh); a resolvable positive power -
     * {@code on_off}/{@code percent} targets need the profile's rated power,
     * a {@code kw} target carries its own; {@code mode} targets and off
     * targets are never pushed (not power-quantifiable). Returns null when
     * nothing qualifies (the block is then absent - byte-identical push).
     */
    static ArrayNode flexRequirementsFor(JsonNode document, BigDecimal ratedPowerKw,
            ObjectMapper mapper) {
        if (document == null || !document.isObject()) {
            return null;
        }
        JsonNode reqs = document.path("requirements");
        if (!reqs.isArray()) {
            return null;
        }
        String timezone = document.path("timezone").asText("");
        ArrayNode out = mapper.createArrayNode();
        for (JsonNode req : reqs) {
            if (!"flexible_task".equals(req.path("kind").asText())
                    || !"required_by_deadline".equals(req.path("enforcement").asText())) {
                continue;
            }
            if (req.has("active") && !req.path("active").asBoolean(true)) {
                continue;
            }
            String id = req.path("id").asText("");
            JsonNode rec = req.path("recurrence");
            String days = rec.path("days").asText("");
            String from = rec.path("from").asText("");
            String to = rec.path("to").asText("");
            if (id.isBlank() || days.isBlank() || from.isBlank() || to.isBlank()) {
                continue;
            }
            JsonNode demand = req.path("demand");
            JsonNode runtime = demand.path("runtime_minutes");
            JsonNode energy = demand.path("energy_kwh");
            boolean hasRuntime = runtime.isNumber() && runtime.asDouble() > 0;
            boolean hasEnergy = energy.isNumber() && energy.asDouble() > 0;
            if (!hasRuntime && !hasEnergy) {
                continue;
            }
            JsonNode target = req.path("target");
            String targetKind = target.path("kind").asText("");
            double powerKw;
            String command;
            switch (targetKind) {
                case "on_off" -> {
                    if (!target.path("value").asBoolean(false) || ratedPowerKw == null) {
                        continue; // an OFF target / no rated power: not pushable
                    }
                    powerKw = ratedPowerKw.doubleValue();
                    command = "on_off";
                }
                case "percent" -> {
                    if (ratedPowerKw == null) {
                        continue;
                    }
                    powerKw = ratedPowerKw.doubleValue() * target.path("value").asDouble(0) / 100.0;
                    command = "setpoint_kw";
                }
                case "kw" -> {
                    powerKw = target.path("value").asDouble(0);
                    command = "setpoint_kw";
                }
                default -> {
                    continue; // mode targets are not power-quantifiable
                }
            }
            if (!(powerKw > 0)) {
                continue;
            }
            ObjectNode entry = mapper.createObjectNode();
            entry.put("id", id);
            if (!timezone.isBlank()) {
                entry.put("timezone", timezone);
            }
            entry.put("days", days);
            entry.put("from", from);
            entry.put("to", to);
            if (hasRuntime) {
                entry.put("runtime_minutes", runtime.asInt());
            }
            if (hasEnergy) {
                entry.put("energy_kwh", energy.asDouble());
            }
            if (demand.has("contiguous")) {
                entry.put("contiguous", demand.path("contiguous").asBoolean(true));
            }
            entry.put("power_kw", Math.round(powerKw * 1000.0) / 1000.0);
            entry.put("command", command);
            out.add(entry);
        }
        return out.isEmpty() ? null : out;
    }

    private static void mergeCycleLimits(ObjectNode descriptor,
            EntityRegistryRepository.ConsumerCycleLimits cl) {
        JsonNode g = descriptor.get("guards");
        ObjectNode guards = g instanceof ObjectNode on ? on : descriptor.putObject("guards");
        JsonNode l = guards.get("limits");
        ObjectNode limits = l instanceof ObjectNode on2 ? on2 : guards.putObject("limits");
        if (cl.minOnSeconds() != null) {
            limits.put("min_on_seconds", cl.minOnSeconds());
        }
        if (cl.minOffSeconds() != null) {
            limits.put("min_off_seconds", cl.minOffSeconds());
        }
        if (cl.maxStartsPerDay() != null) {
            limits.put("max_starts_per_day", cl.maxStartsPerDay());
        }
    }

    /** One stored row as its contract descriptor ($defs/descriptor). */
    ObjectNode descriptor(EntityRow row) {
        ObjectNode d = mapper.createObjectNode();
        d.put("entity_id", row.id().toString());
        d.put("entity_type", row.entityType());
        if (row.label() != null && !row.label().isBlank()) {
            d.put("label", row.label());
        }
        // The adoption pin, echoed to the device (D-17, additive): lets the
        // edge map its OWN source readings onto the entity for its LOCAL
        // display - deterministic instead of order-guessing. Old edges ignore it.
        if (row.edgeSourceId() != null && !row.edgeSourceId().isBlank()) {
            d.put("edge_source_id", row.edgeSourceId());
        }
        d.set("capabilities", parseOr(row.capabilitiesJson(), mapper.createObjectNode()));
        d.set("guards", parseOr(row.guardConfigJson(), mapper.createObjectNode()));
        ObjectNode driver = driverBlock(row);
        if (driver != null) {
            d.set("driver", driver);
        }
        return d;
    }

    /**
     * Optional opaque Layer-1 self-wiring block (the v1 sources busEntry shape).
     * Only composed when the row actually carries transport data - the v1
     * customer source paths record brand/model only, so this is usually absent
     * in E1a (the edge-side sources.json holds the connection; syncing it up is
     * deferred work).
     *
     * <p><b>Einheitsmodell Stufe 2 completed the field set.</b> Until then the
     * block named the transport but dropped the source MASTER DATA - the read
     * cadence, the nameplate kWp and the operator's MaStR reference - so the
     * applier fell back to its defaults: a component saved with a 30 s interval
     * was polled every 5 s, and a producer's kWp never widened the box's
     * physical plausibility envelope. That was a silent downgrade even before
     * this stage; a takeover of a live plant would have made it a REGRESSION of
     * a running configuration, which is why the fidelity is fixed here and
     * proven field by field.
     *
     * <p><b>The role is deliberately NOT emitted.</b> The applier derives it
     * from the entity TYPE, and that derivation is the tested path; sending the
     * v1 {@code measurement_point.role} vocabulary instead would hand the box a
     * word its {@code roleFor} does not accept ({@code battery-hybrid} vs
     * {@code inverter}) and refuse the whole plan.
     */
    private ObjectNode driverBlock(EntityRow row) {
        if (row.communication() == null || row.communication().isBlank()) {
            return null;
        }
        ObjectNode driver = mapper.createObjectNode();
        driver.put("communication", row.communication());
        if (row.brand() != null) {
            driver.put("brand", row.brand());
        }
        if (row.model() != null) {
            driver.put("model", row.model());
        }
        if (row.family() != null) {
            driver.put("family", row.family());
        }
        if (row.capacityKwp() != null) {
            driver.put("capacity_kwp", row.capacityKwp().doubleValue());
        }
        if (row.registryUnitId() != null && !row.registryUnitId().isBlank()) {
            driver.put("registry_unit_id", row.registryUnitId());
        }
        JsonNode conn = parseOr(row.connectionJson(), null);
        if (conn != null && conn.isObject()) {
            // Die Lese-Kadenz wohnt seit Stufe 1 IM connection_json (der
            // Anlege-Weg legt sie dort ab). Sie gehört aber auf die
            // Treiber-Ebene, weil die Box sie dort liest - hier wird sie
            // gehoben, statt den Schreibpfad der Stufe 1 umzubauen. Die Kopie
            // in der Verbindung bleibt harmlos liegen: die Box ignoriert
            // unbekannte Verbindungsfelder.
            JsonNode interval = conn.get("interval_s");
            if (interval != null && interval.isNumber()) {
                driver.put("interval_s", interval.asInt());
            }
            driver.set("connection", conn);
        }
        return driver;
    }

    private ObjectNode batteryCapabilities(BatteryAsset battery) {
        ObjectNode caps = mapper.createObjectNode();
        ArrayNode measure = caps.putArray("measure");
        measure.add(measureCap("soc_pct", "%"));
        measure.add(measureCap("battery_power_kw", "kW"));
        measure.add(measureCap("pv_power_kw", "kW"));
        ArrayNode actuate = caps.putArray("actuate");
        ObjectNode setpoint = mapper.createObjectNode();
        setpoint.put("command", "setpoint_kw");
        if (battery.maxDischargeKw() != null) {
            setpoint.put("min", battery.maxDischargeKw().negate().doubleValue());
        }
        if (battery.maxChargeKw() != null) {
            setpoint.put("max", battery.maxChargeKw().doubleValue());
        }
        actuate.add(setpoint);
        ObjectNode limit = mapper.createObjectNode();
        limit.put("command", "limit_kw");
        actuate.add(limit);
        return caps;
    }

    private ObjectNode batteryGuards(BatteryAsset battery, boolean netzladenErlaubt) {
        ObjectNode guards = mapper.createObjectNode();
        ObjectNode limits = guards.putObject("limits");
        if (battery.maxChargeKw() != null) {
            limits.put("max_charge_kw", battery.maxChargeKw().doubleValue());
        }
        if (battery.maxDischargeKw() != null) {
            limits.put("max_discharge_kw", battery.maxDischargeKw().doubleValue());
        }
        limits.put("soc_min_pct", numberOr(battery.socMinPct(), DEFAULT_SOC_MIN_PCT));
        limits.put("soc_max_pct", numberOr(battery.socMaxPct(), DEFAULT_SOC_MAX_PCT));
        limits.put("charge_from_grid_allowed", netzladenErlaubt);
        guards.putObject("failsafe").put("behavior", "self-consumption");
        return guards;
    }

    private ObjectNode producerCapabilities(EntityRow point) {
        ObjectNode caps = mapper.createObjectNode();
        caps.putArray("measure").add(measureCap("pv_power_kw", "kW"));
        ArrayNode actuate = caps.putArray("actuate");
        ObjectNode limitKw = mapper.createObjectNode();
        limitKw.put("command", "limit_kw");
        if (point.capacityKwp() != null) {
            limitKw.put("max", point.capacityKwp().doubleValue());
        }
        actuate.add(limitKw);
        ObjectNode limitPct = mapper.createObjectNode();
        limitPct.put("command", "limit_pct");
        actuate.add(limitPct);
        return caps;
    }

    private ObjectNode producerGuards(EntityRow point) {
        ObjectNode guards = mapper.createObjectNode();
        if (point.capacityKwp() != null) {
            guards.putObject("limits").put("max_generation_kw", point.capacityKwp().doubleValue());
        }
        // A producer is never commanded to produce; on staleness its limits are
        // simply cleared (the 1.0 pv_limit_kw clearing rule).
        guards.putObject("failsafe").put("behavior", "release");
        return guards;
    }

    private ObjectNode gridMeterCapabilities() {
        ObjectNode caps = mapper.createObjectNode();
        caps.putArray("measure").add(measureCap("power_kw", "kW"));
        return caps;
    }

    private ObjectNode gridMeterGuards() {
        ObjectNode guards = mapper.createObjectNode();
        guards.putObject("failsafe").put("behavior", "measure-only");
        return guards;
    }

    /**
     * The Hausverbrauch entity: the site's {@code load_kw} channel, measure-only.
     * Its catalog type is {@code controllable: false} on purpose - typing it as
     * {@code generic-load} would light up {@code hasControllableConsumer} and
     * offer device-automation affordances on a house nobody can switch.
     */
    private ObjectNode houseLoadCapabilities() {
        ObjectNode caps = mapper.createObjectNode();
        caps.putArray("measure").add(measureCap("power_kw", "kW"));
        return caps;
    }

    private ObjectNode houseLoadGuards() {
        ObjectNode guards = mapper.createObjectNode();
        guards.putObject("failsafe").put("behavior", "measure-only");
        return guards;
    }

    private ObjectNode measureCap(String channel, String unit) {
        ObjectNode cap = mapper.createObjectNode();
        cap.put("channel", channel);
        cap.put("unit", unit);
        return cap;
    }

    private static double numberOr(BigDecimal value, double fallback) {
        return value != null ? value.doubleValue() : fallback;
    }

    private JsonNode parseOr(String json, JsonNode fallback) {
        if (json == null || json.isBlank()) {
            return fallback;
        }
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            log.warn("stored entity JSON unreadable, using fallback: {}", e.getMessage());
            return fallback;
        }
    }

    private String write(ObjectNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialize entity config", e);
        }
    }

    /**
     * Ist diese Komponente eine gemeldete OCPP-Saeule (P5)?
     *
     * <p>Das ist IHRE Form von „verbunden": ein Ladepunkt hat weder eine
     * Edge-Quelle noch ein eigenes Geraet - er WAEHLT die Box selbst an, und
     * die Bindung {@code device_charge_point.entity_id} ist genau die, die
     * diese Komponente ueberhaupt hat entstehen lassen. Ohne diese Auskunft
     * koennte an einer Saeule nie eine Regel aktiviert werden.
     */
    public boolean istGebundenerLadepunkt(UUID siteId, UUID entityId) {
        return repo.chargePointIdsByEntity(siteId).containsKey(entityId);
    }
}
