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
 * Die zeitgültige Zuordnung Anlage → Standort ({@code anlage_standort},
 * Migration V20260911100000), unter RLS.
 *
 * <p>Die Mechanik ist Vertrag ({@code docs/contracts/v2/ortsbaum-vectors.json},
 * {@link OrtsbaumAbleitung}): „gültig ab" ist ein Tag, {@code gueltigBis} der
 * LETZTE gültige Tag (einschließlich, {@code null} = offen); ein neues „gültig
 * ab" beendet das laufende Intervall am Vortag; eine Korrektur hebt ein
 * Intervall auf und lässt es lesbar. Das Überlappungsverbot erzwingt die
 * Datenbank selbst (Exklusions-Constraint) — wer zuerst einträgt und dann
 * beendet, bekommt die Ablehnung; die Reihenfolge ist: erst {@link #beenden},
 * dann {@link #zuordnen}.
 *
 * <p>Eine Zeile wird nie gelöscht und nie umgeschrieben: die App-Rolle darf nur
 * {@code gueltig_bis} und {@code aufgehoben_am} ändern. Welche Einträge erlaubt
 * sind (Ziel gab es schon, nicht der bisherige Standort, …), prüft der
 * Schreibweg mit {@link OrtsbaumAbleitung}, bevor er hier schreibt (IP-4/IP-9).
 */
@Repository
public class AnlageStandortRepository {

    private static final String SELECT = "SELECT id, site_id, standort_id, gueltig_ab, gueltig_bis, "
            + "aufgehoben_am FROM anlage_standort ";

    private final JdbcTemplate jdbc;

    public AnlageStandortRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Zuordnung(UUID id, UUID siteId, UUID standortId, LocalDate gueltigAb,
            LocalDate gueltigBis, Instant aufgehobenAm) {

        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }
    }

    public UUID zuordnen(UUID tenantId, UUID siteId, UUID standortId, LocalDate gueltigAb,
            LocalDate gueltigBis, String createdBy) {
        return jdbc.queryForObject("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, "
                + "gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?) RETURNING id",
                UUID.class, tenantId, siteId, standortId, gueltigAb, gueltigBis, createdBy);
    }

    /** Beendet ein (nicht aufgehobenes) Intervall am Tag {@code gueltigBis}, einschließlich. */
    public boolean beenden(UUID id, LocalDate gueltigBis) {
        return jdbc.update("UPDATE anlage_standort SET gueltig_bis = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", gueltigBis, id) == 1;
    }

    /** Hebt ein Intervall auf (Korrektur): es bleibt lesbar, belegt aber keinen Tag mehr. */
    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE anlage_standort SET aufgehoben_am = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", Timestamp.from(am), id) == 1;
    }

    /** Alle Intervalle einer Anlage, aufgehobene eingeschlossen, nach Beginn. */
    public List<Zuordnung> fuerAnlage(UUID siteId) {
        return List.copyOf(jdbc.query(SELECT + "WHERE site_id = ? ORDER BY gueltig_ab, created_at, id",
                AnlageStandortRepository::map, siteId));
    }

    /**
     * Alle Intervalle des Mandanten, aufgehobene eingeschlossen — EIN Lesezug
     * für das Standort-Lesemodell (IP-3), statt einer Abfrage je Anlage.
     */
    public List<Zuordnung> alle() {
        return List.copyOf(jdbc.query(SELECT + "ORDER BY site_id, gueltig_ab, created_at, id",
                AnlageStandortRepository::map));
    }

    private static Zuordnung map(ResultSet rs, int n) throws SQLException {
        Timestamp aufgehoben = rs.getTimestamp("aufgehoben_am");
        return new Zuordnung(
                rs.getObject("id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getObject("standort_id", UUID.class),
                rs.getObject("gueltig_ab", LocalDate.class),
                rs.getObject("gueltig_bis", LocalDate.class),
                aufgehoben == null ? null : aufgehoben.toInstant());
    }
}
