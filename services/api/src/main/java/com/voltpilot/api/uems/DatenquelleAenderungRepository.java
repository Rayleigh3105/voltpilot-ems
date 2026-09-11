package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Protokoll je Datenquelle ({@code data_source_aenderung}, Migration V20260911180000) —
 * append-only, unter RLS, gebaut wie {@link MessstelleAenderungRepository}.
 *
 * <p>Einträge werden nie geändert oder gelöscht — das hält ein Trigger an der
 * Datenbankgrenze, nicht diese Klasse. {@code art} ist ein Code des CHECKs der Migration;
 * {@code alt}/{@code neu} sind JSON. Der Urheber im Akteur-Vokabular von AP-03
 * ({@link ProtokollAkteur}).
 *
 * <p><b>Der Beleg der Prüfung:</b> {@link #letztePruefung} ist die EINE Stelle, aus der eine
 * Zuständigkeit ihr Prüfergebnis bekommt (Vertrag §5 Gründe 11/12) — nie aus der Anfrage.
 */
@Repository
public class DatenquelleAenderungRepository {

    private static final String SPALTEN = "id, data_source_id, art, device_id, ergebnis, "
            + "alt::text AS alt, neu::text AS neu, gilt_ab, actor_sub, actor_name, actor_rolle, "
            + "actor_art, created_at";

    private final JdbcTemplate jdbc;

    public DatenquelleAenderungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record NeuerEintrag(UUID tenantId, UUID dataSourceId, String art, UUID deviceId,
            String ergebnis, String altJson, String neuJson, Instant giltAb, ProtokollAkteur akteur) {}

    public record Eintrag(long id, UUID dataSourceId, String art, UUID deviceId, String ergebnis,
            String altJson, String neuJson, Instant giltAb, String actorSub, String actorName,
            String actorRolle, String actorArt, Instant createdAt) {}

    public long eintragen(NeuerEintrag e) {
        return jdbc.queryForObject("INSERT INTO data_source_aenderung (tenant_id, data_source_id, "
                + "art, device_id, ergebnis, alt, neu, gilt_ab, actor_sub, actor_name, actor_rolle, "
                + "actor_art) VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?) RETURNING id",
                Long.class, e.tenantId(), e.dataSourceId(), e.art(), e.deviceId(), e.ergebnis(),
                e.altJson(), e.neuJson(), Timestamp.from(e.giltAb()), e.akteur().sub(),
                e.akteur().name(), e.akteur().rolle(), e.akteur().art());
    }

    /** Das Protokoll EINER Quelle, jüngster Eintrag zuerst — leer für eine fremde. */
    public List<Eintrag> fuerQuelle(UUID dataSourceId) {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM data_source_aenderung "
                + "WHERE data_source_id = ? ORDER BY id DESC",
                DatenquelleAenderungRepository::map, dataSourceId));
    }

    /**
     * Die jüngste Erreichbarkeitsprüfung dieser Quelle von GENAU dieser Box — oder leer. Welche
     * Adresse sie geprüft hat, steht in {@code neu}; ob das noch die Adresse der Quelle ist,
     * entscheidet der Schreibweg.
     */
    public Optional<Eintrag> letztePruefung(UUID dataSourceId, UUID deviceId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM data_source_aenderung "
                + "WHERE data_source_id = ? AND device_id = ? AND art = 'erreichbarkeit_geprueft' "
                + "ORDER BY id DESC LIMIT 1",
                DatenquelleAenderungRepository::map, dataSourceId, deviceId).stream().findFirst();
    }

    private static Eintrag map(ResultSet rs, int n) throws SQLException {
        return new Eintrag(
                rs.getLong("id"),
                rs.getObject("data_source_id", UUID.class),
                rs.getString("art"),
                rs.getObject("device_id", UUID.class),
                rs.getString("ergebnis"),
                rs.getString("alt"),
                rs.getString("neu"),
                rs.getTimestamp("gilt_ab").toInstant(),
                rs.getString("actor_sub"),
                rs.getString("actor_name"),
                rs.getString("actor_rolle"),
                rs.getString("actor_art"),
                rs.getTimestamp("created_at").toInstant());
    }
}
