package com.voltpilot.api.uems;

import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Datenquellen des Kundenbereichs ({@code data_source}, Migration
 * V20260911150000) — unter RLS: eine fremde Quelle ist hier schlicht nicht da,
 * die Route macht daraus 404, nie 403.
 *
 * <p>Nur der Unterbau. Die Regeln des Anlegens — Protokoll, Eindeutigkeit je
 * Box, Doppel-Lesen, Prüfung von genau der Ziel-Box — prüft der Schreibweg mit
 * {@link DatenquelleRegeln} (IP-3), bevor er hier schreibt. Die Datenbank hält
 * trotzdem selbst, was sie halten kann: das Protokoll-Vokabular, die Form des
 * Kennzeichens, die Kennzeichen je Kundenbereich eindeutig. Eine Quelle wird
 * archiviert, nie gelöscht: deshalb gibt es hier kein DELETE, und die App-Rolle
 * hat keines.
 */
@Repository
public class DatenquelleRepository {

    private static final String SPALTEN = "id, site_id, kennzeichen, name, protokoll, adresse, "
            + "geraete_ids, netz, mehrere_leser, steuerquelle, kadenz_s, archiviert_am";

    private final JdbcTemplate jdbc;

    public DatenquelleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Eine neue Quelle, alle Werte so, wie sie gespeichert werden: das Protokoll
     * als CODE ({@code modbus_tcp}), die Adresse normalisiert (Vertrag §3 Nr. 5),
     * die Geräte-IDs aufsteigend. Das Kennzeichen vergibt die Datenbank.
     */
    public record NeueDatenquelle(UUID tenantId, UUID siteId, String name, String protokoll,
            String adresse, List<Integer> geraeteIds, String netz, boolean mehrereLeser,
            boolean steuerquelle, int kadenzS, String createdBy) {}

    /** {@code name} und {@code netz} sind {@code null}, solange keiner eingetragen ist. */
    public record Datenquelle(UUID id, UUID siteId, String kennzeichen, String name,
            String protokoll, String adresse, List<Integer> geraeteIds, String netz,
            boolean mehrereLeser, boolean steuerquelle, int kadenzS, Instant archiviertAm) {}

    /**
     * Legt die Quelle an und vergibt ihr das nächste freie Kennzeichen DQ-n des
     * Kundenbereichs ({@code uems_datenquelle_kennzeichen}) — in derselben
     * Anweisung, also rückt der Zähler nur vor, wenn die Quelle gespeichert ist.
     */
    public Datenquelle anlegen(NeueDatenquelle q) {
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement("INSERT INTO data_source (tenant_id, "
                    + "site_id, kennzeichen, name, protokoll, adresse, geraete_ids, netz, "
                    + "mehrere_leser, steuerquelle, kadenz_s, created_by) "
                    + "VALUES (?,?,uems_datenquelle_kennzeichen(?),?,?,?,?,?,?,?,?,?) "
                    + "RETURNING " + SPALTEN);
            ps.setObject(1, q.tenantId());
            ps.setObject(2, q.siteId());
            ps.setObject(3, q.tenantId());
            ps.setString(4, q.name());
            ps.setString(5, q.protokoll());
            ps.setString(6, q.adresse());
            ps.setArray(7, con.createArrayOf("integer", q.geraeteIds().toArray(Integer[]::new)));
            ps.setString(8, q.netz());
            ps.setBoolean(9, q.mehrereLeser());
            ps.setBoolean(10, q.steuerquelle());
            ps.setInt(11, q.kadenzS());
            ps.setString(12, q.createdBy());
            return ps;
        }, rs -> {
            rs.next();
            return map(rs, 0);
        });
    }

    /** Die Quelle im Zaun — leer, wenn es sie nicht gibt ODER sie einem anderen Mandanten gehört. */
    public Optional<Datenquelle> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM data_source WHERE id = ?",
                DatenquelleRepository::map, id).stream().findFirst();
    }

    /** Alle Quellen des Mandanten, archivierte eingeschlossen, in der Reihenfolge des Anlegens. */
    public List<Datenquelle> alle() {
        return List.copyOf(jdbc.query(
                "SELECT " + SPALTEN + " FROM data_source ORDER BY created_at, id",
                DatenquelleRepository::map));
    }

    private static Datenquelle map(ResultSet rs, int n) throws SQLException {
        Array geraete = rs.getArray("geraete_ids");
        Timestamp archiviert = rs.getTimestamp("archiviert_am");
        return new Datenquelle(
                rs.getObject("id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("kennzeichen"),
                rs.getString("name"),
                rs.getString("protokoll"),
                rs.getString("adresse"),
                List.of((Integer[]) geraete.getArray()),
                rs.getString("netz"),
                rs.getBoolean("mehrere_leser"),
                rs.getBoolean("steuerquelle"),
                rs.getInt("kadenz_s"),
                archiviert == null ? null : archiviert.toInstant());
    }
}
