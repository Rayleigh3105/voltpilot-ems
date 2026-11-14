package com.voltpilot.api.abrechnung;

import com.voltpilot.api.abrechnung.AbrechnungRegel.Stand;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.history.Zeitraum;
import java.math.BigDecimal;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Lese- und Schreibweg von „Abrechnung prüfen" (Pakete R2/R3). Jede Abfrage auf den Messdaten geht über
 * {@code JOIN site} (Standort-Zaun, {@code SiteScopeArchitekturTest}); Mandant über RLS, nie aus der Anfrage.
 */
@Repository
public class AbrechnungRepository {

    /** Zählerstand Bezug am Netzanschluss. */
    public static final String KANAL_BEZUG = "energy_kwh";
    /** Zählerstand Einspeisung (Rückfluss) am Netzanschluss - von diesem Paket erstmals gelesen. */
    public static final String KANAL_EINSPEISUNG = "energy_export_kwh";

    private final JdbcTemplate jdbc;

    public AbrechnungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die Tagesend-Stände des Zählers am Netzanschluss je Kanal, vom Vortag des Zeitraums bis zu seinem letzten
     * Tag: {@code min} und {@code last} je Berliner Tag aus {@code telemetry_v2_rollup_1d} (dauerhaft, nicht der
     * Rohreihe unterworfen). Trägt mehr als ein Netz-Zähler denselben Kanal, ist die Herkunft nicht eindeutig
     * - der Kanal fällt dann ganz weg und die Abrechnung summiert.
     */
    public Map<String, Map<LocalDate, Stand>> zaehlerstaende(UUID siteId, Zeitraum z) {
        Instant von = z.von().minusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant();
        Instant bis = z.window().to();
        Map<String, Map<LocalDate, Stand>> je = new HashMap<>();
        Map<String, Set<String>> geraete = new HashMap<>();
        jdbc.query(
                "SELECT r.bucket, r.channel, r.entity_id, r.min_value, r.last_value "
                        + "FROM telemetry_v2_rollup_1d r "
                        + "JOIN site s ON s.id = r.site_id "
                        + "JOIN measurement_point mp ON mp.id::text = r.entity_id "
                        + "WHERE r.site_id = ? AND mp.entity_type = 'grid-meter' "
                        + "AND r.channel IN ('" + KANAL_BEZUG + "', '" + KANAL_EINSPEISUNG + "') "
                        + "AND r.bucket >= ? AND r.bucket < ? "
                        + "AND r.min_value IS NOT NULL AND r.last_value IS NOT NULL "
                        + "ORDER BY r.bucket",
                (ResultSet rs) -> {
                    String kanal = rs.getString("channel");
                    geraete.computeIfAbsent(kanal, k -> new HashSet<>()).add(rs.getString("entity_id"));
                    LocalDate tag = rs.getTimestamp("bucket").toInstant().atZone(HistoryRange.ZONE).toLocalDate();
                    je.computeIfAbsent(kanal, k -> new HashMap<>())
                            .put(tag, new Stand(rs.getDouble("min_value"), rs.getDouble("last_value")));
                },
                siteId, Timestamp.from(von), Timestamp.from(bis));
        geraete.forEach((kanal, ids) -> {
            if (ids.size() > 1) {
                je.remove(kanal);
            }
        });
        return je;
    }

    /**
     * Der erste gemessene Berliner Tag der Anlage über beide Reihen (v1 und v2), {@code null} = noch nie
     * gemessen. Anders als die Abdeckung des Verlaufs zählt hier auch eine reine v2-Anlage.
     */
    public LocalDate messbeginn(UUID siteId) {
        Timestamp t = jdbc.queryForObject(
                "SELECT least("
                        + "(SELECT min(r.bucket) FROM telemetry_rollup_1d r JOIN site s ON s.id = r.site_id "
                        + "  WHERE r.site_id = ?), "
                        + "(SELECT min(r.bucket) FROM telemetry_v2_rollup_1d r JOIN site s ON s.id = r.site_id "
                        + "  WHERE r.site_id = ?))",
                Timestamp.class, siteId, siteId);
        return t == null ? null : t.toInstant().atZone(HistoryRange.ZONE).toLocalDate();
    }

    // ---- Gespeicherte Prüfungen (R3) -------------------------------------------------------------------------

    /** Eine gespeicherte Prüfung: die Zahlen von der Rechnung für einen Zeitraum. */
    public record Pruefung(LocalDate von, LocalDate bis, BigDecimal bezugKwh, BigDecimal einspeisungKwh,
            Instant geaendertAm) {
    }

    private static Pruefung pruefung(ResultSet rs, int i) throws SQLException {
        return new Pruefung(rs.getDate("von").toLocalDate(), rs.getDate("bis").toLocalDate(),
                rs.getBigDecimal("bezug_kwh"), rs.getBigDecimal("einspeisung_kwh"),
                rs.getTimestamp("geaendert_am").toInstant());
    }

    /** Alle Prüfungen der Anlage, die jüngste Zeitraum-Grenze zuerst. */
    public List<Pruefung> liste(UUID siteId) {
        return jdbc.query(
                "SELECT von, bis, bezug_kwh, einspeisung_kwh, geaendert_am FROM abrechnung_pruefung "
                        + "WHERE site_id = ? ORDER BY bis DESC, von DESC",
                AbrechnungRepository::pruefung, siteId);
    }

    /** Die Prüfung genau dieses Zeitraums, {@code null} ohne Zeile. */
    public Pruefung lese(UUID siteId, LocalDate von, LocalDate bis) {
        List<Pruefung> l = jdbc.query(
                "SELECT von, bis, bezug_kwh, einspeisung_kwh, geaendert_am FROM abrechnung_pruefung "
                        + "WHERE site_id = ? AND von = ? AND bis = ?",
                AbrechnungRepository::pruefung, siteId, Date.valueOf(von), Date.valueOf(bis));
        return l.isEmpty() ? null : l.get(0);
    }

    /** Schreibt beide Zahlen des Zeitraums (eine {@code null} löscht nur sie); Mandant aus dem RLS-Kontext. */
    public void schreibe(UUID siteId, LocalDate von, LocalDate bis, BigDecimal bezugKwh,
            BigDecimal einspeisungKwh, String urheber) {
        jdbc.update(
                "INSERT INTO abrechnung_pruefung (site_id, tenant_id, von, bis, bezug_kwh, einspeisung_kwh, "
                        + "geaendert_am, geaendert_von) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, now(), ?) "
                        + "ON CONFLICT (site_id, von, bis) DO UPDATE SET bezug_kwh = EXCLUDED.bezug_kwh, "
                        + "einspeisung_kwh = EXCLUDED.einspeisung_kwh, geaendert_am = now(), "
                        + "geaendert_von = EXCLUDED.geaendert_von",
                siteId, Date.valueOf(von), Date.valueOf(bis), bezugKwh, einspeisungKwh, urheber);
    }

    /** Löscht die Prüfung des Zeitraums; {@code true}, wenn es eine gab. */
    public boolean loesche(UUID siteId, LocalDate von, LocalDate bis) {
        return jdbc.update("DELETE FROM abrechnung_pruefung WHERE site_id = ? AND von = ? AND bis = ?",
                siteId, Date.valueOf(von), Date.valueOf(bis)) > 0;
    }
}
