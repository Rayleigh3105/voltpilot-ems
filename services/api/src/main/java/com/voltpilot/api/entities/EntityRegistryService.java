package com.voltpilot.api.entities;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository.BatteryAsset;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

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
    private final Clock clock;

    /**
     * The @Autowired is LOAD-BEARING (the BrokerAuthzReloader two-constructor
     * footgun): with the package-private test-seam constructor below and no
     * annotation, Spring cannot pick an injection constructor and crash-loops
     * with "No default constructor found".
     */
    @org.springframework.beans.factory.annotation.Autowired
    public EntityRegistryService(EntityRegistryRepository repo,
            ObjectProvider<EntityRegistryPublisher> publisher, ObjectMapper mapper) {
        this(repo, publisher, mapper, Clock.systemUTC());
    }

    EntityRegistryService(EntityRegistryRepository repo,
            ObjectProvider<EntityRegistryPublisher> publisher, ObjectMapper mapper, Clock clock) {
        this.repo = repo;
        this.publisher = publisher;
        this.mapper = mapper;
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

        for (EntityRow point : repo.pointsForSite(siteId)) {
            switch (point.role()) {
                case "pv-generation" -> repo.setEntityConfig(point.id(), TYPE_PRODUCER,
                        write(producerCapabilities(point)), write(producerGuards(point)));
                case "grid-meter" -> repo.setEntityConfig(point.id(), TYPE_GRID_METER,
                        write(gridMeterCapabilities()), write(gridMeterGuards()));
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
     * Compose the current registry push payload and publish it retained to the
     * site's gateway device. Never throws; a missing publisher/gateway or a
     * broker failure is reported in the outcome only.
     */
    public PushOutcome pushRegistryBestEffort(UUID siteId) {
        EntityRegistryPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            return PushOutcome.notConfigured();
        }
        UUID tenantId = TenantContext.get();
        UUID gateway = gatewayDevice(siteId, repo.batteryAsset(siteId));
        if (gateway == null) {
            log.warn("v2 entity registry for site {} not pushed: no unambiguous gateway device",
                    siteId);
            return PushOutcome.noGateway();
        }
        byte[] payload = composePush(tenantId, siteId, gateway, repo.entitiesForSite(siteId));
        return PushOutcome.result(pub.publishRegistry(tenantId, siteId, gateway, payload), gateway);
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
    byte[] composePush(UUID tenantId, UUID siteId, UUID deviceId, List<EntityRow> rows) {
        Instant now = clock.instant();
        ObjectNode push = mapper.createObjectNode();
        push.put("schema_version", "1.0");
        push.put("tenant_id", tenantId.toString());
        push.put("site_id", siteId.toString());
        push.put("device_id", deviceId.toString());
        push.put("revision", now.toString());
        push.put("published_at", now.toString());
        ArrayNode entities = push.putArray("entities");
        for (EntityRow row : rows) {
            entities.add(descriptor(row));
        }
        try {
            return mapper.writeValueAsBytes(push);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("cannot serialize v2 entity registry push", e);
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
