package com.voltpilot.api.entities;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.tenant.TenantContext;
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
     * The synthesized measurement points' labels - honest about WHERE the
     * measurement comes from (the gateway inverter's own channel, not a
     * separate meter). When the customer later adopts a real grid meter, the
     * {@link #adopt} path relabels that very row.
     */
    static final String LABEL_SYNTHESIZED_GRID = "Netzanschluss (Messung über Wechselrichter)";
    static final String LABEL_SYNTHESIZED_HOUSE = "Hausverbrauch (Messung über Wechselrichter)";

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
            EntityTypeCatalog catalog, AssetRepository assets) {
        this(repo, publisher, mapper, catalog, assets, Clock.systemUTC());
    }

    EntityRegistryService(EntityRegistryRepository repo,
            ObjectProvider<EntityRegistryPublisher> publisher, ObjectMapper mapper,
            EntityTypeCatalog catalog, AssetRepository assets, Clock clock) {
        this.repo = repo;
        this.publisher = publisher;
        this.mapper = mapper;
        this.catalog = catalog;
        this.assets = assets;
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
        if (battery != null) {
            UUID pointId = repo.batteryHybridPointId(siteId);
            if (pointId == null) {
                pointId = repo.createBatteryHybridPoint(tenantId, siteId,
                        "Batteriespeicher (Hybrid-Wechselrichter)", gatewayDevice(siteId, battery));
            }
            repo.setEntityConfig(pointId, TYPE_BATTERY_HYBRID,
                    write(batteryCapabilities(battery)),
                    write(batteryGuards(battery, repo.netzladenErlaubt(siteId))));
        } else {
            skipped.add("battery-hybrid: no battery asset on this site");
        }

        synthesizeGatewayPoints(tenantId, siteId, gatewayDevice(siteId, battery), skipped);

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
        ensureComposedPoint(tenantId, siteId, ROLE_GRID_METER, LABEL_SYNTHESIZED_GRID, gateway);
        ensureComposedPoint(tenantId, siteId, ROLE_HOUSE_LOAD, LABEL_SYNTHESIZED_HOUSE, gateway);
    }

    /** Create the measure-only point for a role once; an existing one wins. */
    private void ensureComposedPoint(UUID tenantId, UUID siteId, String role, String label,
            UUID gateway) {
        if (repo.pointIdByRole(siteId, role) != null) {
            return;
        }
        repo.createComposedPoint(tenantId, siteId, role, label, gateway);
    }

    /** What the automatic backfill did with one site (MIG §6). */
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
     * The guarded unit of the automatic migration: compose this site's pilot
     * entities unless it is already on v2 or has no gateway. Runs under the
     * caller-established {@link TenantContext} through the RLS-scoped
     * repository, exactly like the admin bootstrap endpoint - ONE composition
     * truth, no SQL twin.
     */
    @Transactional
    public BackfillOutcome bootstrapIfEligible(UUID siteId) {
        if (repo.hasEntities(siteId)) {
            return BackfillOutcome.ALREADY_V2;
        }
        if (gatewayDevice(siteId, repo.batteryAsset(siteId)) == null) {
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

        BatteryAsset battery = repo.batteryAsset(siteId);
        if (battery != null) {
            UUID pointId = repo.batteryHybridPointId(siteId);
            ObjectNode caps = batteryCapabilities(battery);
            ObjectNode guards = batteryGuards(battery, repo.netzladenErlaubt(siteId));
            plan.add(new PlannedEntity(pointId, pointId != null ? "refresh" : "create",
                    TYPE_BATTERY_HYBRID, "Batteriespeicher (Hybrid-Wechselrichter)",
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

        UUID gateway = gatewayDevice(siteId, battery);
        // The synthesized gateway points (MIG §2.3/§2.4) - LOCKSTEP with
        // synthesizeGatewayPoints() in bootstrap(), or the preview lies about
        // what the conversion will do.
        if (gateway == null) {
            skipped.add("grid-meter/house-load: no unambiguous gateway device to measure through");
        } else {
            if (!hasGridPoint) {
                ObjectNode caps = gridMeterCapabilities();
                plan.add(new PlannedEntity(null, "create", TYPE_GRID_METER, LABEL_SYNTHESIZED_GRID,
                        rolesFor(TYPE_GRID_METER, caps), caps, gridMeterGuards()));
            }
            if (!hasHousePoint) {
                ObjectNode caps = houseLoadCapabilities();
                plan.add(new PlannedEntity(null, "create", TYPE_HOUSE_LOAD, LABEL_SYNTHESIZED_HOUSE,
                        rolesFor(TYPE_HOUSE_LOAD, caps), caps, houseLoadGuards()));
            }
        }
        return new ConversionPreview(repo.hasEntities(siteId), gateway,
                gateway == null ? gatewayReason(siteId, battery) : null, plan, skipped);
    }

    /**
     * The default topology roles a would-be entity's measure channels resolve
     * to, in canonical order (pv, storage, consumer, grid) - exactly what the
     * AE1 read-model {@link com.voltpilot.api.topology.TopologyDeriver} derives,
     * so the preview and the live topology never disagree.
     */
    private List<String> rolesFor(String entityType, ObjectNode capabilities) {
        EntityTypeCatalog.EntityType type = catalog.find(entityType);
        String category = type == null ? "" : type.category();
        java.util.LinkedHashSet<String> found = new java.util.LinkedHashSet<>();
        for (JsonNode m : capabilities.path("measure")) {
            String channel = m.path("channel").asText(null);
            String role = com.voltpilot.api.topology.TopologyDeriver.defaultRole(category, channel);
            if (role != null && !role.isEmpty()) {
                found.add(role);
            }
        }
        List<String> canonical = List.of(
                com.voltpilot.api.topology.TopologyDeriver.ROLE_PV,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_STORAGE,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_CONSUMER,
                com.voltpilot.api.topology.TopologyDeriver.ROLE_GRID);
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

    /** Why no unambiguous gateway device could be resolved (for the preview). */
    private String gatewayReason(UUID siteId, BatteryAsset battery) {
        int devices = repo.siteDeviceIds(siteId).size();
        if (devices == 0) {
            return "no_claimed_device";
        }
        if (battery == null || battery.deviceId() == null) {
            return "multiple_devices_no_battery_link";
        }
        return "no_gateway_device";
    }

    /**
     * Compose the current registry push payload and publish it retained to the
     * site's gateway device. Never throws; a missing publisher/gateway or a
     * broker failure is reported in the outcome only.
     */
    public PushOutcome pushRegistryBestEffort(UUID siteId) {
        UUID tenantId = TenantContext.get();
        UUID gateway = gatewayDevice(siteId, repo.batteryAsset(siteId));
        if (gateway == null) {
            log.warn("v2 entity registry for site {} not pushed: no unambiguous gateway device",
                    siteId);
            return PushOutcome.noGateway();
        }
        // The composed revision is the Soll the edge is expected to echo in
        // its heartbeat (E1b bidirectional sync) - recorded even when the
        // best-effort publish fails or MQTT is not configured (the Soll
        // changed regardless; retained delivery converges later).
        Instant now = clock.instant();
        byte[] payload = composePush(tenantId, siteId, gateway, now, repo.entitiesForSite(siteId));
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
                    capacity, null, false, null, null, null, edgeSourceId);
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
     * The device carrying the site's v2 subtree: the battery's controlling
     * device when linked, else the site's SINGLE claimed device - never a guess
     * between several (the autoLinkBatteryDevice rule).
     */
    private UUID gatewayDevice(UUID siteId, BatteryAsset battery) {
        if (battery != null && battery.deviceId() != null) {
            return battery.deviceId();
        }
        List<UUID> devices = repo.siteDeviceIds(siteId);
        return devices.size() == 1 ? devices.get(0) : null;
    }

    /** The registry_push payload (edge-entity.schema.json $defs/registry_push). */
    byte[] composePush(UUID tenantId, UUID siteId, UUID deviceId, Instant now,
            List<EntityRow> rows) {
        ObjectNode push = mapper.createObjectNode();
        push.put("schema_version", "1.0");
        push.put("tenant_id", tenantId.toString());
        push.put("site_id", siteId.toString());
        push.put("device_id", deviceId.toString());
        push.put("revision", now.toString());
        push.put("published_at", now.toString());
        // The consumer cycle-guard limits (min-on/min-off/starts per day) live
        // in consumer_profile - the ONE profile truth - and ride the push as
        // guards.limits fields (D-9: limits live in registry config, never in
        // plans). Merged at COMPOSE time so a profile change re-pushes cleanly.
        java.util.Map<UUID, EntityRegistryRepository.ConsumerCycleLimits> cycle =
                repo.consumerCycleLimits(siteId);
        ArrayNode entities = push.putArray("entities");
        for (EntityRow row : rows) {
            ObjectNode d = descriptor(row);
            EntityRegistryRepository.ConsumerCycleLimits cl = cycle.get(row.id());
            if (cl != null) {
                mergeCycleLimits(d, cl);
            }
            entities.add(d);
        }
        try {
            return mapper.writeValueAsBytes(push);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialize v2 entity registry push", e);
        }
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
        JsonNode conn = parseOr(row.connectionJson(), null);
        if (conn != null && conn.isObject()) {
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
}
