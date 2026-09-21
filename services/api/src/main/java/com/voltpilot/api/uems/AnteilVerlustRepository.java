package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Anteils-Verlust je Box und Tag (UEMS AP-15 IP-22, E1 = A, R2; {@code steuerungsverbund_anteil_verlust},
 * V20260922050000). Geschrieben nur vom {@link AnteilVerlustAusHerzschlag} unter dem {@code TenantContext} des
 * Herzschlags, gelesen von der Auskunft {@code GET …/gemeinsame-steuerung} je Mitglied. Die Spalten der SCHÄTZUNG
 * ({@code schaetzung_kwh}, {@code schaetzung_grundlage}, V20260922130000) schreibt nur {@link AnteilVerlustSchaetzung}.
 */
@Repository
public class AnteilVerlustRepository {

    /**
     * Summe über die gemeldeten Tage: kWh (Untergrenze), Sekunden, in denen der Anteil band, und wie viele Tage; dazu
     * die Summe der Schätzung über die {@code tageGeschaetzt} Tage, die eine haben ({@code null}, wenn keiner).
     */
    public record Summe(BigDecimal kwh, long gebundenS, int tage, BigDecimal schaetzungKwh, int tageGeschaetzt) {}

    /**
     * Je Box die Summen eines Zeitraums für den Pilot-Bericht: gemeldete Tage, Sekunden, Untergrenze; Schätzung über
     * die {@code tageGeschaetzt} Tage mit einer; {@code tageOhnePrognose} (Grundlage {@code keine}) und
     * {@code tageNichtGerechnet} (noch leer) zählen, was in der Schätzungs-Summe FEHLT.
     */
    public record BerichtZeile(UUID deviceId, int tage, long gebundenS, BigDecimal verlustKwh, BigDecimal schaetzungKwh,
            int tageGeschaetzt, int tageOhnePrognose, int tageNichtGerechnet) {}

    /** Ein gemeldeter Tag einer Box, wie ihn die Schätzung liest und die Betreiber-Zeile zeigt. */
    public record Tag(UUID deviceId, LocalDate tag, BigDecimal verlustKwh, int gebundenS, BigDecimal schaetzungKwh,
            String schaetzungGrundlage) {}

    private final JdbcTemplate jdbc;

    public AnteilVerlustRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Der Stand eines Tages. Der Zähler der Box wächst innerhalb des Tages nur — darum gilt das Größere, eine
     * verspätete oder doppelt zugestellte Nachricht senkt nichts.
     */
    public void melde(UUID tenantId, UUID siteId, UUID deviceId, LocalDate tag, BigDecimal kwh, int gebundenS) {
        jdbc.update("INSERT INTO steuerungsverbund_anteil_verlust (tenant_id, site_id, device_id, tag, verlust_kwh, "
                + "gebunden_s) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, tag) DO UPDATE SET "
                + "verlust_kwh = GREATEST(steuerungsverbund_anteil_verlust.verlust_kwh, EXCLUDED.verlust_kwh), "
                + "gebunden_s = GREATEST(steuerungsverbund_anteil_verlust.gebunden_s, EXCLUDED.gebunden_s), "
                + "gemeldet_am = now()", tenantId, siteId, deviceId, tag, kwh, gebundenS);
    }

    /** Die Summe der Box an der Anlage über {@code [von, bis]} (Tage der Anlage); leer, wenn kein Tag gemeldet ist. */
    public Optional<Summe> summe(UUID siteId, UUID deviceId, LocalDate von, LocalDate bis) {
        return jdbc.query("SELECT sum(verlust_kwh) AS kwh, sum(gebunden_s) AS s, count(*) AS n, "
                        + "sum(schaetzung_kwh) AS sk, count(schaetzung_kwh) AS sn "
                        + "FROM steuerungsverbund_anteil_verlust WHERE site_id = ? AND device_id = ? "
                        + "AND tag BETWEEN ? AND ?",
                rs -> {
                    if (!rs.next() || rs.getInt("n") == 0) {
                        return Optional.<Summe>empty();
                    }
                    return Optional.of(new Summe(rs.getBigDecimal("kwh"), rs.getLong("s"), rs.getInt("n"),
                            rs.getBigDecimal("sk"), rs.getInt("sn")));
                }, siteId, deviceId, von, bis);
    }

    /** Die Summen je Box der Anlage über {@code [von, bis]} (Tage der Anlage), für den Pilot-Bericht. */
    public List<BerichtZeile> bericht(UUID siteId, LocalDate von, LocalDate bis) {
        return jdbc.query("SELECT device_id, count(*) AS n, sum(gebunden_s) AS s, sum(verlust_kwh) AS kwh, "
                        + "sum(schaetzung_kwh) AS sk, count(schaetzung_kwh) AS sn, "
                        + "count(*) FILTER (WHERE schaetzung_grundlage = 'keine') AS keine, "
                        + "count(*) FILTER (WHERE schaetzung_grundlage IS NULL) AS offen "
                        + "FROM steuerungsverbund_anteil_verlust WHERE site_id = ? AND tag BETWEEN ? AND ? "
                        + "GROUP BY device_id ORDER BY device_id",
                (rs, n) -> new BerichtZeile(rs.getObject("device_id", UUID.class), rs.getInt("n"), rs.getLong("s"),
                        rs.getBigDecimal("kwh"), rs.getBigDecimal("sk"), rs.getInt("sn"), rs.getInt("keine"),
                        rs.getInt("offen")),
                siteId, von, bis);
    }

