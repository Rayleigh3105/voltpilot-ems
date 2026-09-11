package com.voltpilot.api.uems;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Unternehmen des Kundenbereichs ({@code unternehmen}, Migration
 * V20260911100000) — genau eines je Mandant, unter RLS.
 *
 * <p>Hier wird nur GELESEN. Anlegen und Löschen gibt es für die App-Rolle gar
 * nicht (AP-02 §4.1: kein Anlegen, kein Archivieren durch den Kunden): das
 * Unternehmen entsteht automatisch mit dem Kundenbereich und endet nur mit
 * seinem Offboarding. Das Bearbeiten (Name, Kurzname, Zeitzonen-Vorgabe, Sitz,
 * Rechtsform) bringt die Schreibroute (IP-4).
 */
@Repository
public class UnternehmenRepository {

    private final JdbcTemplate jdbc;

    public UnternehmenRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Stammdaten, die die Ortsstruktur braucht; {@code zeitzone} erbt jeder neue Standort. */
    public record Unternehmen(UUID id, String name, String kurzname, String zeitzone) {}

    /**
     * Das Unternehmen des Mandanten im Zaun. Leer ohne Mandant (default-deny) —
     * und für einen Kundenbereich, der nach der Migration entstanden ist, bis
     * sein Anlege-Weg es mitbringt (IP-3/IP-4): „nicht da" ist dann die ehrliche
     * Antwort, nie ein erfundenes.
     */
    public Optional<Unternehmen> desKundenbereichs() {
        return jdbc.query(
                "SELECT id, name, kurzname, zeitzone FROM unternehmen ORDER BY created_at, id",
                (rs, n) -> new Unternehmen(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getString("kurzname"), rs.getString("zeitzone")))
                .stream().findFirst();
    }
}
