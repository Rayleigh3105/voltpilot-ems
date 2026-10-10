package com.voltpilot.api.uems;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * UEMS AP-19: die Einstellung des Energiemanagements je Unternehmen ({@code energiemanagement_einstellung}, RLS) — hier
 * nur, was der Leser der Wiedervorlage braucht. Ohne Zeile gilt der Startwert des Vertrags.
 */
@Repository
public class EnergiemanagementEinstellungRepository {

    private final JdbcTemplate jdbc;

    public EnergiemanagementEinstellungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** WV3: das Vorschau-Fenster der Wiedervorlage in Tagen (Startwert 30). */
    public int vorschauTage() {
        return jdbc.queryForList("SELECT vorschau_tage FROM energiemanagement_einstellung", Integer.class).stream()
                .findFirst().orElse(EnergiemanagementRegeln.STARTWERTE.vorschau_tage());
    }
}
