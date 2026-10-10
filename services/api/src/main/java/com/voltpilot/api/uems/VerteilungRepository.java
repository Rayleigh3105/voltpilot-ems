package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Die Verteilung einer Messstelle auf Kostenstellen (UEMS AP-10 IP-8, {@code V20260913230000}). Jede Abfrage läuft
 * unter RLS: eine fremde Messstelle hat keine Zeilen. Die 100 % je Tag prüft die Datenbank zur Commit-Zeit, das
 * Ende mit der Kostenstelle ihr Trigger-Paar — hier wird nur gelesen und geschrieben.
 */
@Repository
public class VerteilungRepository implements AnteilLeseweg.Verteilungen {

    /** Ein wirksamer (nicht aufgehobener) Anteil mit seiner Kostenstelle, wie sie heute steht. */
    public record Zeile(UUID id, UUID kostenstelleId, String kostenstelleKennzeichen, String kostenstelleName,
            LocalDate kostenstelleAb, LocalDate kostenstelleBis, BigDecimal anteilProzent, LocalDate gueltigAb,
            LocalDate gueltigBis) {

        /** Die Zeile, wie die Regel sie liest — Schlüssel der Kostenstelle ist ihre ID. */
        VerteilungRegeln.Bestandszeile bestand() {
            return new VerteilungRegeln.Bestandszeile(kostenstelleId.toString(), anteilProzent, gueltigAb, gueltigBis,
                    null);
        }

        VerteilungRegeln.Ziel ziel() {
            return new VerteilungRegeln.Ziel(kostenstelleId.toString(), kostenstelleAb, kostenstelleBis);
        }
    }

    private static final String SPALTEN = "SELECT v.id, v.kostenstelle_id, k.kennzeichen, k.name, "
            + "k.gueltig_ab AS k_ab, k.gueltig_bis AS k_bis, v.anteil_prozent, v.gueltig_ab, v.gueltig_bis "
            + "FROM messstelle_verteilung v "
            + "JOIN kostenstelle k ON k.id = v.kostenstelle_id AND k.tenant_id = v.tenant_id ";

    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class),
            rs.getObject("kostenstelle_id", UUID.class),
            rs.getString("kennzeichen"),
            rs.getString("name"),
            rs.getObject("k_ab", LocalDate.class),
            rs.getObject("k_bis", LocalDate.class),
            rs.getBigDecimal("anteil_prozent"),
            rs.getObject("gueltig_ab", LocalDate.class),
            rs.getObject("gueltig_bis", LocalDate.class));

    private final JdbcTemplate jdbc;

    public VerteilungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Alle wirksamen Anteile einer Messstelle, nach Beginn und Kennzeichen. */
    public List<Zeile> zeilen(UUID messstelle) {
        return jdbc.query(SPALTEN + "WHERE v.messstelle_id = ? AND v.aufgehoben_am IS NULL "
                + "ORDER BY v.gueltig_ab, k.kennzeichen, v.id", ZEILE, messstelle);
    }

    /**
     * Der Leseweg des Formel-Terms: die Anteile, die am Tag gelten, mit ihren Kostenstellen und dem Kennzeichen der
     * Messstelle. Welche davon wirklich gelten, entscheidet {@link VerteilungRegeln#amTag} — nicht diese Abfrage.
     */
    @Override
    public AnteilLeseweg.Stand stand(UUID messstelle, LocalDate tag) {
        List<Zeile> zeilen = jdbc.query(SPALTEN + "WHERE v.messstelle_id = ? AND v.aufgehoben_am IS NULL "
                + "AND v.gueltig_ab <= ? AND (v.gueltig_bis IS NULL OR v.gueltig_bis >= ?) "
                + "ORDER BY k.kennzeichen, v.id", ZEILE, messstelle, tag, tag);
        String kennzeichen = jdbc.queryForList("SELECT kennzeichen FROM messstelle WHERE id = ?", String.class,
                messstelle).stream().findFirst().orElse(null);
        return new AnteilLeseweg.Stand(kennzeichen, zeilen.stream().map(Zeile::bestand).toList(),
                zeilen.stream().map(Zeile::ziel).toList());
    }

    public void aufheben(UUID id, Instant jetzt) {
        jdbc.update("UPDATE messstelle_verteilung SET aufgehoben_am = ? WHERE id = ?", Timestamp.from(jetzt), id);
    }

    public void beenden(UUID id, LocalDate bis) {
        jdbc.update("UPDATE messstelle_verteilung SET gueltig_bis = ? WHERE id = ?", bis, id);
    }

    public void eintragen(UUID tenant, UUID messstelle, UUID kostenstelle, BigDecimal anteil, LocalDate ab,
            LocalDate bis, String wer) {
        jdbc.update("INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?,?)",
                tenant, messstelle, kostenstelle, anteil, ab, bis, wer);
    }
}
