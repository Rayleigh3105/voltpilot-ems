package com.voltpilot.api.consumers;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * RLS-scoped persistence for consumer master data + policies. Uses the
 * {@code @Primary} tenant-aware {@link JdbcTemplate} ({@code voltpilot_app},
 * NOBYPASSRLS) exactly like every customer repository - NO tenant predicate in
 * the SQL, RLS is the fence; {@code tenant_id} on a write comes from the RLS
 * session ({@code TenantContext}), never from the caller's body. The consumer
 * ENTITY (measurement_point) is owned by {@code EntityRegistryService}; this
 * repository owns the two additive tables {@code consumer_profile} +
 * {@code consumer_policy} plus the joined read.
 */
@Repository
public class ConsumerRepository {

    /** A consumer = a measurement_point (entity) + its consumer_profile row. */
    public record ConsumerRow(UUID entityId, String entityType, String label, UUID deviceId,
            String edgeSourceId, String controlKind, BigDecimal ratedPowerKw, BigDecimal minPowerKw,
            String levelsKwJson, BigDecimal resolutionKw, String powerRangesKwJson,
            String storageRelation, String defaultGridEnergyPolicy, boolean allowStorageDischarge,
            Integer defaultServiceRank, String availabilityChannel, String confirmationChannel,
            Integer minOnSeconds, Integer minOffSeconds, Integer maxStartsPerDay, String failsafe,
            boolean enabled, long version) {}

    public record PolicyRow(UUID policyId, UUID entityId, int version, String lifecycle,
            String documentJson, String contentHash, String createdBy, Instant createdAt) {}

    private static final String CONSUMER_COLUMNS =
            "mp.id AS entity_id, mp.entity_type, mp.label, mp.device_id, mp.edge_source_id, "
                    + "cp.control_kind, cp.rated_power_kw, cp.min_power_kw, "
                    + "cp.levels_kw::text AS levels, cp.resolution_kw, "
                    + "cp.power_ranges_kw::text AS ranges, cp.storage_relation, "
                    + "cp.default_grid_energy_policy, cp.allow_storage_discharge, "
                    + "cp.default_service_rank, cp.availability_channel, cp.confirmation_channel, "
                    + "cp.min_on_seconds, cp.min_off_seconds, cp.max_starts_per_day, cp.failsafe, "
                    + "cp.enabled, cp.version";

    private static final RowMapper<ConsumerRow> CONSUMER_MAPPER = (rs, n) -> new ConsumerRow(
            rs.getObject("entity_id", UUID.class),
            rs.getString("entity_type"),
            rs.getString("label"),
            rs.getObject("device_id", UUID.class),
            rs.getString("edge_source_id"),
            rs.getString("control_kind"),
            rs.getBigDecimal("rated_power_kw"),
            rs.getBigDecimal("min_power_kw"),
            rs.getString("levels"),
            rs.getBigDecimal("resolution_kw"),
            rs.getString("ranges"),
            rs.getString("storage_relation"),
            rs.getString("default_grid_energy_policy"),
            rs.getBoolean("allow_storage_discharge"),
            (Integer) rs.getObject("default_service_rank"),
            rs.getString("availability_channel"),
            rs.getString("confirmation_channel"),
            (Integer) rs.getObject("min_on_seconds"),
            (Integer) rs.getObject("min_off_seconds"),
            (Integer) rs.getObject("max_starts_per_day"),
            rs.getString("failsafe"),
            rs.getBoolean("enabled"),
            rs.getLong("version"));

    private static final RowMapper<PolicyRow> POLICY_MAPPER = (rs, n) -> new PolicyRow(
            rs.getObject("policy_id", UUID.class),
            rs.getObject("entity_id", UUID.class),
            rs.getInt("version"),
            rs.getString("lifecycle"),
            rs.getString("document"),
            rs.getString("content_hash"),
            rs.getString("created_by"),
            rs.getObject("created_at", java.time.OffsetDateTime.class).toInstant());

    private final JdbcTemplate jdbc;

