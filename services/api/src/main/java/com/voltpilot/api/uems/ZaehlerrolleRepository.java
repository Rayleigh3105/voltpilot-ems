package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Fassungen der Zählerrolle ({@code messstelle_zaehlerrolle}, V20261002121500), unter RLS. Eine Zeile
 * wird nie gelöscht und nie umgeschrieben: die App-Rolle darf nur {@code aufgehoben_am} setzen.
 */
@Repository
public class ZaehlerrolleRepository {

    private static final String SELECT = "SELECT id, messstelle_id, rolle, zaehlpunkt, messstellenbetreiber, "
            + "eichstatus, eichfrist_bis, wertequelle, gueltig_ab, aufgehoben_am, created_at, created_by "
            + "FROM messstelle_zaehlerrolle ";
    private static final String ORDNUNG = " ORDER BY messstelle_id, gueltig_ab, created_at, id";

    private final JdbcTemplate jdbc;

    public ZaehlerrolleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Fassung, wie sie gespeichert ist; {@code angaben.rolle()} {@code null} = keine Rolle ab dem Tag. */
    public record Fassung(UUID id, UUID messstelleId, ZaehlerrolleRegeln.Angaben angaben, LocalDate gueltigAb,
            Instant aufgehobenAm, Instant eingetragenAm, String eingetragenVon) {
        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }
    }

    /** Die Fassungen EINER Messstelle, aufgehobene eingeschlossen — leer für eine fremde. */
    public List<Fassung> derMessstelle(UUID messstelleId) {
        return List.copyOf(jdbc.query(SELECT + "WHERE messstelle_id = ?" + ORDNUNG, ZaehlerrolleRepository::fassung,
                messstelleId));
    }

    /** Alle Fassungen des Mandanten — ein Lesezug für die Anlage. */
    public List<Fassung> alle() {
        return List.copyOf(jdbc.query(SELECT + ORDNUNG, ZaehlerrolleRepository::fassung));
    }

    public UUID eintragen(UUID tenantId, UUID messstelleId, ZaehlerrolleRegeln.Angaben a, LocalDate gueltigAb,
            String von) {
        return jdbc.queryForObject("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenantId, messstelleId, a.rolle(),
                a.zaehlpunkt(), a.messstellenbetreiber(), a.eichstatus(), a.eichfristBis(), a.wertequelle(),
                gueltigAb, von);
    }

    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE messstelle_zaehlerrolle SET aufgehoben_am = ? WHERE id = ? AND aufgehoben_am IS NULL",
                Timestamp.from(am), id) == 1;
    }

    private static Fassung fassung(ResultSet rs, int n) throws SQLException {
        java.sql.Date frist = rs.getDate("eichfrist_bis");
        Timestamp auf = rs.getTimestamp("aufgehoben_am");
        return new Fassung(rs.getObject("id", UUID.class), rs.getObject("messstelle_id", UUID.class),
                new ZaehlerrolleRegeln.Angaben(rs.getString("rolle"), rs.getString("zaehlpunkt"),
                        rs.getString("messstellenbetreiber"), rs.getString("eichstatus"),
                        frist == null ? null : frist.toLocalDate(), rs.getString("wertequelle")),
                rs.getDate("gueltig_ab").toLocalDate(), auf == null ? null : auf.toInstant(),
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"));
    }
}
