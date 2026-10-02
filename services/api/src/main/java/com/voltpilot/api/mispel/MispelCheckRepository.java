package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der letzte Stand des MiSpeL-Checks je Anlage ({@code site_mispel_check}, V20261002234100, Vertrag
 * {@code docs/contracts/v2/mispel-check.md}), unter RLS: eine fremde Anlage hat keine Zeile. Hier wird nur gelesen;
 * abgelegt wird vom Folgepaket MP-13b.
 */
@Repository
public class MispelCheckRepository {

    private final JdbcTemplate jdbc;

    public MispelCheckRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Zeile, wie sie gespeichert ist; {@code posten}/{@code datenbasis} als JSON-Text (Vertrag § 3, § 4). */
    public record Zeile(UUID siteId, String stand, Instant standSeit, String formelsatz, LocalDate fensterVon,
            LocalDate fensterBis, BigDecimal differenzNiedrigEur, BigDecimal differenzMittelEur,
            BigDecimal differenzHochEur, String posten, String datenbasis, String hinweis) {}

    public Optional<Zeile> derAnlage(UUID siteId) {
        return jdbc.query("SELECT site_id, stand, stand_seit, formelsatz, fenster_von, fenster_bis, "
                + "differenz_niedrig_eur, differenz_mittel_eur, differenz_hoch_eur, posten::text AS posten, "
                + "datenbasis::text AS datenbasis, hinweis FROM site_mispel_check WHERE site_id = ?",
                (rs, n) -> new Zeile(rs.getObject("site_id", UUID.class), rs.getString("stand"),
                        instant(rs.getTimestamp("stand_seit")), rs.getString("formelsatz"),
                        tag(rs.getDate("fenster_von")), tag(rs.getDate("fenster_bis")),
                        rs.getBigDecimal("differenz_niedrig_eur"), rs.getBigDecimal("differenz_mittel_eur"),
                        rs.getBigDecimal("differenz_hoch_eur"), rs.getString("posten"), rs.getString("datenbasis"),
                        rs.getString("hinweis")),
                siteId).stream().findFirst();
    }

    /** Gibt es die Anlage im Kundenbereich (RLS)? Eine fremde oder unbekannte ist unsichtbar. */
    public boolean anlageSichtbar(UUID siteId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM site WHERE id = ?)",
                Boolean.class, siteId));
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    private static LocalDate tag(Date d) {
        return d == null ? null : d.toLocalDate();
    }
}
