package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Liest die EINGANGSWERTE eines Messkanal-Terms aus den historisierten Samples (Bericht 1.1):
 * den jeweils frischesten Wert für den Live-Wert und die 15-min-Buckets für den Verlauf. Ein
 * berechneter Wert liest NIE eine Box (der Edge-Vertrag bleibt unangetastet) — er summiert die
 * schon gespeicherten Werte anderer Komponenten. Alles RLS-scoped (der Mandant ist die Policy);
 * eine fremde Komponente löst gar nicht erst auf.
 *
 * <p>Der Term bindet an {@code (entity_id, point_key)} wie die Quellenbindung (IP-13); die
 * Sample-/Rollup-Tabellen sind aber je {@code (site_id, device_id, point_key)} geführt. Die
 * lesende Box wird deshalb hier aufgelöst — über die Mess-Selektion der Komponente
 * ({@code device_measurement_selection}, dasselbe Muster wie {@code MesskanalService}).
 */
@Repository
public class MessstelleFormelWerteRepository {

    private final JdbcTemplate jdbc;

    public MessstelleFormelWerteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die lesende Box + Anlage einer Komponente für einen Kanal. */
    public record Quelle(UUID siteId, UUID deviceId) {}

    /** Gehört die Komponente dem Mandanten? RLS-scoped über {@code measurement_point} (404, nie 403). */
    public boolean komponenteGehoert(UUID entityId) {
        Boolean da = jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM measurement_point WHERE id = ?)", Boolean.class, entityId);
        return Boolean.TRUE.equals(da);
    }

    /** Ein frischester Wert mit seinem Messzeitpunkt. */
    public record Messwert(double wert, Instant zeit) {}

    /**
     * Löst {@code (entity_id, point_key)} auf die lesende Box + Anlage auf. {@code site_id} kommt
     * aus der RLS-geschützten {@code measurement_point} (eine fremde Komponente → leer), die Box
     * aus der Mess-Selektion. Leer, wenn kein Gerät den Kanal der Komponente liest. Eine Box, die
     * nicht ausgebaut ist, geht vor (UEMS AP-07 IP-11): die Auswahl einer ausgebauten Box bleibt
     * gespeichert, liefert aber keinen Live-Wert mehr, solange eine andere Box den Kanal liest.
     */
    public Optional<Quelle> quelle(UUID entityId, String pointKey) {
        return jdbc.query("""
                SELECT mp.site_id AS site_id, sel.device_id AS device_id
                  FROM measurement_point mp
                  JOIN device_measurement_selection sel
                    ON sel.entity_id = mp.id AND sel.point_key = ?
                  JOIN device d ON d.id = sel.device_id
                 WHERE mp.id = ?
                 ORDER BY (d.ausgebaut_am IS NOT NULL), sel.device_id
                 LIMIT 1
                """, (rs, n) -> new Quelle(rs.getObject("site_id", UUID.class),
                        rs.getObject("device_id", UUID.class)), pointKey, entityId)
                .stream().findFirst();
    }

    /** Der jeweils frischeste GUTE numerische Wert des Kanals (für den Live-Wert). */
    public Optional<Messwert> frischester(Quelle q, String pointKey) {
        return jdbc.query("SELECT COALESCE(decoded_numeric, raw_numeric) AS wert, time "
                + "FROM device_measurement_sample "
                + "WHERE tenant_id = ? AND site_id = ? AND device_id = ? AND point_key = ? "
                + "AND quality = 'good' AND COALESCE(decoded_numeric, raw_numeric) IS NOT NULL "
                + "ORDER BY time DESC, edge_sequence DESC LIMIT 1",
                (rs, n) -> new Messwert(rs.getDouble("wert"), rs.getTimestamp("time").toInstant()),
                TenantContext.get(), q.siteId(), q.deviceId(), pointKey)
                .stream().findFirst();
    }

    /**
     * Die 15-min-Buckets des Kanals in {@code [von, bis)}, je nach Wertart aggregiert: Momentanwert
     * → Mittelwert, Intervallmenge → positive Differenz, Zählerstand → letzter Stand
     * (wie {@code MeasurementHistoryService}). Bucket-Anfang (UTC-Instant) → Wert.
     */
    public Map<Instant, Double> verlauf15m(Quelle q, String pointKey, String wertart, Instant von, Instant bis) {
        String spalte = switch (wertart) {
            case "Intervallmenge" -> "positive_delta";
            case "Zählerstand" -> "last_numeric";
            default -> "avg_numeric"; // Momentanwert
        };
        Map<Instant, Double> out = new LinkedHashMap<>();
        List<Object[]> rows = jdbc.query("SELECT bucket, " + spalte + " AS wert "
                + "FROM device_measurement_rollup_15m "
                + "WHERE tenant_id = ? AND site_id = ? AND device_id = ? AND point_key = ? "
                + "AND bucket >= ? AND bucket < ? AND " + spalte + " IS NOT NULL ORDER BY bucket",
                (rs, n) -> new Object[] {rs.getTimestamp("bucket").toInstant(), rs.getDouble("wert")},
                TenantContext.get(), q.siteId(), q.deviceId(), pointKey,
                Timestamp.from(von), Timestamp.from(bis));
        for (Object[] r : rows) {
            out.put((Instant) r[0], (Double) r[1]);
        }
        return out;
    }
}
