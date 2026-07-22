package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * MIG-B1 — the v1 → v2 VALUE bridge: for a site whose v2 entities were COMPOSED
 * from its v1 master data, each v1 telemetry sample is additionally written as
 * per-entity {@code telemetry_v2} rows.
 *
 * <p><b>Why this exists.</b> The portal's v2 read-model
 * ({@code TopologyRepository.latestValues}) reads {@code telemetry_v2} ONLY, and
 * that table is fed exclusively by an edge publishing {@code
 * edge/entities/{id}/telemetry}. No shipped self-wiring flow does that yet, so a
 * correctly migrated site would render four nodes and four dashes. This bridge
 * makes the composed entities carry REAL values the same second the migration
 * runs — using the site's own v1 sample, nothing invented.
 *
 * <p><b>The channel map</b> (the v1 tiles reproduce to the digit):
 * <table><caption>composed entity → channel</caption>
 *   <tr><td>battery-hybrid</td><td>{@code soc_pct} ← {@code soc_pct}</td></tr>
 *   <tr><td>battery-hybrid</td><td>{@code pv_power_kw} ← {@code pv_power_kw}</td></tr>
 *   <tr><td>battery-hybrid</td><td>{@code battery_power_kw} ←
 *       {@code power_kw − load_kw + pv_power_kw} (the documented v1 balance)</td></tr>
 *   <tr><td>grid-meter</td><td>{@code power_kw} ← {@code power_kw} (signed,
 *       +import/−export — unchanged)</td></tr>
 *   <tr><td>house-load</td><td>{@code power_kw} ← {@code load_kw}</td></tr>
 * </table>
 *
 * <p><b>A NULL v1 channel writes NO row</b> — never a fabricated 0 (the project's
 * standing discipline); the derived battery power needs all three of its inputs.
 *
 * <p><b>Scope + sunset.</b> Only entities whose {@code device_id} is the sample's
 * device are fed (a second device's samples never feed the gateway's entities),
 * and only the three COMPOSED types — a v2-native wallbox/Modbus entity is never
 * synthesized from a site-level v1 sample. The insert is the same guarded
 * per-(entity, channel, time) insert the real v2 path uses, so once a device
 * publishes its own entity telemetry the bridge simply no-ops on those rows.
 *
 * <p>The registry is cached per site for {@code voltpilot.entities.fanout.cache-ttl}
 * (default 60 s), so a registry change (bootstrap, adoption, delete) is picked up
 * within one TTL without any cross-service signal.
 */
@Component
public class ComposedEntityFanout {

    private static final Logger log = LoggerFactory.getLogger(ComposedEntityFanout.class);

    static final String TYPE_BATTERY_HYBRID = "battery-hybrid";
    static final String TYPE_GRID_METER = "grid-meter";
    static final String TYPE_HOUSE_LOAD = "house-load";

    /** One composed entity of a site, as the registry describes it. */
    record ComposedEntity(UUID id, String entityType, UUID deviceId) {}

    private record CacheEntry(List<ComposedEntity> entities, Instant loadedAt) {}

    private final JdbcTemplate jdbc;
    private final TelemetryV2WriteRepository v2;
    private final TransactionTemplate transactions;
    private final boolean enabled;
    private final Duration cacheTtl;
    private final java.time.Clock clock;
    private final Map<UUID, CacheEntry> cache = new ConcurrentHashMap<>();

    /**
     * The {@code @Autowired} is LOAD-BEARING (the BrokerAuthzReloader footgun):
     * with the package-private test-seam constructor below and no annotation,
     * Spring cannot pick an injection constructor and the whole writer context
     * fails with "No default constructor found".
     */
    @org.springframework.beans.factory.annotation.Autowired
    public ComposedEntityFanout(JdbcTemplate jdbc, TelemetryV2WriteRepository v2,
            PlatformTransactionManager transactionManager,
            @Value("${voltpilot.entities.fanout.enabled:true}") boolean enabled,
            @Value("${voltpilot.entities.fanout.cache-ttl:60s}") Duration cacheTtl) {
        this(jdbc, v2, new TransactionTemplate(transactionManager), enabled, cacheTtl,
                java.time.Clock.systemUTC());
    }

    ComposedEntityFanout(JdbcTemplate jdbc, TelemetryV2WriteRepository v2,
            TransactionTemplate transactions, boolean enabled, Duration cacheTtl,
            java.time.Clock clock) {
        this.jdbc = jdbc;
        this.v2 = v2;
        this.transactions = transactions;
        this.enabled = enabled;
        this.cacheTtl = cacheTtl;
        this.clock = clock;
    }

