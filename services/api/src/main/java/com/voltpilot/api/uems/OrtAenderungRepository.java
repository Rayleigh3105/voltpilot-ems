package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Änderungsprotokoll der Ortsstruktur ({@code ort_aenderung}, Migration
 * V20260911100000) — append-only, unter RLS.
 *
 * <p>Jede Änderung schreibt genau EINEN Eintrag (AP-02 Regel 14); Einträge
 * werden nie geändert oder gelöscht — das hält ein Trigger an der
 * Datenbankgrenze, nicht diese Klasse. {@code art} und {@code objektArt} sind
 * die Codes des CHECKs der Migration; {@code alt}/{@code neu} sind JSON und
 * tragen bei „bearbeitet" nur die geänderten Felder. {@code rueckwirkend}
 * rechnet der Schreiber mit {@link OrtsbaumAbleitung} (gilt ab vor dem
 * Eintragstag in der Zeitzone des Standorts, E2).
 */
@Repository
public class OrtAenderungRepository {

    private final JdbcTemplate jdbc;

    public OrtAenderungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** {@code akteurSub} {@code null} = VoltPilot selbst; {@code akteurName} sagt es immer. */
    public record NeuerEintrag(UUID tenantId, String objektArt, UUID objektId, String art,
            String altJson, String neuJson, LocalDate giltAb, boolean rueckwirkend,
            String akteurSub, String akteurName) {}

    public record Eintrag(long id, String objektArt, UUID objektId, String art, String altJson,
            String neuJson, LocalDate giltAb, boolean rueckwirkend, String akteurSub,
            String akteurName, Instant createdAt) {}

    /** Ein Archiv-Schritt eines Objekts: {@code archiviert} oder {@code wiederhergestellt}, ab {@code giltAb}. */
    public record ArchivSchritt(UUID objektId, String art, LocalDate giltAb) {}

    public static final String ARCHIVIERT = "archiviert";
    public static final String WIEDERHERGESTELLT = "wiederhergestellt";

    /**
     * Ein Eintrag, der zum Protokoll eines Standorts gehören KANN (AP-02 IP-14) — nur, was das
     * Urteil in {@link OrtProtokollUmfang} braucht. {@code anlageId} ist {@code neu.anlage_id}: der
     * Umzug einer Anlage (IP-11) schreibt ihn am Standort, damit der Eintrag an der Anlage selbst
     * dort nicht ein zweites Mal erscheint.
     */
    public record Kandidat(long id, String objektArt, UUID objektId, LocalDate giltAb, Instant eingetragenAm,
            String anlageId) {}

    /**
     * Die Kandidaten des Protokolls EINES Standorts: seine eigenen Einträge und die aller Gebäude,
     * Bereiche und Anlagen des Kundenbereichs — welche davon wirklich dazugehören, entscheidet der
     * Ortsbaum ({@link OrtProtokollUmfang}), nicht diese Abfrage.
     */
    public List<Kandidat> kandidatenDesStandorts(UUID standortId) {
        return List.copyOf(jdbc.query("SELECT id, objekt_art, objekt_id, gilt_ab, created_at, "
                + "neu->>'anlage_id' AS anlage_id FROM ort_aenderung "
                + "WHERE objekt_art IN ('gebaeude', 'bereich', 'anlage') "
                + "OR (objekt_art = 'standort' AND objekt_id = ?)",
                (rs, n) -> new Kandidat(
                        rs.getLong("id"),
                        rs.getString("objekt_art"),
                        rs.getObject("objekt_id", UUID.class),
                        rs.getObject("gilt_ab", LocalDate.class),
                        rs.getTimestamp("created_at").toInstant(),
                        rs.getString("anlage_id")),
                standortId));
    }

    /**
     * Die Archiv-Schritte aller Objekte einer Art, in der Reihenfolge des Schreibens —
     * daraus liest das Standort-Lesemodell die Lücken zwischen Archivieren und
     * Wiederherstellen (ein Standort hat kein eigenes Intervall).
     */
    public List<ArchivSchritt> archivVerlauf(String objektArt) {
        return List.copyOf(jdbc.query("SELECT objekt_id, art, gilt_ab FROM ort_aenderung "
                + "WHERE objekt_art = ? AND art IN ('" + ARCHIVIERT + "', '" + WIEDERHERGESTELLT + "') "
                + "ORDER BY created_at, id",
                (rs, n) -> new ArchivSchritt(rs.getObject("objekt_id", UUID.class), rs.getString("art"),
                        rs.getObject("gilt_ab", LocalDate.class)),
                objektArt));
    }

    public long eintragen(NeuerEintrag e) {
        Long id = jdbc.queryForObject("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, "
                + "art, alt, neu, gilt_ab, rueckwirkend, akteur_sub, akteur_name) "
                + "VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?,?) RETURNING id",
                Long.class, e.tenantId(), e.objektArt(), e.objektId(), e.art(), e.altJson(),
                e.neuJson(), e.giltAb(), e.rueckwirkend(), e.akteurSub(), e.akteurName());
        return id;
    }

    /** Das Protokoll EINES Objekts, jüngster Eintrag zuerst — leer für ein fremdes Objekt. */
    public List<Eintrag> fuerObjekt(String objektArt, UUID objektId) {
        return List.copyOf(jdbc.query("SELECT id, objekt_art, objekt_id, art, alt::text AS alt, "
                + "neu::text AS neu, gilt_ab, rueckwirkend, akteur_sub, akteur_name, created_at "
                + "FROM ort_aenderung WHERE objekt_art = ? AND objekt_id = ? "
                + "ORDER BY created_at DESC, id DESC",
                (rs, n) -> new Eintrag(
                        rs.getLong("id"),
                        rs.getString("objekt_art"),
                        rs.getObject("objekt_id", UUID.class),
                        rs.getString("art"),
                        rs.getString("alt"),
                        rs.getString("neu"),
                        rs.getObject("gilt_ab", LocalDate.class),
                        rs.getBoolean("rueckwirkend"),
                        rs.getString("akteur_sub"),
                        rs.getString("akteur_name"),
                        rs.getTimestamp("created_at").toInstant()),
                objektArt, objektId));
    }
}
