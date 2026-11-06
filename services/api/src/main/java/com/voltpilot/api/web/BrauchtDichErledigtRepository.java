package com.voltpilot.api.web;

import java.time.Instant;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * „Braucht dich" einzeln auf erledigt setzen (Migration
 * V20261106170000), an der BYPASSRLS-Rolle {@code voltpilot_admin}. Der
 * Schlüssel ist der stabile Eintragsschlüssel aus der Übersicht
 * (z. B. {@code fehler-<ref>}); {@code stand} hält den Grund-Text fest, mit
 * dem der Eintrag erledigt wurde - ein anderer Grund lässt ihn wieder
 * erscheinen.
 */
@Repository
public class BrauchtDichErledigtRepository {

    public record Erledigt(String schluessel, String stand, Instant erledigtAm, String erledigtVon) {
    }

    private final JdbcTemplate jdbc;

    public BrauchtDichErledigtRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<Erledigt> alle() {
        return jdbc.query("SELECT schluessel, stand, erledigt_am, erledigt_von "
                + "FROM plattform_braucht_dich_erledigt ORDER BY erledigt_am DESC",
                (rs, i) -> new Erledigt(rs.getString("schluessel"), rs.getString("stand"),
                        rs.getTimestamp("erledigt_am").toInstant(), rs.getString("erledigt_von")));
    }

    public void erledigen(String schluessel, String stand, String erledigtVon) {
        jdbc.update("INSERT INTO plattform_braucht_dich_erledigt (schluessel, stand, erledigt_am, erledigt_von) "
                        + "VALUES (?, ?, now(), ?) ON CONFLICT (schluessel) DO UPDATE SET "
                        + "stand = EXCLUDED.stand, erledigt_am = now(), erledigt_von = EXCLUDED.erledigt_von",
                schluessel, stand, erledigtVon);
    }

    public void wiederherstellen(String schluessel) {
        jdbc.update("DELETE FROM plattform_braucht_dich_erledigt WHERE schluessel = ?", schluessel);
    }
}
