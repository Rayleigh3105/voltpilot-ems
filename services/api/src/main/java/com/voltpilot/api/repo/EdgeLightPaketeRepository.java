package com.voltpilot.api.repo;

import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Paket-Anhang der Edge-Light-Releases ({@code edge_light_pakete},
 * Direktvermarktung Stufe 5, PS-D10): die OpenWrt-Pakete des
 * Direktvermarkter-Anschlusses, EIN Anhang je Release. Plattform-Betriebsdatum
 * wie {@link EdgeLightProgrammRepository}: nur über die Admin-Verbindung; die
 * Bytes wachsen Teil für Teil, jeder Schreibzugriff trägt die erwartete Länge
 * in der WHERE-Klausel.
 */
@Repository
public class EdgeLightPaketeRepository {

    /** Stand des Anhangs; {@code laenge} = bisher empfangene Bytes. */
    public record Stand(long releaseSeq, String sha256, long groesse, long laenge, boolean fertig) {
    }

    private static final String STAND = "SELECT release_seq, sha256, groesse, "
            + "octet_length(daten) AS laenge, fertig_am IS NOT NULL AS fertig FROM edge_light_pakete ";

    private final JdbcTemplate jdbc;

    public EdgeLightPaketeRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public Optional<Stand> stand(long releaseSeq) {
        return jdbc.query(STAND + "WHERE release_seq = ?", EdgeLightPaketeRepository::map, releaseSeq)
                .stream().findFirst();
    }

    /** Legt die Zeile mit Prüfsumme und Größe AUS DEM MANIFEST an (idempotent). */
    public void anlegen(long releaseSeq, String sha256, long groesse, String actor) {
        jdbc.update("INSERT INTO edge_light_pakete (release_seq, sha256, groesse, created_by) "
                + "VALUES (?, ?, ?, ?) ON CONFLICT (release_seq) DO NOTHING",
                releaseSeq, sha256, groesse, actor);
    }

    /** Beginnt die Lieferung neu mit dem ersten Teil. Eine fertige bleibt unberührt. */
    public boolean neuBeginnen(long releaseSeq, byte[] teil) {
        return jdbc.update("UPDATE edge_light_pakete SET daten = ? "
                + "WHERE release_seq = ? AND fertig_am IS NULL", teil, releaseSeq) == 1;
    }

    /** Hängt einen Teil an - nur, wenn bisher genau {@code bisher} Bytes da sind. */
    public boolean anhaengen(long releaseSeq, long bisher, byte[] teil) {
        return jdbc.update("UPDATE edge_light_pakete SET daten = daten || ? "
                + "WHERE release_seq = ? AND fertig_am IS NULL AND octet_length(daten) = ?",
                teil, releaseSeq, bisher) == 1;
    }

    public byte[] daten(long releaseSeq) {
        return jdbc.queryForObject("SELECT daten FROM edge_light_pakete WHERE release_seq = ?",
                byte[].class, releaseSeq);
    }

    public void fertig(long releaseSeq) {
        jdbc.update("UPDATE edge_light_pakete SET fertig_am = now() "
                + "WHERE release_seq = ? AND octet_length(daten) = groesse", releaseSeq);
    }

    /** Verwirft eine nicht fertige Lieferung (falsche Länge oder Prüfsumme). */
    public void verwerfen(long releaseSeq) {
        jdbc.update("UPDATE edge_light_pakete SET daten = ''::bytea "
                + "WHERE release_seq = ? AND fertig_am IS NULL", releaseSeq);
    }

    /**
     * Die Bytes eines fertigen Anhangs mit dieser Prüfsumme - nur, wenn sein
     * Release ein SIGNIERTES Edge-Light-Release ist (wie
     * {@link EdgeLightProgrammRepository#auslieferbar}: die offene Route
     * liefert nur Anhänge signierter Releases aus; die Echtheit entsteht auf
     * der Box, die den Download gegen die Prüfsumme aus ihrem verifizierten
     * Manifest hält).
     */
    public Optional<byte[]> auslieferbar(String sha256) {
        return jdbc.query("SELECT p.daten FROM edge_light_pakete p "
                + "JOIN edge_release r ON r.release_seq = p.release_seq "
                + "WHERE p.sha256 = ? AND p.fertig_am IS NOT NULL "
                + "AND r.manifest IS NOT NULL AND r.signature IS NOT NULL "
                + "AND r.version LIKE 'edge-light-%' "
                + "ORDER BY p.release_seq DESC LIMIT 1",
                (rs, n) -> rs.getBytes(1), sha256).stream().findFirst();
    }

    private static Stand map(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Stand(rs.getLong("release_seq"), rs.getString("sha256"), rs.getLong("groesse"),
                rs.getLong("laenge"), rs.getBoolean("fertig"));
    }
}
