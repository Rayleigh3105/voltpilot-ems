package com.voltpilot.api.ueberwachung;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die historische Reihe eines Werts für den 30-Tage-Probelauf (Alerting Scheibe 2, §6.4, §6.8
 * Entwurf 1): liest {@code telemetry_v2_rollup_15m} - denselben 15-Minuten-Rollup, aus dem auch
 * der Verlauf seine v2-Ära-Zeitreihen baut ({@code HistoryRepository#v2RollupBuckets}) - statt die
 * rohe 90-Tage-Reihe für ein 30-Tage-Fenster neu zu aggregieren (§7/§10 "Last messen statt raten").
 *
 * <p>Die {@code anlagenfluss}-Felder teilen sich EINE Abfrage (dieselbe Rollen-Summe wie
 * {@code HistoryRepository#v2Reconstruction}, nur als kW-Mittel je Viertelstunde statt als kWh-
 * Energie): Netz (Grenzwert-Zähler), PV- und Batterieleistung (Summe), Ladestand (Mittel der
 * {@code soc_pct}-Kanäle). {@code messreihe} braucht keine Rollen-Summe - ein Kanal, eine Zeile.
 */
@Repository
public class ProbelaufRepository {

    private record AnlagenflussEimer(Instant bucket, Double pvKw, Double battKw, Double gridKw,
            boolean hatNetz, Double socPct) {}

    private final JdbcTemplate jdbc;

    public ProbelaufRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Reihe einer einzelnen Komponente+Kanal (Familie {@code geraet.messwert}). */
    List<ProbelaufSimulation.Punkt> messreihe(UUID anlageId, String komponenteId, String kanal, Instant von,
            Instant bis) {
        return jdbc.query("""
                SELECT bucket, avg_value FROM telemetry_v2_rollup_15m
                 WHERE site_id = ? AND entity_id = ? AND channel = ? AND bucket >= ? AND bucket < ?
                 ORDER BY bucket
                """,
                (rs, n) -> punkt(rs.getTimestamp("bucket").toInstant(), wertOderNull(rs, "avg_value"), "kW"),
                anlageId, komponenteId, kanal, Timestamp.from(von), Timestamp.from(bis));
    }

    /** Die Reihe eines {@code anlagenfluss}-Felds (netz, pv, speicher_leistung, speicher_ladestand, verbrauch). */
    List<ProbelaufSimulation.Punkt> anlagenfluss(UUID anlageId, String feld, Instant von, Instant bis) {
        List<AnlagenflussEimer> eimer = jdbc.query("""
                WITH typed AS (
                    SELECT r.bucket, r.channel, r.avg_value, mp.entity_type
                      FROM telemetry_v2_rollup_15m r
                      LEFT JOIN measurement_point mp ON mp.id::text = r.entity_id
                     WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ?
                )
                SELECT bucket,
                       sum(avg_value) FILTER (WHERE channel = 'pv_power_kw') AS pv_kw,
                       sum(avg_value) FILTER (WHERE channel = 'battery_power_kw') AS batt_kw,
                       sum(avg_value) FILTER (WHERE channel = 'power_kw' AND entity_type = 'grid-meter') AS grid_kw,
                       bool_or(channel = 'power_kw' AND entity_type = 'grid-meter') AS hat_netz,
                       avg(avg_value) FILTER (WHERE channel = 'soc_pct') AS soc_pct
                  FROM typed GROUP BY bucket ORDER BY bucket
                """,
                ProbelaufRepository::eimer, anlageId, Timestamp.from(von), Timestamp.from(bis));
        return eimer.stream().map(e -> feldAusEimer(e, feld)).filter(java.util.Objects::nonNull).toList();
    }

    private static ProbelaufSimulation.Punkt feldAusEimer(AnlagenflussEimer e, String feld) {
        Double wert = switch (feld) {
            case "pv" -> e.pvKw();
            case "speicher_leistung" -> e.battKw();
            case "speicher_ladestand" -> e.socPct();
            case "netz" -> e.hatNetz() ? e.gridKw() : null;
            case "verbrauch" -> e.hatNetz()
                    ? nullSicherSumme(e.gridKw()) + nullSicherSumme(e.pvKw()) - nullSicherSumme(e.battKw())
                    : null;
            default -> null; // ladepunkte/preis: kein Probelauf in dieser Runde (kein Rollup dafür)
        };
        return punkt(e.bucket(), wert, "verbrauch".equals(feld) || "netz".equals(feld)
                || "pv".equals(feld) || "speicher_leistung".equals(feld) ? "kW" : "%");
    }

    private static double nullSicherSumme(Double x) {
        return x == null ? 0 : x;
    }

    private static ProbelaufSimulation.Punkt punkt(Instant zeit, Double wert, String einheit) {
        WerteLeser.Lesung lesung = wert == null ? WerteLeser.Lesung.unbekannt() : WerteLeser.Lesung.zahl(wert, einheit, zeit);
        return new ProbelaufSimulation.Punkt(zeit, lesung);
    }

    private static Double wertOderNull(ResultSet rs, String spalte) throws SQLException {
        double v = rs.getDouble(spalte);
        return rs.wasNull() ? null : v;
    }

    private static AnlagenflussEimer eimer(ResultSet rs, int n) throws SQLException {
        return new AnlagenflussEimer(rs.getTimestamp("bucket").toInstant(), wertOderNull(rs, "pv_kw"),
                wertOderNull(rs, "batt_kw"), wertOderNull(rs, "grid_kw"), rs.getBoolean("hat_netz"),
                wertOderNull(rs, "soc_pct"));
    }
}
