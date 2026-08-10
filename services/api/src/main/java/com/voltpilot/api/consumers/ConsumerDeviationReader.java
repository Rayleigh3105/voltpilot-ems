package com.voltpilot.api.consumers;

import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.web.dto.ConsumerDeviationDto;
import com.voltpilot.api.web.dto.ConsumerDeviationDto.Row;
import com.voltpilot.api.web.dto.ConsumerRuntimeStatusDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * The Soll/Ist diagnosis (§18): the co-optimizer's PLAN for the current slot vs.
 * the edge's CONFIRMED Ist. Platform/support-layer read only ({@code
 * showTechnicalLayer()}), never a customer surface. Reads the newest run's
 * {@code entity_plan_slot} (Soll) and {@code consumer_runtime_status} (Ist)
 * through the RLS datasource - a foreign site simply has no rows.
 */
@Service
public class ConsumerDeviationReader {

    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private final JdbcTemplate jdbc;
    private final ConsumerRuntimeStatusRepository runtime;

    public ConsumerDeviationReader(JdbcTemplate jdbc, ConsumerRuntimeStatusRepository runtime) {
        this.jdbc = jdbc;
        this.runtime = runtime;
    }

    public ConsumerDeviationDto forSite(UUID siteId) {
        Instant now = Instant.now();
        Map<UUID, ConsumerRuntimeStatusDto> ist = new HashMap<>();
        for (ConsumerRuntimeStatusDto r : runtime.listForSite(siteId)) {
            ist.put(r.entityId(), r);
        }

        // The newest run (v1 latestForSite semantics).
        List<Object[]> runs = jdbc.query(
                "SELECT plan_id, generated_at, slot_minutes FROM site_plan_run "
                        + "WHERE site_id = ? ORDER BY generated_at DESC LIMIT 1",
                (rs, i) -> new Object[] {rs.getObject("plan_id", UUID.class),
                        rs.getTimestamp("generated_at").toInstant(), rs.getInt("slot_minutes")},
                siteId);

        Map<UUID, Soll> soll = new LinkedHashMap<>();
        if (!runs.isEmpty()) {
            UUID planId = (UUID) runs.get(0)[0];
            Instant generatedAt = (Instant) runs.get(0)[1];
            int slotMinutes = (Integer) runs.get(0)[2];
            Instant slotStart = floorToSlot(now, slotMinutes);
            Instant slotEnd = slotStart.plusSeconds(slotMinutes * 60L);
            ZonedDateTime local = now.atZone(ZONE);
            Instant dayStart = local.toLocalDate().atStartOfDay(ZONE).toInstant();
            Instant dayEnd = local.toLocalDate().plusDays(1).atStartOfDay(ZONE).toInstant();

            List<PlanSlot> slots = jdbc.query(
                    "SELECT eps.entity_id, mp.label, eps.time, eps.target_value "
                            + "FROM entity_plan_slot eps "
                            + "LEFT JOIN measurement_point mp ON mp.id::text = eps.entity_id "
                            + "WHERE eps.site_id = ? AND eps.plan_id = ? AND eps.generated_at = ? "
                            + "AND eps.time >= ? AND eps.time < ?",
                    (rs, i) -> new PlanSlot(parseUuid(rs.getString("entity_id")),
                            rs.getString("label"), rs.getTimestamp("time").toInstant(),
                            rs.getBigDecimal("target_value")),
                    siteId, planId, Timestamp.from(generatedAt),
                    Timestamp.from(dayStart), Timestamp.from(dayEnd));
            for (PlanSlot ps : slots) {
                if (ps.entityId() == null) {
                    continue;
                }
                Soll s = soll.computeIfAbsent(ps.entityId(), id -> new Soll(ps.name()));
                // target_value is the planned power in kW for both commands
                // (on_off persists Nennleistung/0); >0 = the slot runs.
                if (ps.target() != null && ps.target().signum() > 0) {
                    s.plannedRuntimeSeconds += slotMinutes * 60;
                }
                if (!ps.time().isBefore(slotStart) && ps.time().isBefore(slotEnd)) {
                    s.plannedKw = ps.target();
                }
            }
        }

        // Union of everything we know about (plan ∪ Ist), so a consumer that is
        // running but not planned (a manual override) still shows.
        List<Row> rows = new ArrayList<>();
        java.util.Set<UUID> all = new java.util.LinkedHashSet<>(soll.keySet());
        all.addAll(ist.keySet());
        for (UUID entityId : all) {
            Soll s = soll.get(entityId);
            ConsumerRuntimeStatusDto i = ist.get(entityId);
            BigDecimal plannedKw = s == null ? null : s.plannedKw;
            BigDecimal actualKw = i == null || i.actualKw() == null
                    ? null : BigDecimal.valueOf(i.actualKw());
            BigDecimal deviation = (plannedKw != null && actualKw != null)
                    ? actualKw.subtract(plannedKw).setScale(3, RoundingMode.HALF_UP) : null;
            String name = s != null && s.name != null ? s.name : null;
            rows.add(new Row(entityId, name, plannedKw, actualKw, deviation,
                    s == null ? null : s.plannedRuntimeSeconds,
                    i == null ? null : i.runtimeSecondsToday(),
                    i == null ? null : i.confirmed(),
                    i == null ? null : i.state(),
                    i == null ? null : i.reasonCode()));
        }
        return new ConsumerDeviationDto(rows);
    }

    private record PlanSlot(UUID entityId, String name, Instant time, BigDecimal target) {}

    private static final class Soll {
        final String name;
        BigDecimal plannedKw;
        int plannedRuntimeSeconds;

        Soll(String name) {
            this.name = name;
        }
    }

    private static Instant floorToSlot(Instant now, int slotMinutes) {
        long slot = slotMinutes * 60L;
        return Instant.ofEpochSecond((now.getEpochSecond() / slot) * slot);
    }

    private static UUID parseUuid(String s) {
        try {
            return s == null ? null : UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