    /**
     * Fan one v1 event out onto the site's composed entities. Returns how many
     * v2 rows landed (0 when the site has none, which is every un-migrated site).
     */
    public int fanOut(TelemetryRawEvent event) {
        if (!enabled) {
            return 0;
        }
        List<ComposedEntity> entities = composedEntities(event.tenant_id(), event.site_id());
        if (entities.isEmpty()) {
            return 0;
        }
        List<TelemetryV2WriteRepository.ChannelRow> rows =
                channelRows(entities, event.device_id(), event.measurements());
        if (rows.isEmpty()) {
            return 0;
        }
        Instant receivedAt =
                event.ingested_at() != null ? event.ingested_at() : event.observed_at();
        return v2.insertChannels(event.tenant_id(), event.site_id(), event.device_id(), rows,
                event.observed_at(), receivedAt);
    }

    /** The composed rows of one sample — the channel map, pure. */
    static List<TelemetryV2WriteRepository.ChannelRow> channelRows(List<ComposedEntity> entities,
            UUID deviceId, JsonNode measurements) {
        Double power = number(measurements, "power_kw");
        Double load = number(measurements, "load_kw");
        Double pv = number(measurements, "pv_power_kw");
        Double soc = number(measurements, "soc_pct");
        // The documented v1 balance derivation; an absent input means the
        // battery power is UNKNOWN, so no row (never a fabricated 0).
        Double battery = (power == null || load == null || pv == null) ? null
                : power - load + pv;

        List<TelemetryV2WriteRepository.ChannelRow> rows = new ArrayList<>();
        for (ComposedEntity e : entities) {
            if (e.deviceId() != null && !e.deviceId().equals(deviceId)) {
                continue;
            }
            switch (e.entityType()) {
                case TYPE_BATTERY_HYBRID -> {
                    add(rows, e, "soc_pct", soc);
                    add(rows, e, "pv_power_kw", pv);
                    add(rows, e, "battery_power_kw", battery);
                }
                case TYPE_GRID_METER -> add(rows, e, "power_kw", power);
                case TYPE_HOUSE_LOAD -> add(rows, e, "power_kw", load);
                default -> {
                    // producer / v2-native types are fed by their own source.
                }
            }
        }
        return rows;
    }

    private static void add(List<TelemetryV2WriteRepository.ChannelRow> rows, ComposedEntity e,
            String channel, Double value) {
        if (value != null && Double.isFinite(value)) {
            rows.add(new TelemetryV2WriteRepository.ChannelRow(e.id().toString(), channel, value));
        }
    }

    private static Double number(JsonNode measurements, String field) {
        if (measurements == null) {
            return null;
        }
        JsonNode v = measurements.get(field);
        return v == null || v.isNull() || !v.isNumber() ? null : v.asDouble();
    }

    /** The site's composed entities, cached per site for the configured TTL. */
    List<ComposedEntity> composedEntities(UUID tenantId, UUID siteId) {
        CacheEntry cached = cache.get(siteId);
        Instant now = clock.instant();
        if (cached != null && Duration.between(cached.loadedAt(), now).compareTo(cacheTtl) < 0) {
            return cached.entities();
        }
        List<ComposedEntity> loaded;
        try {
            loaded = load(tenantId, siteId);
        } catch (RuntimeException e) {
            // The bridge is a display convenience; it must never wedge the
            // core v1 pipe. Serve the last known set (or nothing) and retry.
            log.warn("composed-entity lookup for site {} failed, no v2 fan-out this sample: {}",
                    siteId, e.toString());
            return cached != null ? cached.entities() : List.of();
        }
        cache.put(siteId, new CacheEntry(loaded, now));
        return loaded;
    }

    private List<ComposedEntity> load(UUID tenantId, UUID siteId) {
        // RLS-scoped exactly like the writes: bind the event's tenant, then read
        // without a tenant predicate (the policy is the fence). BOTH statements
        // must share ONE transaction - set_config(..., true) is transaction-local,
        // so a second implicit transaction would read with no tenant = zero rows.
        return transactions.execute(status -> {
            jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class,
                    tenantId.toString());
            return jdbc.query(
                    "SELECT id, entity_type, device_id FROM measurement_point "
                            + "WHERE site_id = ? AND entity_type IN (?, ?, ?) "
                            + "ORDER BY created_at, id",
                    (ResultSet rs, int n) -> mapEntity(rs), siteId,
                    TYPE_BATTERY_HYBRID, TYPE_GRID_METER, TYPE_HOUSE_LOAD);
        });
    }

    private static ComposedEntity mapEntity(ResultSet rs) throws SQLException {
        return new ComposedEntity(rs.getObject("id", UUID.class), rs.getString("entity_type"),
                rs.getObject("device_id", UUID.class));
    }
}
