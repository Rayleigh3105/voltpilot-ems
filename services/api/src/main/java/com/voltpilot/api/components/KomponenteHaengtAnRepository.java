package com.voltpilot.api.components;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die zeitgültigen Eltern-Zuordnungen einer Komponente im Zählerbaum
 * (`komponente_haengt_an`, Migration V20261110220000), unter RLS. Dieselbe
 * Mechanik wie {@code MessstelleZuordnungRepository}: „gültig ab" ist ein Tag,
 * {@code gueltigBis} der LETZTE gültige Tag (einschließlich, {@code null} =
 * offen). Welche Einträge erlaubt sind, urteilt {@link ZaehlerbaumService},
 * bevor er hier schreibt. Eine Zeile wird nie gelöscht und nie umgeschrieben:
 * die App-Rolle darf nur {@code gueltig_bis} und {@code aufgehoben_am} ändern.
 */
@Repository
public class KomponenteHaengtAnRepository {

    private static final String SELECT = "SELECT k.id, k.komponente_id, k.haengt_an, k.gueltig_ab, "
            + "k.gueltig_bis, k.aufgehoben_am, k.created_at FROM komponente_haengt_an k ";
    private static final String ORDNUNG = " ORDER BY k.komponente_id, k.gueltig_ab, k.created_at, k.id";

    private final JdbcTemplate jdbc;

    public KomponenteHaengtAnRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein Zuordnungs-Intervall, aufgehobene eingeschlossen. */
    public record Zuordnung(UUID id, UUID komponenteId, UUID haengtAn, LocalDate gueltigAb,
            LocalDate gueltigBis, Instant aufgehobenAm, Instant createdAt) {
        public boolean aufgehoben() {
            return aufgehobenAm != null;
        }

        public boolean deckt(LocalDate tag) {
            return !gueltigAb.isAfter(tag) && (gueltigBis == null || !tag.isAfter(gueltigBis));
        }
    }

    /** Eine Komponente, wie {@link ZaehlerbaumService} sie für die Regel-Prüfung braucht - auch über Anlagen hinweg (tenant-weit, RLS). */
    public record Komponente(UUID id, UUID siteId, String role, String entityType) {}

    /**
     * Die Komponente zu {@code id}, gleich zu welcher Anlage sie gehört - für den Grund
     * {@code fremde_anlage} muss die Eltern-Komponente erst einmal GEFUNDEN werden, bevor klar
     * ist, ob ihre Anlage passt. {@code null} = unter dem Mandanten der Sitzung keine solche
     * Komponente (RLS).
     */
    public Komponente komponente(UUID id) {
        return jdbc.query("SELECT id, site_id, role, entity_type FROM measurement_point WHERE id = ?",
                (rs, n) -> new Komponente(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                        rs.getString("role"), rs.getString("entity_type")),
                id).stream().findFirst().orElse(null);
    }

    /** Alle Intervalle EINER Komponente, nach Beginn - leer für eine ohne eigene Zeile (hängt an der Wurzel). */
    public List<Zuordnung> fuerKomponente(UUID komponenteId) {
        return List.copyOf(jdbc.query(SELECT + "WHERE k.komponente_id = ?" + ORDNUNG,
                KomponenteHaengtAnRepository::zeile, komponenteId));
    }

    /**
     * Der aktive Baum EINER Anlage am Tag {@code tag}: komponente_id → haengt_an,
     * nur für Komponenten mit einer eigenen (nicht aufgehobenen, an diesem Tag
     * geltenden) Zeile. Eine Komponente ohne Eintrag hier hängt an der Wurzel -
     * die Vorgabe des Berichts.
     */
    public Map<UUID, UUID> aktiverBaum(UUID siteId, LocalDate tag) {
        List<Zuordnung> rows = jdbc.query(SELECT
                + "JOIN measurement_point mp ON mp.id = k.komponente_id "
                + "WHERE mp.site_id = ? AND k.aufgehoben_am IS NULL "
                + "AND k.gueltig_ab <= ? AND (k.gueltig_bis IS NULL OR k.gueltig_bis >= ?)",
                KomponenteHaengtAnRepository::zeile, siteId, tag, tag);
        return rows.stream().collect(Collectors.toMap(Zuordnung::komponenteId, Zuordnung::haengtAn));
    }

    public UUID eintragen(UUID tenantId, UUID komponenteId, UUID haengtAn, LocalDate gueltigAb,
            LocalDate gueltigBis, String createdBy) {
        return jdbc.queryForObject("INSERT INTO komponente_haengt_an (tenant_id, komponente_id, "
                + "haengt_an, gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?) RETURNING id",
                UUID.class, tenantId, komponenteId, haengtAn, gueltigAb, gueltigBis, createdBy);
    }

    /** Beendet ein (nicht aufgehobenes) Intervall am Tag {@code gueltigBis}, einschließlich. */
    public boolean beenden(UUID id, LocalDate gueltigBis) {
        return jdbc.update("UPDATE komponente_haengt_an SET gueltig_bis = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", gueltigBis, id) == 1;
    }

    /** Hebt ein Intervall auf (Korrektur): es bleibt lesbar, belegt aber keinen Tag mehr. */
    public boolean aufheben(UUID id, Instant am) {
        return jdbc.update("UPDATE komponente_haengt_an SET aufgehoben_am = ? "
                + "WHERE id = ? AND aufgehoben_am IS NULL", Timestamp.from(am), id) == 1;
    }

    private static Zuordnung zeile(ResultSet rs, int n) throws SQLException {
        return new Zuordnung(rs.getObject("id", UUID.class), rs.getObject("komponente_id", UUID.class),
                rs.getObject("haengt_an", UUID.class), rs.getObject("gueltig_ab", LocalDate.class),
                rs.getObject("gueltig_bis", LocalDate.class), zeit(rs, "aufgehoben_am"),
                zeit(rs, "created_at"));
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