    /** Die gemeldeten Tage der Anlage über {@code [von, bis]}, je Box und Tag. */
    public List<Tag> tage(UUID siteId, LocalDate von, LocalDate bis) {
        return jdbc.query("SELECT device_id, tag, verlust_kwh, gebunden_s, schaetzung_kwh, schaetzung_grundlage "
                        + "FROM steuerungsverbund_anteil_verlust WHERE site_id = ? AND tag BETWEEN ? AND ? "
                        + "ORDER BY device_id, tag",
                (rs, n) -> new Tag(rs.getObject("device_id", UUID.class), rs.getObject("tag", LocalDate.class),
                        rs.getBigDecimal("verlust_kwh"), rs.getInt("gebunden_s"), rs.getBigDecimal("schaetzung_kwh"),
                        rs.getString("schaetzung_grundlage")),
                siteId, von, bis);
    }

    /**
     * Setzt die Schätzung eines Tages — und NUR sie: Untergrenze und Sekunden der Box bleiben, wie gemeldet. Idempotent;
     * {@code kwh} ist bei {@code keine} leer (unbekannt ist keine Null).
     */
    public void schaetzungSetzen(UUID deviceId, LocalDate tag, BigDecimal kwh, String grundlage) {
        jdbc.update("UPDATE steuerungsverbund_anteil_verlust SET schaetzung_kwh = ?, schaetzung_grundlage = ? "
                + "WHERE device_id = ? AND tag = ?", kwh, grundlage, deviceId, tag);
    }

    /**
     * Die PV-Prognose der Anlage je Viertelstunde in {@code [von, bis)}: der jüngste Wert des Modells, der VOR seinem
     * Zeitpunkt ausgegeben wurde ({@code run_at < time} — die Regel der Prognosebewertung und des Planlaufs); negative
     * Werte zählen als 0. {@code forecast} trägt keine RLS, der Zaun ist der Weg über {@code site}.
     */
    public Map<Instant, Double> pvPrognose(UUID siteId, String modell, Instant von, Instant bis) {
        Map<Instant, Double> je = new HashMap<>();
        jdbc.query("SELECT DISTINCT ON (f.time) f.time, f.value_kw FROM forecast f JOIN site s ON s.id = f.site_id "
                        + "WHERE f.site_id = ? AND f.kind = 'pv' AND f.model = ? AND f.time >= ? AND f.time < ? "
                        + "AND f.run_at < f.time ORDER BY f.time, f.run_at DESC",
                rs -> {
                    je.put(rs.getTimestamp(1).toInstant(), Math.max(rs.getDouble(2), 0.0));
                }, siteId, modell, Timestamp.from(von), Timestamp.from(bis));
        return je;
    }

    /** Die Nennleistung der PV je Box an der Anlage ({@code asset.pv_capacity_kwp} je {@code device_id}, wie IP-14). */
    public Map<UUID, Double> pvKwpJeBox(UUID siteId) {
        Map<UUID, Double> je = new HashMap<>();
        jdbc.query("SELECT a.device_id, sum(a.pv_capacity_kwp) FROM asset a JOIN site s ON s.id = a.site_id "
                        + "WHERE a.site_id = ? AND a.type = 'pv' AND a.pv_capacity_kwp > 0 AND a.device_id IS NOT NULL "
                        + "GROUP BY a.device_id",
                rs -> {
                    je.put(rs.getObject(1, UUID.class), rs.getDouble(2));
                }, siteId);
        return je;
    }

    /** Die gemessene PV der Box je Viertelstunde in {@code [von, bis)} (Mittel von {@code telemetry.pv_power_kw}). */
    public Map<Instant, Double> gemesseneViertelstunden(UUID siteId, UUID deviceId, Instant von, Instant bis) {
        Map<Instant, Double> je = new HashMap<>();
        jdbc.query("SELECT time_bucket('15 minutes', t.time) AS b, avg(t.pv_power_kw) FROM telemetry t "
                        + "JOIN site s ON s.id = t.site_id WHERE t.site_id = ? AND t.device_id = ? AND t.time >= ? "
                        + "AND t.time < ? AND t.pv_power_kw IS NOT NULL GROUP BY b",
                rs -> {
                    je.put(rs.getTimestamp(1).toInstant(), rs.getDouble(2));
                }, siteId, deviceId, Timestamp.from(von), Timestamp.from(bis));
        return je;
    }
}
