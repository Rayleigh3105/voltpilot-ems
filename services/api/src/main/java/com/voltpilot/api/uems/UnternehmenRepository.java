package com.voltpilot.api.uems;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Unternehmen des Kundenbereichs ({@code unternehmen}, Migration
 * V20260911100000) — genau eines je Mandant, unter RLS.
 *
 * <p>Lesen und Bearbeiten. Anlegen und Löschen gibt es für die App-Rolle gar
 * nicht (AP-02 §4.1: kein Anlegen, kein Archivieren durch den Kunden): das
 * Unternehmen entsteht automatisch mit dem Kundenbereich und endet nur mit
 * seinem Offboarding. Die Regeln des Bearbeitens (Name, Kurzname,
 * Zeitzonen-Vorgabe, Sitz, Rechtsform) und sein Protokolleintrag gehören der
 * Schreibroute ({@link UnternehmenService}, IP-4).
 */
@Repository
public class UnternehmenRepository {

    private final JdbcTemplate jdbc;

    public UnternehmenRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die Stammdaten des Unternehmens; {@code zeitzone} erbt jeder neue Standort.
     * Sitz und Rechtsform sind {@code null}, wenn nicht angegeben.
     */
    public record Unternehmen(UUID id, String name, String kurzname, String zeitzone,
            String sitzStrasse, String sitzPlz, String sitzOrt, String sitzLand, String rechtsform) {

        /** Ohne Sitz und Rechtsform (die Felder, die die Ortsstruktur braucht). */
        public Unternehmen(UUID id, String name, String kurzname, String zeitzone) {
            this(id, name, kurzname, zeitzone, null, null, null, null, null);
        }
    }

    /**
     * Das Unternehmen des Mandanten im Zaun. Leer ohne Mandant (default-deny) —
     * und für einen Kundenbereich ohne Unternehmen-Zeile (vor dem Anlege-Weg von
     * {@code TenantRepository.create} entstanden): „nicht da" ist dann die
     * ehrliche Antwort, nie ein erfundenes.
     */
    public Optional<Unternehmen> desKundenbereichs() {
        return jdbc.query("SELECT id, name, kurzname, zeitzone, sitz_strasse, sitz_plz, sitz_ort, "
                + "sitz_land, rechtsform FROM unternehmen ORDER BY created_at, id",
                (rs, n) -> new Unternehmen(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getString("kurzname"), rs.getString("zeitzone"),
                        rs.getString("sitz_strasse"), rs.getString("sitz_plz"),
                        rs.getString("sitz_ort"), rs.getString("sitz_land"),
                        rs.getString("rechtsform")))
                .stream().findFirst();
    }

    /** Schreibt die Stammdaten — die ganze Menge; {@code false}: nicht da (fremd oder ohne Mandant). */
    public boolean bearbeiten(UUID id, Unternehmen u) {
        return jdbc.update("UPDATE unternehmen SET name = ?, kurzname = ?, zeitzone = ?, "
                + "sitz_strasse = ?, sitz_plz = ?, sitz_ort = ?, sitz_land = ?, rechtsform = ? "
                + "WHERE id = ?", u.name(), u.kurzname(), u.zeitzone(), u.sitzStrasse(), u.sitzPlz(),
                u.sitzOrt(), u.sitzLand(), u.rechtsform(), id) == 1;
    }
}
