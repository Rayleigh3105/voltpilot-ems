package com.voltpilot.writer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.MeterRegistry;
import java.io.IOException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** Cloud-only register evidence. Never infers physical identity from a port or an address. */
@Component
public class KernSpiegelNachschlag {
    private static final Logger log = LoggerFactory.getLogger(KernSpiegelNachschlag.class);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate savepoint;
    private final MeterRegistry meters;
    /**
     * Jeder Laufzeitstand, unter dem eine Auswahl gespeichert sein kann und dessen Box-Sicht der
     * Registerpaare gleich ist ({@code check_core_mirrors.py} prüft es je Katalog-Artefakt): eine
     * Bestandsauswahl behält nach einer Hebung ihre Kennzeichnung, ohne neu gespeichert zu werden.
     */
    private final String catalogVersions;
    private final List<Zuordnung> mappings;

    private record Zuordnung(String family, String type, String channel, String point) {}
    private record Auswahl(String family, String type, String point) {}

    public KernSpiegelNachschlag(JdbcTemplate jdbc, PlatformTransactionManager transactions,
            MeterRegistry meters, ObjectMapper json) throws IOException {
        this.jdbc = jdbc;
        this.meters = meters;
        savepoint = new TransactionTemplate(transactions);
        savepoint.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        try (var input = new ClassPathResource("core-channel-mirrors.json").getInputStream()) {
            JsonNode data = json.readTree(input);
            List<String> versions = new ArrayList<>();
            data.path("runtime_catalog_versions").forEach(v -> versions.add(v.asText()));
            if (versions.isEmpty()) {
                throw new IllegalStateException("core-channel-mirrors.json names no runtime catalog version");
            }
            catalogVersions = String.join(",", versions);
            List<Zuordnung> loaded = new ArrayList<>();
            for (JsonNode m : data.path("mappings")) {
                loaded.add(new Zuordnung(m.path("family").asText(), m.path("entity_type").asText(),
                        m.path("channel").asText(), m.path("point_key").asText()));
            }
            mappings = List.copyOf(loaded);
        }
    }

    /** Exactly one proven second path at observation time, otherwise no new assertion (NULL). */
    public String pointKey(UUID tenant, UUID site, UUID box, String entity, String channel, Instant time) {
        if (mappings.stream().noneMatch(m -> m.channel().equals(channel))) {
            return null;
        }
        try {
            return savepoint.execute(status -> {
                List<Auswahl> selected = jdbc.query("""
                        SELECT p.family, p.entity_type, s.point_key
                          FROM measurement_point p
                          JOIN device_measurement_selection s ON s.entity_id = p.id
                           AND s.tenant_id = p.tenant_id AND s.site_id = p.site_id
                         WHERE p.tenant_id = ? AND p.site_id = ? AND p.id::text = ?
                           AND (p.source_kind IS NULL OR p.source_kind IN ('builtin', 'composed'))
                           AND s.device_id = ? AND s.catalog_version = ANY(string_to_array(?, ','))
                           AND s.custom_definition IS NULL
                           AND s.enabled_at <= ? AND (s.disabled_at IS NULL OR s.disabled_at > ?)
                           AND (s.applied_at <= ? OR EXISTS (
                               SELECT 1 FROM device_measurement_selection_event e
                                WHERE e.tenant_id = s.tenant_id AND e.device_id = s.device_id
                                  AND e.entity_id = s.entity_id AND e.point_key = s.point_key
                                  AND e.catalog_version = s.catalog_version
                                  AND e.event_kind <> 'first_sample' AND e.requested_enabled
                                  AND e.enabled_at = s.enabled_at
                                  AND e.applied_at <= ? AND e.enabled_at <= ?
                                  AND (e.disabled_at IS NULL OR e.disabled_at > ?)))
                           AND (s.enabled OR s.disabled_at IS NOT NULL)
                           AND NOT EXISTS (
                               SELECT 1 FROM device_measurement_selection other
                                WHERE other.device_id = s.device_id AND other.point_key = s.point_key
                                  AND other.entity_id IS DISTINCT FROM s.entity_id)
                        """, (rs, n) -> new Auswahl(rs.getString(1), rs.getString(2), rs.getString(3)),
                        tenant, site, entity, box, catalogVersions, Timestamp.from(time), Timestamp.from(time),
                        Timestamp.from(time), Timestamp.from(time), Timestamp.from(time), Timestamp.from(time));
                List<String> matches = selected.stream().filter(s -> mappings.stream().anyMatch(m ->
                        m.channel().equals(channel) && m.family().equals(s.family())
                                && m.type().equals(s.type()) && m.point().equals(s.point())))
                        .map(Auswahl::point).distinct().toList();
                return matches.size() == 1 ? matches.getFirst() : null;
            });
        } catch (RuntimeException ex) {
            meters.counter("voltpilot.writer.kern.spiegel", "ergebnis", "fehler").increment();
            log.error("Kern-Spiegel-Nachschlag fuer {} / {} zurueckgerollt; Kernwert bleibt erhalten",
                    entity, channel, ex);
            return null;
        }
    }
}
