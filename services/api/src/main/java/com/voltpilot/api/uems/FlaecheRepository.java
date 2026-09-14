package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die zeitgültige Bezugsfläche je Standort, Gebäude oder Bereich
 * ({@code flaeche_gueltigkeit}, Migration V20260911110000), unter RLS —
 * AP-02 E3, Regel 12; AP-09 liest sie als Bezugsgröße BZ-4.
 *
 * <p>„Nicht erhoben" ist KEINE Zeile, nie eine mit 0: es gibt nur ganze
 * Quadratmeter größer als 0. Je Objekt eine Fläche je Tag, dieselbe Mechanik
 * wie die Zuordnungen ({@link OrtsbaumAbleitung}): eine andere Zahl ab einem
 * Tag beendet die laufende am Vortag ({@link #beenden}, dann
 * {@link #eintragen}); ein Irrtum wird aufgehoben und ersetzt, nie
 * umgeschrieben. Die Summe der Gebäude am Standort („aus Gebäuden summiert")
 * leitet der Leseweg ab ({@link OrtsbaumAbleitung#flaecheAm}) — sie ist keine Zeile.
 */
@Repository
public class FlaecheRepository {

    private static final String SPALTEN =
            "id, standort_id, ort_id, m2, gueltig_ab, gueltig_bis, aufgehoben_am, created_at";

    private final JdbcTemplate jdbc;

    public FlaecheRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Genau eines von {@code standortId} / {@code ortId} ist gesetzt. {@code createdAt} ist der Eintrag —
     * AP-09 IP-6 liest daraus das Abzeichen „rückwirkend (n Tage)“ der Bezugsfläche.
     */
    public record Flaeche(UUID id, UUID standortId, UUID ortId, int m2, LocalDate gueltigAb,
            LocalDate gueltigBis, Instant aufgehobenAm, Instant createdAt) {

        /** Ohne Eintragszeit — die Form vor AP-09 IP-6. */
        public Flaeche(UUID id, UUID standortId, UUID ortId, int m2, LocalDate gueltigAb,
                LocalDate gueltigBis, Instant aufgehobenAm) {
            this(id, standortId, ortId, m2, gueltigAb, gueltigBis, aufgehobenAm, null);
        }

        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }
    }

    /** Eine Fläche ab {@code gueltigAb} für einen Standort ODER einen Ort — genau einen der beiden. */
    public UUID eintragen(UUID tenantId, UUID standortId, UUID ortId, int m2, LocalDate gueltigAb,
            LocalDate gueltigBis, String createdBy) {
        return jdbc.queryForObject("INSERT INTO flaeche_gueltigkeit (tenant_id, standort_id, "
                + "ort_id, m2, gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?,?) "
                + "RETURNING id",
                UUID.class, tenantId, standortId, ortId, m2, gueltigAb, gueltigBis, createdBy);
    }

    /** Beendet ein (nicht aufgehobenes) Intervall am Tag {@code gueltigBis}, einschließlich. */
    public boolean beenden(UUID id, LocalDate gueltigBis) {
        return jdbc.update("UPDATE flaeche_gueltigkeit SET gueltig_bis = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", gueltigBis, id) == 1;
    }

    /** Hebt ein Intervall auf (Korrektur): es bleibt lesbar, belegt aber keinen Tag mehr. */
    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE flaeche_gueltigkeit SET aufgehoben_am = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", Timestamp.from(am), id) == 1;
    }

    /** Alle Flächen eines Standorts, aufgehobene eingeschlossen, nach Beginn. */
    public List<Flaeche> fuerStandort(UUID standortId) {
        return liste("standort_id", standortId);
    }

    /** Alle Flächen eines Gebäudes oder Bereichs, aufgehobene eingeschlossen, nach Beginn. */
    public List<Flaeche> fuerOrt(UUID ortId) {
        return liste("ort_id", ortId);
    }

    /**
     * Alle Flächen des Mandanten, aufgehobene eingeschlossen — EIN Lesezug für
     * das Standort-Lesemodell (IP-3), statt einer Abfrage je Objekt.
     */
    public List<Flaeche> alle() {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM flaeche_gueltigkeit "
                + "ORDER BY gueltig_ab, created_at, id", FlaecheRepository::map));
    }

    private List<Flaeche> liste(String spalte, UUID id) {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM flaeche_gueltigkeit WHERE "
                + spalte + " = ? ORDER BY gueltig_ab, created_at, id", FlaecheRepository::map, id));
    }

    private static Flaeche map(ResultSet rs, int n) throws SQLException {
        Timestamp aufgehoben = rs.getTimestamp("aufgehoben_am");
        Timestamp eingetragen = rs.getTimestamp("created_at");
        return new Flaeche(
                rs.getObject("id", UUID.class),
                rs.getObject("standort_id", UUID.class),
                rs.getObject("ort_id", UUID.class),
                rs.getInt("m2"),
                rs.getObject("gueltig_ab", LocalDate.class),
                rs.getObject("gueltig_bis", LocalDate.class),
                aufgehoben == null ? null : aufgehoben.toInstant(),
                eingetragen == null ? null : eingetragen.toInstant());
    }
}
