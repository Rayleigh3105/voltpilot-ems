package com.voltpilot.api.mispel;

import com.voltpilot.api.mispel.FoerderwegRegeln.Angaben;
import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Fassungen des Förderwegs ({@code site_foerderweg}, V20261002141500) und die beiden Spiegel-Spalten der Anlage
 * ({@code site.netzladen_erlaubt}, {@code site.plant_kind}), alles unter RLS. Eine Fassung wird nie gelöscht und nie
 * umgeschrieben: die App-Rolle darf nur {@code aufgehoben_am} setzen.
 */
@Repository
public class FoerderwegRepository {

    private static final String SELECT = "SELECT id, site_id, foerderweg, formelsatz, einverstaendnis, aw_regel, "
            + "gueltig_ab, aufgehoben_am, created_at, created_by FROM site_foerderweg ";

    private final JdbcTemplate jdbc;

    public FoerderwegRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Fassung, wie sie gespeichert ist. */
    public record Fassung(UUID id, UUID siteId, Angaben angaben, LocalDate gueltigAb, Instant aufgehobenAm,
            Instant eingetragenAm, String eingetragenVon) {
        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }
    }

    /** Die heutigen Schalter der Anlage; leer für eine fremde oder unbekannte (RLS). */
    public record Schalter(UUID tenantId, boolean netzladenErlaubt, String plantKind) {}

    /** Die Fassungen EINER Anlage, aufgehobene eingeschlossen — leer für eine fremde. */
    public List<Fassung> derAnlage(UUID siteId) {
        return List.copyOf(jdbc.query(SELECT + "WHERE site_id = ? ORDER BY gueltig_ab, created_at, id",
                FoerderwegRepository::fassung, siteId));
    }

    public Optional<Schalter> schalter(UUID siteId) {
        return jdbc.query("SELECT tenant_id, netzladen_erlaubt, plant_kind FROM site WHERE id = ?",
                (rs, n) -> new Schalter(rs.getObject("tenant_id", UUID.class), rs.getBoolean("netzladen_erlaubt"),
                        rs.getString("plant_kind")), siteId).stream().findFirst();
    }

    /** Sperrt die Anlage bis zum Ende der Transaktion — zwei Fassungen derselben Anlage reihen sich. */
    public Optional<Schalter> schalterSperren(UUID siteId) {
        return jdbc.query("SELECT tenant_id, netzladen_erlaubt, plant_kind FROM site WHERE id = ? FOR UPDATE",
                (rs, n) -> new Schalter(rs.getObject("tenant_id", UUID.class), rs.getBoolean("netzladen_erlaubt"),
                        rs.getString("plant_kind")), siteId).stream().findFirst();
    }

    public UUID eintragen(UUID tenantId, UUID siteId, Angaben a, LocalDate gueltigAb, String von) {
        return jdbc.queryForObject("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, "
                + "einverstaendnis, aw_regel, gueltig_ab, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, siteId, a.foerderweg().wert(), a.formelsatz(), a.einverstaendnis(), a.awRegel(),
                gueltigAb, von);
    }

    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE site_foerderweg SET aufgehoben_am = ? WHERE id = ? AND aufgehoben_am IS NULL",
                Timestamp.from(am), id) == 1;
    }

    /** Hält die Spiegel nach; {@code plantKind} {@code null} = bleibt, wie es ist. */
    public void spiegeln(UUID siteId, boolean netzladenErlaubt, String plantKind) {
        jdbc.update("UPDATE site SET netzladen_erlaubt = ?, plant_kind = COALESCE(?, plant_kind) WHERE id = ?",
                netzladenErlaubt, plantKind, siteId);
    }

    private static Fassung fassung(ResultSet rs, int n) throws SQLException {
        Timestamp auf = rs.getTimestamp("aufgehoben_am");
        Foerderweg weg = Foerderweg.von(rs.getString("foerderweg")).orElseThrow();
        return new Fassung(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                new Angaben(weg, rs.getString("formelsatz"), rs.getBoolean("einverstaendnis"), rs.getString("aw_regel")),
                rs.getDate("gueltig_ab").toLocalDate(), auf == null ? null : auf.toInstant(),
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"));
    }
}
