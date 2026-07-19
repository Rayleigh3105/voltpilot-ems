package com.voltpilot.api.repo;

import com.voltpilot.api.history.HistoryRange;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Per-entity history over the generic v2 telemetry (E1b): channel-keyed
 * bucket series from {@code telemetry_v2} and its rollup cascade. The v1
 * discipline applies verbatim: day = LIVE 15-min buckets straight from raw
 * (never behind the rollup refresh), week = the hourly rollup, month/year =
 * the Europe/Berlin daily rollup. RLS-scoped like every customer repository
 * (no tenant predicate; the site_id predicate anchors the entity to the
 * caller-visible site).
 */
@Repository
public class EntityHistoryRepository {

    /** One aggregated bucket of one channel. */
    public record Bucket(Instant start, Double avg, Double min, Double max, Double last, long n) {}

    private final JdbcTemplate jdbc;

    public EntityHistoryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Channel-keyed bucket series of one entity over [from, to). */
    public Map<String, List<Bucket>> history(UUID siteId, String entityId, HistoryRange range,
            Instant from, Instant to) {
        List<ChannelBucket> rows;
        if (range == HistoryRange.DAY) {
            rows = jdbc.query(
                    "SELECT time_bucket('15 minutes', time) AS bucket, channel, "
                            + "avg(value) AS avg_value, min(value) AS min_value, "
                            + "max(value) AS max_value, last(value, time) AS last_value, "
                            + "count(*) AS n_samples "
                            + "FROM telemetry_v2 WHERE site_id = ? AND entity_id = ? "
                            + "AND time >= ? AND time < ? "
                            + "GROUP BY 1, 2 ORDER BY channel, bucket",
                    EntityHistoryRepository::mapRow,
                    siteId, entityId, Timestamp.from(from), Timestamp.from(to));
        } else {
            String table = range.dailyBuckets() ? "telemetry_v2_rollup_1d"
                    : "telemetry_v2_rollup_1h";
            rows = jdbc.query(
                    "SELECT bucket, channel, avg_value, min_value, max_value, last_value, "
                            + "n_samples FROM " + table + " WHERE site_id = ? AND entity_id = ? "
                            + "AND bucket >= ? AND bucket < ? ORDER BY channel, bucket",
                    EntityHistoryRepository::mapRow,
                    siteId, entityId, Timestamp.from(from), Timestamp.from(to));
        }
        Map<String, List<Bucket>> channels = new LinkedHashMap<>();
        for (ChannelBucket row : rows) {
            channels.computeIfAbsent(row.channel(), k -> new java.util.ArrayList<>())
                    .add(row.bucket());
        }
        return channels;
    }

    private record ChannelBucket(String channel, Bucket bucket) {}

    private static ChannelBucket mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new ChannelBucket(rs.getString("channel"), new Bucket(
                rs.getTimestamp("bucket").toInstant(),
                (Double) rs.getObject("avg_value"),
                (Double) rs.getObject("min_value"),
                (Double) rs.getObject("max_value"),
                (Double) rs.getObject("last_value"),
                rs.getLong("n_samples")));
    }
}
