package com.voltpilot.api.mispel;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Was „Der Weg zu MiSpeL“ (MP-55, {@link MispelWegService}) neben den Diensten der Quellen fragt, unter RLS: ob die Anlage
 * einen stationären Speicher im Aufbau hat, ihr Profil und der jüngste Lauf der Abgrenzungs- und der Pauschaloption.
 * Keine eigene Tabelle — nur lesend.
 */
@Repository
public class MispelWegRepository {

    private final JdbcTemplate jdbc;

    public MispelWegRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein stationärer Speicher im Aufbau ({@code asset.type = 'battery'}). */
    public boolean speicher(UUID siteId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM asset WHERE site_id = ? "
                + "AND type = 'battery')", Boolean.class, siteId));
    }

    /** Das Profil der Anlage (privat · gewerbe), {@code null} ohne Angabe. */
    public String profil(UUID siteId) {
        List<String> profil = jdbc.queryForList("SELECT profil FROM site WHERE id = ?", String.class, siteId);
        return profil.isEmpty() ? null : profil.get(0);
    }

    /** Der jüngste Monatslauf der Abgrenzungsoption: der späteste (Rumpf-)Monat in seiner jüngsten Fassung. */
    public Optional<MispelWegRegeln.Monat> juengsterMonat(UUID siteId) {
        return jdbc.query("SELECT monat, stand FROM mispel_abgrenzung_monat WHERE site_id = ? "
                + "ORDER BY zeitraum_von DESC, fassung DESC LIMIT 1",
                (rs, n) -> new MispelWegRegeln.Monat(YearMonth.from(rs.getObject("monat", LocalDate.class)),
                        rs.getString("stand")), siteId).stream().findFirst();
    }

    /** Der jüngste Jahreslauf der Pauschaloption: das späteste (Rumpf-)Jahr in seiner jüngsten Fassung. */
    public Optional<MispelWegRegeln.Jahr> juengstesJahr(UUID siteId) {
        return jdbc.query("SELECT jahr, stand FROM mispel_pauschal_jahr WHERE site_id = ? "
                + "ORDER BY tag_von DESC, fassung DESC LIMIT 1",
                (rs, n) -> new MispelWegRegeln.Jahr(rs.getInt("jahr"), rs.getString("stand")), siteId).stream()
                .findFirst();
    }
}
