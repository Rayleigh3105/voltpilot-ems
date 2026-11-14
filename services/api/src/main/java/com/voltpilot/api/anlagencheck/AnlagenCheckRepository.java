package com.voltpilot.api.anlagencheck;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Was der Anlagen-Check liest (Bedienkonzept vp-privatkunde-bedienkonzept §6.6). RLS-gebunden wie jede Kunden-Route;
 * jede Abfrage auf Messdaten geht über {@code site} (Standort-Zaun, {@code SiteScopeArchitekturTest}), der Service
 * prüft die Anlage vorher ({@code geltungsbereich.requireSite}).
 */
@Repository
public class AnlagenCheckRepository {

    /** Der Vortagsvergleich - derselbe Vorlauf wie das Blatt „Rückblick". */
    static final int LEAD_DAYS = 1;

    private final JdbcTemplate jdbc;

    public AnlagenCheckRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ort und Stammzahlen der Anlage; {@code null}, wenn sie (für diesen Mandanten) nicht da ist. */
    public record Stamm(Double breite, Double laenge, Double pvKwp, Double speicherKwh) {}

    public Stamm stamm(UUID siteId) {
        List<Stamm> rows = jdbc.query(
                "SELECT s.latitude, s.longitude, "
                        + "(SELECT a.pv_capacity_kwp FROM asset a WHERE a.site_id = s.id AND a.type = 'pv' "
                        + "  AND a.is_primary ORDER BY a.created_at DESC LIMIT 1) AS pv_kwp, "
                        + "coalesce((SELECT a.capacity_kwh FROM asset a WHERE a.site_id = s.id AND a.type = 'battery' "
                        + "  AND a.is_primary ORDER BY a.created_at DESC LIMIT 1), "
                        + " (SELECT sum(re.speicher_kwh) FROM register_einheit re WHERE re.site_id = s.id "
                        + "  AND re.art = 'speicher' AND re.bestaetigt_am IS NOT NULL)) AS speicher_kwh "
                        + "FROM site s WHERE s.id = ?",
                (rs, i) -> new Stamm(dbl(rs.getBigDecimal("latitude")), dbl(rs.getBigDecimal("longitude")),
                        dbl(rs.getBigDecimal("pv_kwp")), dbl(rs.getBigDecimal("speicher_kwh"))),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Eine bestätigte PV-Einheit. */
    public record Einheit(UUID id, String bezeichnung, LocalDate inbetriebnahme, Double kwp) {}

    public List<Einheit> pvEinheiten(UUID siteId) {
        return jdbc.query(
                "SELECT re.id, re.bezeichnung, re.inbetriebnahme, re.leistung_kwp FROM register_einheit re "
                        + "WHERE re.site_id = ? AND re.art = 'pv' AND re.bestaetigt_am IS NOT NULL "
                        + "ORDER BY re.inbetriebnahme NULLS LAST, re.created_at, re.id",
                (rs, i) -> new Einheit(rs.getObject("id", UUID.class), rs.getString("bezeichnung"),
                        rs.getObject("inbetriebnahme", LocalDate.class), dbl(rs.getBigDecimal("leistung_kwp"))),
                siteId);
    }

    /**
     * Ein zugeordnetes Gerät mit dem Schlüssel seiner Messreihe ({@code telemetry_v2.entity_id}): ein Messpunkt ist
     * selbst die Komponente; eine Erzeugungseinheit der Anlagensteuerung über die Komponente, die sie gerade speist.
     * {@code entityId == null}: das Gerät hat keine eigene Messreihe.
     */
    public record Zuordnung(UUID einheitId, String entityId, String name) {}

    public List<Zuordnung> zuordnungen(UUID siteId) {
        return jdbc.query(
                "SELECT eg.einheit_id, coalesce(mp.id::text, gk.entity_id::text) AS entity_id, "
                        + "coalesce(mp.label, mp.brand || ' ' || mp.model, gt.bezeichnung, gt.typ_bild, "
                        + "  'Erzeugungseinheit ' || gt.te_nr) AS name "
                        + "FROM einheit_geraet eg "
                        + "JOIN register_einheit re ON re.id = eg.einheit_id AND re.site_id = ? "
                        + "LEFT JOIN measurement_point mp ON mp.id = eg.measurement_point_id "
                        + "LEFT JOIN geraet_teil gt ON gt.id = eg.geraet_teil_id "
                        + "LEFT JOIN LATERAL (SELECT k.entity_id FROM geraet_komponente k WHERE k.teil_id = gt.id "
                        + "  AND k.gueltig_bis IS NULL ORDER BY k.gueltig_ab DESC LIMIT 1) gk ON TRUE "
                        + "ORDER BY eg.created_at, eg.id",
                (rs, i) -> new Zuordnung(rs.getObject("einheit_id", UUID.class), rs.getString("entity_id"),
                        rs.getString("name")),
                siteId);
    }

    /** Die Erwartung je Einheit und Tag des Modells (A1, {@code solar_erwartung_einheit}). */
    public Map<UUID, Map<LocalDate, Double>> erwartung(UUID siteId, String model, LocalDate von, LocalDate bis) {
        Map<UUID, Map<LocalDate, Double>> out = new HashMap<>();
        jdbc.query(
                "SELECT einheit_id, day, erwartet_kwh FROM solar_erwartung_einheit "
                        + "WHERE site_id = ? AND model = ? AND lead_days = ? AND day >= ? AND day <= ?",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> {
                    out.computeIfAbsent(rs.getObject("einheit_id", UUID.class), k -> new HashMap<>())
                            .put(rs.getObject("day", LocalDate.class), rs.getBigDecimal("erwartet_kwh").doubleValue());
                },
                siteId, model, LEAD_DAYS, von, bis);
        return out;
    }

    /** Die Stundenmittel der PV-Leistung (kW = kWh der Stunde) je Messreihe in [from, to). */
    public Map<String, Map<Instant, Double>> pvStunden(UUID siteId, List<String> entityIds, Instant from,
            Instant to) {
        Map<String, Map<Instant, Double>> out = new HashMap<>();
        if (entityIds.isEmpty()) {
            return out;
        }
        jdbc.query(
                "SELECT r.entity_id, r.bucket, r.avg_value FROM telemetry_v2_rollup_1h r "
                        + "JOIN site s ON s.id = r.site_id "
                        + "WHERE r.site_id = ? AND r.entity_id = ANY (?) AND r.channel = 'pv_power_kw' "
                        + "AND r.bucket >= ? AND r.bucket < ? AND r.avg_value IS NOT NULL",
                ps -> {
                    ps.setObject(1, siteId);
                    ps.setArray(2, ps.getConnection().createArrayOf("text", entityIds.toArray()));
                    ps.setTimestamp(3, Timestamp.from(from));
                    ps.setTimestamp(4, Timestamp.from(to));
                },
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> {
                    out.computeIfAbsent(rs.getString("entity_id"), k -> new HashMap<>())
                            .put(rs.getTimestamp("bucket").toInstant(), rs.getDouble("avg_value"));
                });
        return out;
    }

    /** Ein Tag der ganzen Anlage aus {@code forecast_rueckblick}. */
    public record AnlageTag(LocalDate tag, double erwartetKwh, double gemessenKwh) {}

    public List<AnlageTag> anlageTage(UUID siteId, String model, LocalDate von, LocalDate bis) {
        return jdbc.query(
                "SELECT day, erwartet_kwh, gemessen_kwh FROM forecast_rueckblick "
                        + "WHERE site_id = ? AND kind = 'pv' AND model = ? AND lead_days = ? AND day >= ? AND day <= ? "
                        + "ORDER BY day",
                (rs, i) -> new AnlageTag(rs.getObject("day", LocalDate.class),
                        rs.getBigDecimal("erwartet_kwh").doubleValue(), rs.getBigDecimal("gemessen_kwh").doubleValue()),
                siteId, model, LEAD_DAYS, von, bis);
    }

    /** Was der Speicher vor {@code vor} je abgegeben hat (v1-Tagesrollup) - für „Vollzyklen seit Beginn". */
    public double herausVor(UUID siteId, Instant vor) {
        BigDecimal v = jdbc.queryForObject(
                "SELECT sum(r.battery_discharge_kwh) FROM telemetry_rollup_1d r JOIN site s ON s.id = r.site_id "
                        + "WHERE r.site_id = ? AND r.bucket < ?",
                BigDecimal.class, siteId, Timestamp.from(vor));
        return v == null ? 0 : v.doubleValue();
    }

    static List<String> entityIds(List<Zuordnung> z) {
        List<String> ids = new ArrayList<>();
        for (Zuordnung x : z) {
            if (x.entityId() != null && !ids.contains(x.entityId())) {
                ids.add(x.entityId());
            }
        }
        return ids;
    }

    private static Double dbl(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }
}
