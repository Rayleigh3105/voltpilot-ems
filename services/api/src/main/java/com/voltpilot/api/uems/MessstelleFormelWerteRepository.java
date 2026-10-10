package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
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

    public Optional<UUID> anlage(UUID entityId) {
        return jdbc.query("SELECT site_id FROM measurement_point WHERE id = ?",
                (rs, n) -> rs.getObject("site_id", UUID.class), entityId).stream().findFirst();
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

    /** Die führenden Quellen der Hauptgröße dieser Messstellen samt Box ({@link GeteiltesRegister#lade}). */
    public List<GeteiltesRegister.Bindung> bindungen(Collection<UUID> messstellen, Instant von, Instant bis) {
        return GeteiltesRegister.lade(jdbc, messstellen, von, bis);
    }

    /**
     * Der jeweils frischeste GUTE numerische Wert des Kanals DIESER Komponente (für den Live-Wert).
     *
     * <p>⚠ Geteilter Punkt (AP-07 IP-18b): meldet die Box den Plan je Komponente, liegen am selben
     * {@code (device_id, point_key)} Zeilen JE KOMPONENTE ({@code edge_entity_id}). Gelesen werden
     * nur die Zeilen der Box ({@code edge_entity_id IS NULL}, alles Heutige) und die der eigenen
     * Komponente - nie der Wert der anderen. Ohne geteilten Punkt ist jede Zeile eine der Box und
     * das Ergebnis dasselbe wie vorher.
     */
    public Optional<Messwert> frischester(Quelle q, String pointKey, UUID entityId) {
        return jdbc.query("SELECT COALESCE(decoded_numeric, raw_numeric) AS wert, time "
                + "FROM device_measurement_sample "
                + "WHERE tenant_id = ? AND site_id = ? AND device_id = ? AND point_key = ? "
                + "AND (edge_entity_id IS NULL OR edge_entity_id = ?) "
                + "AND quality = 'good' AND COALESCE(decoded_numeric, raw_numeric) IS NOT NULL "
                + "ORDER BY time DESC, edge_sequence DESC LIMIT 1",
                (rs, n) -> new Messwert(rs.getDouble("wert"), rs.getTimestamp("time").toInstant()),
                TenantContext.get(), q.siteId(), q.deviceId(), pointKey, entityId)
                .stream().findFirst();
    }

    /**
     * Die 15-min-Buckets des Kanals in {@code [von, bis)}, je nach Wertart aggregiert: Momentanwert
     * → Mittelwert, Intervallmenge → positive Differenz, Zählerstand → letzter Stand
     * (wie {@code MeasurementHistoryService}). Bucket-Anfang (UTC-Instant) → Wert.
     *
     * <p>⚠ Geteilter Punkt (AP-07 IP-18b): die Box-Verdichtung enthält nur Zeilen ohne
     * {@code edge_entity_id}. Ein Bucket, den sie nicht hat, kommt aus den Zeilen DIESER Komponente
     * ({@link #verlauf15mDerKomponente}, dieselbe Regel wie die Verdichtung) - nie aus denen der anderen.
     * Ohne geteilten Punkt gibt es keine solche Zeile, und das Ergebnis ist Bucket für Bucket das von vorher.
     */
    public Map<Instant, Double> verlauf15m(Quelle q, String pointKey, UUID entityId, String wertart, Instant von,
            Instant bis) {
        Map<Instant, Double> box = verlauf15m(q, pointKey, wertart, von, bis);
        if (entityId == null) {
            return box;
        }
        Map<Instant, Double> komponente = verlauf15mDerKomponente(q, pointKey, entityId, wertart, von, bis);
        if (komponente.isEmpty()) {
            return box;
        }
        TreeMap<Instant, Double> beide = new TreeMap<>(komponente);
        beide.putAll(box);
        return new LinkedHashMap<>(beide);
    }

    private Map<Instant, Double> verlauf15m(Quelle q, String pointKey, String wertart, Instant von, Instant bis) {
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

    /**
     * Die 15-min-Buckets aus den Zeilen, die die Box für DIESE Komponente genannt hat
     * ({@code edge_entity_id}), mit der Regel der Box-Verdichtung {@code refresh_device_measurement_rollup}:
     * nur gute Werte, nur die Langzeit-Kadenz 900 s, Mittel nur für {@code gauge}, letzter Stand für
     * {@code gauge}/{@code counter}, positive Differenz nur für {@code counter}.
     */
    private Map<Instant, Double> verlauf15mDerKomponente(Quelle q, String pointKey, UUID entityId, String wertart,
            Instant von, Instant bis) {
        String ausdruck = switch (wertart) {
            case "Intervallmenge" -> "sum(CASE WHEN prev IS NULL THEN 0 WHEN v >= prev THEN v - prev ELSE 0 END) "
                    + "FILTER (WHERE aggregation_kind = 'counter')";
            case "Zählerstand" -> "last(v, time) FILTER (WHERE aggregation_kind IN ('gauge','counter'))";
            default -> "avg(v) FILTER (WHERE aggregation_kind = 'gauge')"; // Momentanwert
        };
        Map<Instant, Double> out = new LinkedHashMap<>();
        List<Object[]> rows = jdbc.query("WITH ordered AS ("
                + "SELECT time, aggregation_kind, long_term_cadence_s, COALESCE(decoded_numeric, raw_numeric) AS v, "
                + "lag(COALESCE(decoded_numeric, raw_numeric)) OVER (ORDER BY time, edge_sequence) AS prev "
                + "FROM device_measurement_sample "
                + "WHERE tenant_id = ? AND site_id = ? AND device_id = ? AND point_key = ? AND edge_entity_id = ? "
                + "AND quality = 'good' AND time >= ? AND time < ?) "
                + "SELECT time_bucket(INTERVAL '15 minutes', time) AS bucket, " + ausdruck + " AS wert "
                + "FROM ordered WHERE long_term_cadence_s = 900 GROUP BY 1 "
                + "HAVING " + ausdruck + " IS NOT NULL ORDER BY 1",
                (rs, n) -> new Object[] {rs.getTimestamp("bucket").toInstant(), rs.getDouble("wert")},
                TenantContext.get(), q.siteId(), q.deviceId(), pointKey, entityId,
                Timestamp.from(von), Timestamp.from(bis));
        for (Object[] r : rows) {
            out.put((Instant) r[0], (Double) r[1]);
        }
        return out;
    }
}
