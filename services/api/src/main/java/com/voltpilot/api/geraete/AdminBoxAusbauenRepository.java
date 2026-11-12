package com.voltpilot.api.geraete;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Idempotenz von "Box ausbauen" (vp-admin-box-ausbauen), BEVOR der Mandant feststeht: wie
 * {@link AdminBoxLoesenRepository#letztesProtokoll}, BYPASSRLS-Rolle {@code voltpilot_admin}, nur
 * aus einem {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Die Box ist nach dem Ausbau
 * nicht mehr "aktiv" (der Erst-Befund aus {@link AdminBoxLoesenRepository#befund} findet sie dann
 * nicht mehr) - ein Doppelklick oder eine Wiederholung nach einem Netzfehler braucht trotzdem
 * dieselbe Antwort statt eines 404 "Unbekannte Referenz".
 */
@Repository
public class AdminBoxAusbauenRepository {

    private final JdbcTemplate jdbc;

    public AdminBoxAusbauenRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public record LetztesProtokoll(UUID deviceId, Instant ausgebautAm, String anlass) {
    }

    public Optional<LetztesProtokoll> letztesProtokoll(String externalRef) {
        return jdbc.query("SELECT device_id, ausgebaut_am, anlass FROM box_ausbauen_protokoll "
                        + "WHERE external_ref = ? ORDER BY ausgebaut_am DESC LIMIT 1",
                (rs, n) -> new LetztesProtokoll(rs.getObject("device_id", UUID.class),
                        rs.getTimestamp("ausgebaut_am").toInstant(), rs.getString("anlass")),
                externalRef).stream().findFirst();
    }
}
