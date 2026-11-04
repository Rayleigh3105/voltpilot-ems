package com.voltpilot.api.repo;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die gepackten Programme der Edge-Light-Releases ({@code edge_light_programm},
 * Konzept vp-edge-light-update K2). Plattform-Betriebsdatum wie
 * {@link EdgeReleaseRepository}: nur über die Admin-Verbindung.
 *
 * <p>Die Bytes wachsen Teil für Teil. Jeder Schreibzugriff trägt die Länge, die
 * der Schreibende erwartet, in der WHERE-Klausel - zwei Läufe, die sich
 * überholen, verlängern nie dieselbe Lieferung doppelt.
 */
@Repository
public class EdgeLightProgrammRepository {

    /** Stand einer Lieferung; {@code laenge} = bisher empfangene Bytes. */
    public record Stand(long releaseSeq, String arch, String gzSha256, long gzSize, long laenge,
            boolean fertig) {
    }

    private static final String STAND = "SELECT release_seq, arch, gz_sha256, gz_size, "
            + "octet_length(daten) AS laenge, fertig_am IS NOT NULL AS fertig FROM edge_light_programm ";

    private final JdbcTemplate jdbc;

    public EdgeLightProgrammRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public Optional<Stand> stand(long releaseSeq, String arch) {
        return jdbc.query(STAND + "WHERE release_seq = ? AND arch = ?", EdgeLightProgrammRepository::map,
                releaseSeq, arch).stream().findFirst();
    }

    public List<Stand> alle(long releaseSeq) {
        return jdbc.query(STAND + "WHERE release_seq = ? ORDER BY arch", EdgeLightProgrammRepository::map,
                releaseSeq);
    }

    /** Die Plattformen, deren Lieferung vollständig und geprüft vorliegt. */
    public Set<String> fertigeArchs(long releaseSeq) {
        return new TreeSet<>(jdbc.queryForList(
                "SELECT arch FROM edge_light_programm WHERE release_seq = ? AND fertig_am IS NOT NULL",
                String.class, releaseSeq));
    }

    /** Legt die Zeile mit Prüfsumme und Größe AUS DEM MANIFEST an (idempotent). */
    public void anlegen(long releaseSeq, String arch, String gzSha256, long gzSize, String actor) {
        jdbc.update("INSERT INTO edge_light_programm (release_seq, arch, gz_sha256, gz_size, created_by) "
                + "VALUES (?, ?, ?, ?, ?) ON CONFLICT (release_seq, arch) DO NOTHING",
                releaseSeq, arch, gzSha256, gzSize, actor);
    }

    /** Beginnt die Lieferung neu mit dem ersten Teil. Eine fertige bleibt unberührt. */
    public boolean neuBeginnen(long releaseSeq, String arch, byte[] teil) {
        return jdbc.update("UPDATE edge_light_programm SET daten = ? "
                + "WHERE release_seq = ? AND arch = ? AND fertig_am IS NULL", teil, releaseSeq, arch) == 1;
    }

    /** Hängt einen Teil an - nur, wenn bisher genau {@code bisher} Bytes da sind. */
    public boolean anhaengen(long releaseSeq, String arch, long bisher, byte[] teil) {
        return jdbc.update("UPDATE edge_light_programm SET daten = daten || ? "
                + "WHERE release_seq = ? AND arch = ? AND fertig_am IS NULL AND octet_length(daten) = ?",
                teil, releaseSeq, arch, bisher) == 1;
    }

    public byte[] daten(long releaseSeq, String arch) {
        return jdbc.queryForObject("SELECT daten FROM edge_light_programm WHERE release_seq = ? AND arch = ?",
                byte[].class, releaseSeq, arch);
    }

    public void fertig(long releaseSeq, String arch) {
        jdbc.update("UPDATE edge_light_programm SET fertig_am = now() "
                + "WHERE release_seq = ? AND arch = ? AND octet_length(daten) = gz_size", releaseSeq, arch);
    }

    /** Verwirft eine nicht fertige Lieferung (falsche Länge oder Prüfsumme). */
    public void verwerfen(long releaseSeq, String arch) {
        jdbc.update("UPDATE edge_light_programm SET daten = ''::bytea "
                + "WHERE release_seq = ? AND arch = ? AND fertig_am IS NULL", releaseSeq, arch);
    }

    /**
     * Die Bytes einer fertigen Lieferung mit dieser Prüfsumme - nur, wenn ihr
     * Release ein SIGNIERTES Edge-Light-Release ist (U-4 A: die offene Route
     * liefert nur signierte Edge-Light-Programme aus).
     */
    public Optional<byte[]> auslieferbar(String gzSha256) {
        return jdbc.query("SELECT p.daten FROM edge_light_programm p "
                + "JOIN edge_release r ON r.release_seq = p.release_seq "
                + "WHERE p.gz_sha256 = ? AND p.fertig_am IS NOT NULL "
                + "AND r.manifest IS NOT NULL AND r.signature IS NOT NULL "
                + "AND r.version LIKE 'edge-light-%' ORDER BY p.release_seq DESC LIMIT 1",
                (rs, n) -> rs.getBytes(1), gzSha256).stream().findFirst();
    }

    private static Stand map(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Stand(rs.getLong("release_seq"), rs.getString("arch"), rs.getString("gz_sha256"),
                rs.getLong("gz_size"), rs.getLong("laenge"), rs.getBoolean("fertig"));
    }
}