    public ConsumerRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<ConsumerRow> listForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + CONSUMER_COLUMNS + " FROM consumer_profile cp "
                        + "JOIN measurement_point mp ON mp.id = cp.entity_id "
                        + "WHERE cp.site_id = ? ORDER BY mp.label NULLS LAST, mp.id",
                CONSUMER_MAPPER, siteId);
    }

    public ConsumerRow findForSite(UUID siteId, UUID entityId) {
        List<ConsumerRow> rows = jdbc.query(
                "SELECT " + CONSUMER_COLUMNS + " FROM consumer_profile cp "
                        + "JOIN measurement_point mp ON mp.id = cp.entity_id "
                        + "WHERE cp.site_id = ? AND cp.entity_id = ?",
                CONSUMER_MAPPER, siteId, entityId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public void insertProfile(UUID entityId, UUID tenantId, UUID siteId, String controlKind,
            BigDecimal ratedPowerKw, BigDecimal minPowerKw, String levelsJson,
            BigDecimal resolutionKw, String powerRangesJson, String storageRelation,
            String defaultGridEnergyPolicy, boolean allowStorageDischarge, String failsafe,
            Integer minOnSeconds, Integer minOffSeconds, Integer maxStartsPerDay) {
        jdbc.update(
                "INSERT INTO consumer_profile (entity_id, tenant_id, site_id, control_kind, "
                        + "rated_power_kw, min_power_kw, levels_kw, resolution_kw, power_ranges_kw, "
                        + "storage_relation, default_grid_energy_policy, allow_storage_discharge, "
                        + "failsafe, min_on_seconds, min_off_seconds, max_starts_per_day) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?)",
                entityId, tenantId, siteId, controlKind, ratedPowerKw, minPowerKw, levelsJson,
                resolutionKw, powerRangesJson, storageRelation, defaultGridEnergyPolicy,
                allowStorageDischarge, failsafe, minOnSeconds, minOffSeconds, maxStartsPerDay);
    }

    /**
     * Optimistic update: bumps {@code version} only when {@code expectedVersion}
     * still matches. Returns the new version, or -1 on a version conflict.
     */
    public long updateProfile(UUID siteId, UUID entityId, long expectedVersion, String controlKind,
            BigDecimal ratedPowerKw, BigDecimal minPowerKw, String levelsJson,
            BigDecimal resolutionKw, String powerRangesJson, String storageRelation,
            String defaultGridEnergyPolicy, boolean allowStorageDischarge, String failsafe,
            boolean enabled, Integer minOnSeconds, Integer minOffSeconds, Integer maxStartsPerDay) {
        int updated = jdbc.update(
                "UPDATE consumer_profile SET control_kind = ?, rated_power_kw = ?, min_power_kw = ?, "
                        + "levels_kw = ?::jsonb, resolution_kw = ?, power_ranges_kw = ?::jsonb, "
                        + "storage_relation = ?, default_grid_energy_policy = ?, "
                        + "allow_storage_discharge = ?, failsafe = ?, enabled = ?, "
                        + "min_on_seconds = ?, min_off_seconds = ?, max_starts_per_day = ?, "
                        + "version = version + 1, updated_at = now() "
                        + "WHERE site_id = ? AND entity_id = ? AND version = ?",
                controlKind, ratedPowerKw, minPowerKw, levelsJson, resolutionKw, powerRangesJson,
                storageRelation, defaultGridEnergyPolicy, allowStorageDischarge, failsafe, enabled,
                minOnSeconds, minOffSeconds, maxStartsPerDay,
                siteId, entityId, expectedVersion);
        if (updated == 0) {
            return -1;
        }
        return expectedVersion + 1;
    }

    /** Is any OTHER measurement point of this site already bound to the edge source? */
    public boolean edgeSourceBound(UUID siteId, String edgeSourceId) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM measurement_point WHERE site_id = ? AND edge_source_id = ?",
                Integer.class, siteId, edgeSourceId);
        return n != null && n > 0;
    }

    public void bindEdgeSource(UUID siteId, UUID entityId, String edgeSourceId) {
        jdbc.update("UPDATE measurement_point SET edge_source_id = ? WHERE site_id = ? AND id = ?",
                edgeSourceId, siteId, entityId);
    }

    // --- policies -----------------------------------------------------------

    public PolicyRow latestPolicy(UUID siteId, UUID entityId) {
        List<PolicyRow> rows = jdbc.query(
                "SELECT policy_id, entity_id, version, lifecycle, document::text AS document, "
                        + "content_hash, created_by, created_at FROM consumer_policy "
                        + "WHERE site_id = ? AND entity_id = ? ORDER BY version DESC LIMIT 1",
                POLICY_MAPPER, siteId, entityId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public int maxPolicyVersion(UUID siteId, UUID entityId) {
        Integer max = jdbc.queryForObject(
                "SELECT coalesce(max(version), 0) FROM consumer_policy "
                        + "WHERE site_id = ? AND entity_id = ?",
                Integer.class, siteId, entityId);
        return max == null ? 0 : max;
    }

    public PolicyRow insertPolicyDraft(UUID entityId, UUID tenantId, UUID siteId, int version,
            String documentJson, String contentHash, String createdBy) {
        UUID policyId = jdbc.queryForObject(
                "INSERT INTO consumer_policy (entity_id, tenant_id, site_id, version, lifecycle, "
                        + "document, content_hash, created_by) "
                        + "VALUES (?, ?, ?, ?, 'draft', ?::jsonb, ?, ?) RETURNING policy_id",
                UUID.class, entityId, tenantId, siteId, version, documentJson, contentHash,
                createdBy);
        return new PolicyRow(policyId, entityId, version, "draft", documentJson, contentHash,
                createdBy, Instant.now());
    }

    // --- reported edge sources (consumer-options "Verbindung wählen") --------

    public record ReportedSource(String sourceId, String label, String brand, String role,
            String health, boolean bound) {}

    /**
     * Edge-reported sources of the site (from {@code device_source_status}) that
     * can back a consumer, with whether a measurement point already binds each.
     * Empty when no device has reported yet - the draft path never needs it.
     */
    public List<ReportedSource> reportedSources(UUID siteId) {
        return jdbc.query(
                "SELECT dss.source_id, dss.label, dss.brand, dss.role, dss.health, "
                        + "EXISTS (SELECT 1 FROM measurement_point mp "
                        + "        WHERE mp.site_id = dss.site_id "
                        + "          AND mp.edge_source_id = dss.source_id) AS bound "
                        + "FROM device_source_status dss WHERE dss.site_id = ? AND dss.kind = 'source' "
                        + "ORDER BY dss.label NULLS LAST, dss.source_id",
                (rs, n) -> new ReportedSource(rs.getString("source_id"), rs.getString("label"),
                        rs.getString("brand"), rs.getString("role"), rs.getString("health"),
                        rs.getBoolean("bound")),
                siteId);
    }
}
