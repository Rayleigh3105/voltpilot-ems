package com.voltpilot.api.mispel;

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
 * Die Läufe des Rechenwerks der Abgrenzungsoption ({@code mispel_abgrenzung_monat}, V20261002153700), unter RLS.
 * Eine Zeile wird nie umgeschrieben: die App-Rolle liest und hängt an. MiSpeL MP-8.
 */
@Repository
public class MispelAbgrenzungRepository {

    /** Ein gespeicherter Lauf; {@code nachweis} ist der kanonische Text, über den {@code pruefsumme} gebildet ist. */
    public record Zeile(UUID id, UUID siteId, LocalDate monat, Instant zeitraumVon, Instant zeitraumBis, int fassung,
            String formelsatz, String stand, String wertequelle, int viertelstundenErwartet,
            int viertelstundenGerechnet, String rechenwerkVersion, String vertragVersion, String nachweis,
            String pruefsumme, Instant gerechnetAm) {}

    private static final String SELECT = "SELECT id, site_id, monat, zeitraum_von, zeitraum_bis, fassung, formelsatz, "
            + "stand, wertequelle, viertelstunden_erwartet, viertelstunden_gerechnet, rechenwerk_version, "
            + "vertrag_version, nachweis, pruefsumme, gerechnet_am FROM mispel_abgrenzung_monat ";

    private final JdbcTemplate jdbc;

    public MispelAbgrenzungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die jüngste Fassung des (Rumpf-)Monats, der bei {@code zeitraumVon} beginnt. */
    public Optional<Zeile> letzte(UUID siteId, Instant zeitraumVon) {
        return jdbc.query(SELECT + "WHERE site_id = ? AND zeitraum_von = ? ORDER BY fassung DESC LIMIT 1",
                MispelAbgrenzungRepository::zeile, siteId, Timestamp.from(zeitraumVon)).stream().findFirst();
    }

    /** Alle Läufe eines Kalendermonats, je (Rumpf-)Monat in Fassungs-Reihenfolge. */
    public List<Zeile> desMonats(UUID siteId, LocalDate monat) {
        return List.copyOf(jdbc.query(SELECT + "WHERE site_id = ? AND monat = ? ORDER BY zeitraum_von, fassung",
                MispelAbgrenzungRepository::zeile, siteId, monat));
    }

    public UUID anhaengen(UUID tenantId, Zeile z) {
        return jdbc.queryForObject("INSERT INTO mispel_abgrenzung_monat (tenant_id, site_id, monat, zeitraum_von, "
                        + "zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                        + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme, "
                        + "gerechnet_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, z.siteId(), z.monat(), Timestamp.from(z.zeitraumVon()),
                Timestamp.from(z.zeitraumBis()), z.fassung(), z.formelsatz(), z.stand(), z.wertequelle(),
                z.viertelstundenErwartet(), z.viertelstundenGerechnet(), z.rechenwerkVersion(), z.vertragVersion(),
                z.nachweis(), z.pruefsumme(), Timestamp.from(z.gerechnetAm()));
    }

    private static Zeile zeile(ResultSet rs, int i) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getObject("monat", LocalDate.class), rs.getTimestamp("zeitraum_von").toInstant(),
                rs.getTimestamp("zeitraum_bis").toInstant(), rs.getInt("fassung"), rs.getString("formelsatz"),
                rs.getString("stand"), rs.getString("wertequelle"), rs.getInt("viertelstunden_erwartet"),
                rs.getInt("viertelstunden_gerechnet"), rs.getString("rechenwerk_version"),
                rs.getString("vertrag_version"), rs.getString("nachweis"), rs.getString("pruefsumme"),
                rs.getTimestamp("gerechnet_am").toInstant());
    }
}
