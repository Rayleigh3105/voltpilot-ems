package com.voltpilot.api.geraete;

import java.time.Instant;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Befund „Vom Kunden lösen" für die Geräteakte (GET-Weg, informativ, VOR dem Sperren): über die
 * Referenz, ohne den Mandanten zu kennen - wie {@code AdminGeraeteAkteRepository}, BYPASSRLS-Rolle
 * {@code voltpilot_admin}, nur aus einem {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt.
 * Read-only; die eigentliche Löschung läuft NICHT über diese Rolle (Mandantentrennung,
 * {@link BoxLoesenService}).
 */
@Repository
public class AdminBoxLoesenRepository {

    private final JdbcTemplate jdbc;

    public AdminBoxLoesenRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public Optional<BoxBefundSql.Zeile> befund(String externalRef) {
        return jdbc.query("SELECT " + BoxBefundSql.FELDER + BoxBefundSql.VON
                        + " WHERE d.external_ref = ? AND d.ausgebaut_am IS NULL",
                BoxBefundSql::zeile, externalRef).stream().findFirst();
    }

    /** Die letzte gelöste Box dieser Referenz, für „Vom Kunden gelöst · …" in der Akte (Abschnitt 3.4). */
    public record LetztesProtokoll(Instant geloestAm, String geloestVonName, String anlass, String anlassText) {
    }

    public Optional<LetztesProtokoll> letztesProtokoll(String externalRef) {
        return jdbc.query("SELECT geloest_am, geloest_von_name, anlass, anlass_text FROM box_loesen_protokoll "
                        + "WHERE external_ref = ? ORDER BY geloest_am DESC LIMIT 1",
                (rs, n) -> new LetztesProtokoll(rs.getTimestamp("geloest_am").toInstant(),
                        rs.getString("geloest_von_name"), rs.getString("anlass"), rs.getString("anlass_text")),
                externalRef).stream().findFirst();
    }
}
