package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Iterator;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Explodes one {@code telemetry-v2.raw} event into generic
 * {@code (entity_id, channel, value)} rows of the {@code telemetry_v2}
 * hypertable (api migration V20260718010000). The v1 {@link
 * TelemetryWriteRepository} is untouched.
 *
 * <p>Conventions carried over from v1 verbatim:
 * <ul>
 *   <li>RLS: the transaction runs {@code set_config('app.tenant_id', ...)}
 *       before inserting - the policy's WITH CHECK guarantees the rows land in
 *       the event's tenant, whatever the payload claims.</li>
 *   <li>{@code time} = OBSERVATION (per-entity ts overriding the event's
 *       observed_at), {@code received_at} = ARRIVAL (ingested_at) - liveness
 *       must derive from received_at (store-and-forward replay).</li>
 *   <li>Idempotency: guarded insert per (entity_id, channel, time); Kafka
 *       redelivery and edge replay are no-ops.</li>
 *   <li>Purge watermark: the device row is share-locked and rows at/before
 *       {@code device.data_purged_before} are refused, so a replaying edge can
 *       never resurrect purged history (the v1 rule applied to v2 rows).</li>
 * </ul>
 */
@Repository
public class TelemetryV2WriteRepository {

    private static final Logger log = LoggerFactory.getLogger(TelemetryV2WriteRepository.class);

    private final JdbcTemplate jdbc;

    public TelemetryV2WriteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Inserts the event's channel rows; returns how many landed. */
    @Transactional
    public int insert(TelemetryV2RawEvent event) {
        jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class,
                event.tenant_id().toString());

        Instant receivedAt = event.ingested_at() != null ? event.ingested_at()
                : event.observed_at();

        // Share-lock the device row so a concurrent purge waits for this
        // transaction (the v1 rule; the v2 purge integration itself is later
        // work, but replayed pre-watermark samples must already be refused).
        jdbc.queryForList("SELECT data_purged_before FROM device WHERE id = ? FOR SHARE",
                event.device_id());

        int rows = 0;
        for (Iterator<Map.Entry<String, JsonNode>> entities = event.entities().fields();
                entities.hasNext();) {
            Map.Entry<String, JsonNode> entity = entities.next();
            JsonNode channels = entity.getValue().get("channels");
            if (channels == null || !channels.isObject()) {
                continue;
            }
            Instant observedAt = entityObservedAt(entity.getValue(), event.observed_at());
            for (Iterator<Map.Entry<String, JsonNode>> it = channels.fields(); it.hasNext();) {
                Map.Entry<String, JsonNode> channel = it.next();
                if (!channel.getValue().isNumber()
                        || !Double.isFinite(channel.getValue().asDouble())) {
                    continue;
                }
                rows += insertRow(event, entity.getKey(), channel.getKey(),
                        channel.getValue().asDouble(), observedAt, receivedAt);
            }
        }
        return rows;
    }

    private int insertRow(TelemetryV2RawEvent event, String entityId, String channel,
            double value, Instant observedAt, Instant receivedAt) {
        return jdbc.update("""
                INSERT INTO telemetry_v2
                    (time, received_at, tenant_id, site_id, device_id, entity_id, channel, value)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?
                WHERE NOT EXISTS (
                    SELECT 1 FROM telemetry_v2 WHERE entity_id = ? AND channel = ? AND time = ?)
                AND NOT EXISTS (
                    SELECT 1 FROM device WHERE id = ? AND data_purged_before >= ?)
                """,
                Timestamp.from(observedAt), Timestamp.from(receivedAt),
                event.tenant_id(), event.site_id(), event.device_id(), entityId, channel, value,
                entityId, channel, Timestamp.from(observedAt),
                event.device_id(), Timestamp.from(observedAt));
    }

    /** The entity's own ts when present and parseable, else the event's. */
    private Instant entityObservedAt(JsonNode entity, Instant fallback) {
        JsonNode ts = entity.get("ts");
        if (ts == null || !ts.isTextual()) {
            return fallback;
        }
        try {
            return OffsetDateTime.parse(ts.asText()).toInstant();
        } catch (DateTimeParseException e) {
            log.debug("unparseable entity ts '{}', using event observed_at", ts.asText());
            return fallback;
        }
    }
}
