package com.voltpilot.api.uems;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Änderungsprotokoll der Messstelle ({@code messstelle_aenderung}, Migration
 * V20260911140000) — append-only, unter RLS, gebaut wie {@link OrtAenderungRepository}.
 *
 * <p>Einträge werden nie geändert oder gelöscht — das hält ein Trigger an der
 * Datenbankgrenze, nicht diese Klasse. {@code art} ist ein Code des CHECKs der Migration;
 * {@code alt}/{@code neu} sind JSON und tragen bei „bearbeitet" nur die geänderten Felder.
 * {@code giltAb} steht auf der Minute (E2), {@code rueckwirkend} rechnet der Schreiber.
 * Der Urheber im Akteur-Vokabular von AP-03: {@code actorSub} {@code null} = VoltPilot
 * selbst (dann {@code actorArt} „voltpilot"); {@code actorName} sagt es immer.
 */
@Repository
public class MessstelleAenderungRepository {

    private final JdbcTemplate jdbc;

    public MessstelleAenderungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record NeuerEintrag(UUID tenantId, UUID messstelleId, String art, String altJson,
            String neuJson, Instant giltAb, boolean rueckwirkend, String grund, String actorSub,
            String actorName, String actorRolle, String actorArt) {}

    public record Eintrag(long id, UUID messstelleId, String art, String altJson, String neuJson,
            Instant giltAb, boolean rueckwirkend, String grund, String actorSub, String actorName,
            String actorRolle, String actorArt, Instant createdAt) {}

    public long eintragen(NeuerEintrag e) {
        return jdbc.queryForObject("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, "
                + "alt, neu, gilt_ab, rueckwirkend, grund, actor_sub, actor_name, actor_rolle, "
                + "actor_art) VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?) RETURNING id",
                Long.class, e.tenantId(), e.messstelleId(), e.art(), e.altJson(), e.neuJson(),
                Timestamp.from(e.giltAb()), e.rueckwirkend(), e.grund(), e.actorSub(),
                e.actorName(), e.actorRolle(), e.actorArt());
    }

    /** Das Protokoll EINER Messstelle, jüngster Eintrag zuerst — leer für eine fremde. */
    public List<Eintrag> fuerMessstelle(UUID messstelleId) {
        return List.copyOf(jdbc.query("SELECT id, messstelle_id, art, alt::text AS alt, "
                + "neu::text AS neu, gilt_ab, rueckwirkend, grund, actor_sub, actor_name, "
                + "actor_rolle, actor_art, created_at FROM messstelle_aenderung "
                + "WHERE messstelle_id = ? ORDER BY created_at DESC, id DESC",
                (rs, n) -> new Eintrag(
                        rs.getLong("id"),
                        rs.getObject("messstelle_id", UUID.class),
                        rs.getString("art"),
                        rs.getString("alt"),
                        rs.getString("neu"),
                        rs.getTimestamp("gilt_ab").toInstant(),
                        rs.getBoolean("rueckwirkend"),
                        rs.getString("grund"),
                        rs.getString("actor_sub"),
                        rs.getString("actor_name"),
                        rs.getString("actor_rolle"),
                        rs.getString("actor_art"),
                        rs.getTimestamp("created_at").toInstant()),
                messstelleId));
    }
}
