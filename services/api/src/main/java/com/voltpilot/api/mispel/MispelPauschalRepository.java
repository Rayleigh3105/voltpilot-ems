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
 * Die Läufe des Rechenwerks der Pauschaloption ({@code mispel_pauschal_jahr}, V20261002191500), unter RLS. Eine Zeile
 * wird nie umgeschrieben: die App-Rolle liest und hängt an. MiSpeL MP-25, Muster {@link MispelAbgrenzungRepository}.
 */
@Repository
public class MispelPauschalRepository {

    /**
     * Ein gespeicherter Lauf über das (Rumpf-)Jahr {@code tagVon} bis {@code tagBis} (einschließlich);
     * {@code nachweis} ist der kanonische Text, über den {@code pruefsumme} gebildet ist.
     */
    public record Zeile(UUID id, UUID siteId, int jahr, LocalDate tagVon, LocalDate tagBis, Instant zeitraumVon,
            Instant zeitraumBis, int fassung, String formelsatz, String stand, String wertequelle,
            int viertelstundenErwartet, int viertelstundenGerechnet, String rechenwerkVersion, String vertragVersion,
            String nachweis, String pruefsumme, Instant gerechnetAm) {}

    private static final String SELECT = "SELECT id, site_id, jahr, tag_von, tag_bis, zeitraum_von, zeitraum_bis, "
            + "fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, viertelstunden_gerechnet, "
            + "rechenwerk_version, vertrag_version, nachweis, pruefsumme, gerechnet_am FROM mispel_pauschal_jahr ";

    private final JdbcTemplate jdbc;

    public MispelPauschalRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die jüngste Fassung des (Rumpf-)Jahres, das am Tag {@code tagVon} beginnt. */
    public Optional<Zeile> letzte(UUID siteId, LocalDate tagVon) {
        return jdbc.query(SELECT + "WHERE site_id = ? AND tag_von = ? ORDER BY fassung DESC LIMIT 1",
                MispelPauschalRepository::zeile, siteId, tagVon).stream().findFirst();
    }

    /** Alle Läufe eines Kalenderjahres, je (Rumpf-)Jahr in Fassungs-Reihenfolge. */
    public List<Zeile> desJahres(UUID siteId, int jahr) {
        return List.copyOf(jdbc.query(SELECT + "WHERE site_id = ? AND jahr = ? ORDER BY tag_von, fassung",
                MispelPauschalRepository::zeile, siteId, jahr));
    }

    public UUID anhaengen(UUID tenantId, Zeile z) {
        return jdbc.queryForObject("INSERT INTO mispel_pauschal_jahr (tenant_id, site_id, jahr, tag_von, tag_bis, "
                        + "zeitraum_von, zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                        + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme, "
                        + "gerechnet_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, z.siteId(), z.jahr(), z.tagVon(), z.tagBis(), Timestamp.from(z.zeitraumVon()),
                Timestamp.from(z.zeitraumBis()), z.fassung(), z.formelsatz(), z.stand(), z.wertequelle(),
                z.viertelstundenErwartet(), z.viertelstundenGerechnet(), z.rechenwerkVersion(), z.vertragVersion(),
                z.nachweis(), z.pruefsumme(), Timestamp.from(z.gerechnetAm()));
    }

    private static Zeile zeile(ResultSet rs, int i) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class), rs.getInt("jahr"),
                rs.getObject("tag_von", LocalDate.class), rs.getObject("tag_bis", LocalDate.class),
                rs.getTimestamp("zeitraum_von").toInstant(), rs.getTimestamp("zeitraum_bis").toInstant(),
                rs.getInt("fassung"), rs.getString("formelsatz"), rs.getString("stand"), rs.getString("wertequelle"),
                rs.getInt("viertelstunden_erwartet"), rs.getInt("viertelstunden_gerechnet"),
                rs.getString("rechenwerk_version"), rs.getString("vertrag_version"), rs.getString("nachweis"),
                rs.getString("pruefsumme"), rs.getTimestamp("gerechnet_am").toInstant());
    }
}
