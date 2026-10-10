package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Das Protokoll der Sprungprobe ({@code steuerungsverbund_sprungprobe}, V20260922080000; UEMS AP-15 IP-21) und der
 * Netzpunkt der führenden Box in Sekundenauflösung ({@code telemetry.power_kw}, + Bezug / − Einspeisung). Alles unter
 * RLS des Mandanten.
 */
@Repository
public class SprungprobeRepository {

    /** Eine Probe, wie sie im Protokoll steht. */
    public record Probe(UUID id, UUID tenantId, UUID verbundId, UUID siteId, UUID box, UUID fuehrendeBox, String art,
            BigDecimal sprungKw, int dauerS, int wiederholungen, Instant ausgeloestAm, Instant gueltigBis,
            String urteil, String grund, Instant ausgewertetAm, Instant entwertetAm) {}

    /** Mittel des Netzpunkts im Fenster und die Zahl der Werte darin. */
    public record Mittel(BigDecimal kw, int werte) {}

    private static final String SPALTEN = "id, tenant_id, steuerungsverbund_id, site_id, device_id, fuehrende_box_id, "
            + "art, sprung_kw, dauer_s, wiederholungen, ausgeloest_am, gueltig_bis, urteil, grund, ausgewertet_am, "
            + "entwertet_am";

    private final JdbcTemplate jdbc;

    public SprungprobeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public UUID anlegen(UUID tenant, UUID verbundId, UUID siteId, UUID box, UUID fuehrendeBox,
            SprungprobeRegel.Art art, BigDecimal sprungKw, Instant am, Instant gueltigBis, ProtokollAkteur wer) {
        return jdbc.queryForObject("INSERT INTO steuerungsverbund_sprungprobe (tenant_id, steuerungsverbund_id, "
                + "site_id, device_id, fuehrende_box_id, art, sprung_kw, dauer_s, wiederholungen, ausgeloest_am, "
                + "gueltig_bis, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenant, verbundId, siteId, box,
                fuehrendeBox, art.code(), sprungKw, SprungprobeRegel.DAUER_S, SprungprobeRegel.WIEDERHOLUNGEN,
                Timestamp.from(am), Timestamp.from(gueltigBis), wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    public Optional<Probe> finden(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_sprungprobe WHERE id = ?", PROBE, id)
                .stream().findFirst();
    }

    /** Die jüngste Probe der Box in diesem Verbund, in jedem Zustand. */
    public Optional<Probe> letzte(UUID verbundId, UUID box) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_sprungprobe WHERE steuerungsverbund_id = ? "
                + "AND device_id = ? ORDER BY ausgeloest_am DESC, created_at DESC LIMIT 1", PROBE, verbundId, box)
                .stream().findFirst();
    }

