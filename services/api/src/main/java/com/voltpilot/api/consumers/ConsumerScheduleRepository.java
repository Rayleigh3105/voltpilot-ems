package com.voltpilot.api.consumers;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Consumer plan slots for the Fahrplan view (Verbrauchssteuerung Inkrement 2,
 * docs/verbrauchssteuerung.md §11 {@code /consumer-schedule} + §14.11).
 *
 * <p>Reads {@code site_plan_run} + {@code entity_plan_slot} (migration
 * V20260810010000) through the RLS-scoped {@code @Primary} datasource - like
 * {@link com.voltpilot.api.repo.ScheduleRepository} every query is transparently
 * narrowed to the caller's tenant, a foreign site simply has no rows. Written by
 * services/optimization (shadow-flagged sites only in Inkrement 2), so an empty
 * result is the NORMAL state of an unflagged production site: the endpoint then
 * returns a well-formed empty document, never a 404.
 *
 * <p>Read mode = the v1 Fahrplan semantics ({@code ScheduleRepository.latestForSite}):
 * THE newest run, whole - the plan the device would execute. The
 * latest-run-per-slot splice reads ride the SkipScan index
 * {@code (entity_id, time, generated_at DESC)} when a later increment needs them.
 */
@Repository
public class ConsumerScheduleRepository {

    /** One planned consumer slot; {@code targetValue} is the planned power in kW. */
    public record ConsumerPlanSlotDto(
            Instant time,
            String command,
            BigDecimal targetValue,
            String reasonCode,
            String requirementId) {}

    /** One consumer entity's slots; {@code name} = the customer-facing label. */
    public record ConsumerEntityScheduleDto(
            String entityId,
            String name,
            List<ConsumerPlanSlotDto> slots) {}

    /**
     * The newest run's consumer slots. {@code planId}/{@code generatedAt} are
     * null (and {@code entities} empty) while no plan is stored - the honest
     * empty state, never fabricated.
     */
    public record ConsumerScheduleDto(
            UUID planId,
            Instant generatedAt,
            int slotMinutes,
            List<ConsumerEntityScheduleDto> entities) {}

    private static final ConsumerScheduleDto EMPTY =
            new ConsumerScheduleDto(null, null, 15, List.of());

    private final JdbcTemplate jdbc;

    public ConsumerScheduleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public ConsumerScheduleDto latestForSite(UUID siteId) {
        List<Object[]> runs = jdbc.query(
                "SELECT plan_id, generated_at, slot_minutes FROM site_plan_run "
                        + "WHERE site_id = ? ORDER BY generated_at DESC LIMIT 1",
                (rs, i) -> new Object[] {
                        rs.getObject("plan_id", UUID.class),
                        rs.getTimestamp("generated_at").toInstant(),
                        rs.getInt("slot_minutes")
                },
                siteId);
        if (runs.isEmpty()) {
            return EMPTY;
        }
        UUID planId = (UUID) runs.get(0)[0];
        Instant generatedAt = (Instant) runs.get(0)[1];
        int slotMinutes = (Integer) runs.get(0)[2];

        record Row(String entityId, String name, ConsumerPlanSlotDto slot) {}
        List<Row> rows = jdbc.query(
                "SELECT eps.entity_id, eps.time, eps.command, eps.target_value, "
                        + "eps.reason_code, eps.requirement_id, mp.label "
                        + "FROM entity_plan_slot eps "
                        + "LEFT JOIN measurement_point mp ON mp.id::text = eps.entity_id "
                        + "WHERE eps.site_id = ? AND eps.plan_id = ? AND eps.generated_at = ? "
                        + "ORDER BY eps.entity_id, eps.time",
                (rs, i) -> new Row(
                        rs.getString("entity_id"),
                        rs.getString("label"),
                        new ConsumerPlanSlotDto(
                                rs.getTimestamp("time").toInstant(),
                                rs.getString("command"),
                                rs.getBigDecimal("target_value"),
                                rs.getString("reason_code"),
                                rs.getString("requirement_id"))),
                siteId, planId, Timestamp.from(generatedAt));

        Map<String, ConsumerEntityScheduleDto> byEntity = new LinkedHashMap<>();
        for (Row row : rows) {
            byEntity.computeIfAbsent(
                            row.entityId(),
                            id -> new ConsumerEntityScheduleDto(
                                    id, row.name(), new ArrayList<>()))
                    .slots()
                    .add(row.slot());
        }
        return new ConsumerScheduleDto(
                planId, generatedAt, slotMinutes, List.copyOf(byEntity.values()));
    }
}
