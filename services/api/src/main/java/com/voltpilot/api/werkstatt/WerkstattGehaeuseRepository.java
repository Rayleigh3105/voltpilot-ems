package com.voltpilot.api.werkstatt;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Box-Druckdatei des Gehäuses ({@code werkstatt_gehaeuse_datei}, Migration
 * V20261106160000, vp-mango-3mf-pro-box): an der BYPASSRLS-Rolle
 * {@code voltpilot_admin}, dasselbe Muster wie {@link WerkstattRepository}.
 * Eine Zeile je Box; ein wiederholter Upload überschreibt mit dem neueren
 * Stand.
 */
@Repository
public class WerkstattGehaeuseRepository {

    /** Stand ohne die Bytes (für die Karte und die Liste der Boxen). */
    public record Stand(String name, String sha256, long bytes, Instant hochgeladenAm) {
    }

    /** Stand mit den Bytes (für den Download). */
    public record Datei(String name, String sha256, long bytes, byte[] daten) {
    }

    private final JdbcTemplate jdbc;

    public WerkstattGehaeuseRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public Optional<Stand> stand(String edgeRef) {
        return jdbc.query("SELECT name, sha256, bytes, hochgeladen_am FROM werkstatt_gehaeuse_datei "
                + "WHERE edge_ref = ?", WerkstattGehaeuseRepository::stand, edgeRef).stream().findFirst();
    }

    public Optional<Datei> datei(String edgeRef) {
        return jdbc.query("SELECT name, sha256, bytes, daten FROM werkstatt_gehaeuse_datei WHERE edge_ref = ?",
                WerkstattGehaeuseRepository::datei, edgeRef).stream().findFirst();
    }

    /**
     * Edge-Refs abgenommener Boxen dieser Art ohne Druckdatei im Portal (Abgleich für den
     * Werkstatt-Dienst, vp-mango-3mf-pro-box): auch eine Box, die vor dieser Funktion abgenommen
     * wurde und deren Werkstatt-Lauf die Bestellung nie ausgelöst hat.
     */
    public List<String> offen(String boxArt) {
        return jdbc.query("SELECT DISTINCT a.edge_ref FROM werkstatt_abnahme a "
                        + "JOIN werkstatt_box b ON b.id = a.box_id "
                        + "WHERE b.box_art = ? "
                        + "AND NOT EXISTS (SELECT 1 FROM werkstatt_gehaeuse_datei g WHERE g.edge_ref = a.edge_ref) "
                        + "ORDER BY a.edge_ref",
                (rs, n) -> rs.getString("edge_ref"), boxArt);
    }

    /** Legt die Datei an oder überschreibt sie (Nachdruck, neuer Bau): neuer Stand, idempotent je Referenz. */
    public void hochladen(UUID boxId, String edgeRef, String name, String sha256, long bytes, byte[] daten,
            String akteur) {
        jdbc.update("INSERT INTO werkstatt_gehaeuse_datei (box_id, edge_ref, name, sha256, bytes, daten, "
                + "hochgeladen_am, hochgeladen_von) VALUES (?, ?, ?, ?, ?, ?, now(), ?) "
                + "ON CONFLICT (box_id) DO UPDATE SET name = excluded.name, sha256 = excluded.sha256, "
                + "bytes = excluded.bytes, daten = excluded.daten, hochgeladen_am = now(), "
                + "hochgeladen_von = excluded.hochgeladen_von",
                boxId, edgeRef, name, sha256, bytes, daten, akteur);
    }

    private static Stand stand(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Stand(rs.getString("name"), rs.getString("sha256"), rs.getLong("bytes"),
                rs.getTimestamp("hochgeladen_am").toInstant());
    }

    private static Datei datei(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Datei(rs.getString("name"), rs.getString("sha256"), rs.getLong("bytes"), rs.getBytes("daten"));
    }
}
