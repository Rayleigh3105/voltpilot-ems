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
 * Die zeitgültige Zuordnung Gebäude/Bereich → Elternknoten
 * ({@code ort_zuordnung}, Migration V20260911110000), unter RLS.
 *
 * <p>Dieselbe Mechanik wie {@link AnlageStandortRepository}, Vertrag
 * {@code docs/contracts/v2/ortsbaum-vectors.json} ({@link OrtsbaumAbleitung}):
 * „gültig ab" ist ein Tag, {@code gueltigBis} der LETZTE gültige Tag
 * (einschließlich, {@code null} = offen); erst {@link #beenden}, dann
 * {@link #zuordnen} — umgekehrt lehnt das Überlappungsverbot ab. Je Zeile genau
 * EIN Elternknoten: ein Standort ODER ein Gebäude; dass ein Gebäude nur an
 * einem Standort und ein Bereich nie an einem Bereich hängt, hält die Datenbank
 * selbst (Fremdschlüssel über die Art).
 *
 * <p>Welche Einträge erlaubt sind (das Ziel besteht an jedem Tag, nicht der
 * bisherige Elternknoten, nicht vor dem ersten Intervall …), prüft der
 * Schreibweg mit {@link OrtsbaumAbleitung}, bevor er hier schreibt (IP-5/IP-12).
 * Eine Zeile wird nie gelöscht und nie umgeschrieben: die App-Rolle darf nur
 * {@code gueltig_bis} und {@code aufgehoben_am} ändern.
 */
@Repository
public class OrtZuordnungRepository {

    private static final String SELECT = "SELECT id, ort_id, eltern_standort_id, eltern_ort_id, "
            + "gueltig_ab, gueltig_bis, aufgehoben_am FROM ort_zuordnung ";

    private final JdbcTemplate jdbc;

    public OrtZuordnungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Genau eines von {@code elternStandortId} / {@code elternOrtId} ist gesetzt. */
    public record Zuordnung(UUID id, UUID ortId, UUID elternStandortId, UUID elternOrtId,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant aufgehobenAm) {

        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }

        /** Der Elternknoten, gleich welcher Art. */
        public UUID eltern() {
            return elternStandortId != null ? elternStandortId : elternOrtId;
        }
    }

    /**
     * Hängt einen Ort ab {@code gueltigAb} an einen Standort ({@code elternStandortId})
     * ODER an ein Gebäude ({@code elternOrtId}) — genau einer der beiden.
     */
    public UUID zuordnen(UUID tenantId, UUID ortId, UUID elternStandortId, UUID elternOrtId,
            LocalDate gueltigAb, LocalDate gueltigBis, String createdBy) {
        return jdbc.queryForObject("INSERT INTO ort_zuordnung (tenant_id, ort_id, "
                + "eltern_standort_id, eltern_ort_id, gueltig_ab, gueltig_bis, created_by) "
                + "VALUES (?,?,?,?,?,?,?) RETURNING id",
                UUID.class, tenantId, ortId, elternStandortId, elternOrtId, gueltigAb, gueltigBis,
                createdBy);
    }

    /** Beendet ein (nicht aufgehobenes) Intervall am Tag {@code gueltigBis}, einschließlich. */
    public boolean beenden(UUID id, LocalDate gueltigBis) {
        return jdbc.update("UPDATE ort_zuordnung SET gueltig_bis = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", gueltigBis, id) == 1;
    }

    /** Hebt ein Intervall auf (Korrektur): es bleibt lesbar, belegt aber keinen Tag mehr. */
    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE ort_zuordnung SET aufgehoben_am = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", Timestamp.from(am), id) == 1;
    }

    /** Alle Intervalle eines Orts, aufgehobene eingeschlossen, nach Beginn. */
    public List<Zuordnung> fuerOrt(UUID ortId) {
        return List.copyOf(jdbc.query(SELECT + "WHERE ort_id = ? ORDER BY gueltig_ab, created_at, id",
                OrtZuordnungRepository::map, ortId));
    }

    /**
     * Alle Intervalle des Mandanten, aufgehobene eingeschlossen — EIN Lesezug
     * für das Standort-Lesemodell (IP-3), statt einer Abfrage je Ort.
     */
    public List<Zuordnung> alle() {
        return List.copyOf(jdbc.query(SELECT + "ORDER BY ort_id, gueltig_ab, created_at, id",
                OrtZuordnungRepository::map));
    }

    private static Zuordnung map(ResultSet rs, int n) throws SQLException {
        Timestamp aufgehoben = rs.getTimestamp("aufgehoben_am");
        return new Zuordnung(
                rs.getObject("id", UUID.class),
                rs.getObject("ort_id", UUID.class),
                rs.getObject("eltern_standort_id", UUID.class),
                rs.getObject("eltern_ort_id", UUID.class),
                rs.getObject("gueltig_ab", LocalDate.class),
                rs.getObject("gueltig_bis", LocalDate.class),
                aufgehoben == null ? null : aufgehoben.toInstant());
    }
}