    /** Die jüngste AUSGEWERTETE, nicht entwertete Probe der Box — sie allein zählt für die Naht (T5). */
    public Optional<Probe> geltende(UUID verbundId, UUID box) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_sprungprobe WHERE steuerungsverbund_id = ? "
                + "AND device_id = ? AND urteil <> 'ausgeloest' AND entwertet_am IS NULL "
                + "ORDER BY ausgeloest_am DESC, created_at DESC LIMIT 1", PROBE, verbundId, box).stream().findFirst();
    }

    /** Ein Protokoll-Eintrag für das Betreiber-Blatt (IP-24): die Probe und ihre Messwerte je Sprung (JSON, oder null). */
    public record Eintrag(Probe probe, String messwerte) {}

    /** Alle Proben des Verbunds, jüngste zuerst, höchstens {@code grenze} — das Protokoll wird nie gelöscht. */
    public List<Eintrag> protokoll(UUID verbundId, int grenze) {
        return jdbc.query("SELECT " + SPALTEN + ", messwerte::text AS messwerte_text FROM steuerungsverbund_sprungprobe "
                + "WHERE steuerungsverbund_id = ? ORDER BY ausgeloest_am DESC, created_at DESC LIMIT ?",
                (rs, n) -> new Eintrag(PROBE.mapRow(rs, n), rs.getString("messwerte_text")), verbundId, grenze);
    }

    /** Läuft in diesem Verbund eine Probe, ausgelöst nach {@code seit} und noch ohne Bericht? */
    public boolean laeuft(UUID verbundId, Instant seit) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM steuerungsverbund_sprungprobe "
                + "WHERE steuerungsverbund_id = ? AND urteil = 'ausgeloest' AND ausgeloest_am > ?)", Boolean.class,
                verbundId, Timestamp.from(seit)));
    }

    /** Schreibt das Urteil genau einmal; false, wenn die Probe schon ausgewertet ist. */
    public boolean auswerten(UUID id, String urteil, String grund, String berichtJson, String messwerteJson,
            Instant am) {
        return jdbc.update("UPDATE steuerungsverbund_sprungprobe SET urteil = ?, grund = ?, bericht = ?::jsonb, "
                + "messwerte = ?::jsonb, ausgewertet_am = ? WHERE id = ? AND urteil = 'ausgeloest'", urteil, grund,
                berichtJson, messwerteJson, Timestamp.from(am), id) > 0;
    }

    /** Entwertet alle noch geltenden Proben der Boxen (I3); die Zahl der entwerteten. */
    public int entwerten(UUID verbundId, Collection<UUID> boxen, Instant am, String grund) {
        int n = 0;
        for (UUID box : boxen) {
            n += jdbc.update("UPDATE steuerungsverbund_sprungprobe SET entwertet_am = ?, entwertet_grund = ? "
                    + "WHERE steuerungsverbund_id = ? AND device_id = ? AND entwertet_am IS NULL",
                    Timestamp.from(am), grund, verbundId, box);
        }
        return n;
    }

    /** Das Mittel von {@code telemetry.power_kw} der Box im Fenster [von, bis) — der Netzpunkt der führenden Box. */
    public Mittel netzpunkt(UUID siteId, UUID box, Instant von, Instant bis) {
        return jdbc.queryForObject("SELECT avg(power_kw) AS kw, count(power_kw) AS werte FROM telemetry "
                + "WHERE site_id = ? AND device_id = ? AND time >= ? AND time < ?",
                (rs, n) -> new Mittel(rs.getBigDecimal("kw"), rs.getInt("werte")), siteId, box, Timestamp.from(von),
                Timestamp.from(bis));
    }

    /** Hat der Netzpunkt der Box einen Wert in [seit, bis]? */
    public boolean netzpunktFrisch(UUID siteId, UUID box, Instant seit, Instant bis) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM telemetry WHERE site_id = ? "
                + "AND device_id = ? AND time >= ? AND time <= ? AND power_kw IS NOT NULL)", Boolean.class, siteId,
                box, Timestamp.from(seit), Timestamp.from(bis)));
    }

    private static final RowMapper<Probe> PROBE = (rs, n) -> new Probe(rs.getObject("id", UUID.class),
            rs.getObject("tenant_id", UUID.class), rs.getObject("steuerungsverbund_id", UUID.class),
            rs.getObject("site_id", UUID.class), rs.getObject("device_id", UUID.class),
            rs.getObject("fuehrende_box_id", UUID.class), rs.getString("art"), rs.getBigDecimal("sprung_kw"),
            rs.getInt("dauer_s"), rs.getInt("wiederholungen"), instant(rs, "ausgeloest_am"),
            instant(rs, "gueltig_bis"), rs.getString("urteil"), rs.getString("grund"), instant(rs, "ausgewertet_am"),
            instant(rs, "entwertet_am"));

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    List<Probe> alleDesVerbunds(UUID verbundId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM steuerungsverbund_sprungprobe WHERE steuerungsverbund_id = ? "
                + "ORDER BY ausgeloest_am", PROBE, verbundId);
    }
}
