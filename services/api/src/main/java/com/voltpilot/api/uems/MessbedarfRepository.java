package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/** P1: RLS-Repository für Messbedarf und sein append-only Änderungsprotokoll. */
@Repository
public class MessbedarfRepository {
    public record Zeile(UUID id, String kennzeichen, UUID einsatzId, String wortlaut, String ort,
            String groesse, LocalDate frist, String zustand, UUID messstelleId, String messstelleKennzeichen,
            String messstelleName, String begruendung, ProtokollAkteur akteur, Instant createdAt, Instant updatedAt) {}
    public record Aenderung(long id, String art, String alt, String neu, ProtokollAkteur akteur, Instant zeit) {}
    public record Planung(UUID einsatzId, String einsatzKennzeichen, String einsatzName) {}

    private static final String LESEN = """
            SELECT b.*, m.kennzeichen AS messstelle_kennzeichen, m.name AS messstelle_name
              FROM messbedarf b
              LEFT JOIN messstelle m ON m.id = b.messstelle_id AND m.tenant_id = b.tenant_id
            """;
    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getObject("einsatz_id", UUID.class),
            rs.getString("wortlaut"), rs.getString("ort"), rs.getString("groesse"),
            rs.getObject("frist", LocalDate.class), rs.getString("zustand"),
            rs.getObject("messstelle_id", UUID.class), rs.getString("messstelle_kennzeichen"),
            rs.getString("messstelle_name"), rs.getString("begruendung"), akteur(rs),
            instant(rs, "created_at"), instant(rs, "updated_at"));

    private final JdbcTemplate jdbc;
    public MessbedarfRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<Zeile> jeEinsatz(UUID einsatzId) {
        return jdbc.query(LESEN + " WHERE b.einsatz_id = ? ORDER BY b.created_at, b.kennzeichen", ZEILE, einsatzId);
    }
    public Optional<Zeile> finde(UUID id) {
        return jdbc.query(LESEN + " WHERE b.id = ?", ZEILE, id).stream().findFirst();
    }
    public List<Zeile> offene() {
        return jdbc.query(LESEN + " WHERE b.zustand = 'offen' ORDER BY b.created_at, b.kennzeichen", ZEILE);
    }

    public UUID anlegen(UUID einsatzId, String wortlaut, String ort, String groesse, LocalDate frist,
            ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO messbedarf (tenant_id, einsatz_id, wortlaut, ort, groesse, frist,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), einsatzId, wortlaut, ort, groesse, frist,
                wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll(id, "erfasst", null, schnappschuss(id), wer);
        return id;
    }

    public boolean bearbeiten(UUID id, String wortlaut, String ort, String groesse, LocalDate frist,
            ProtokollAkteur wer) {
        String alt = sperrenOffen(id);
        if (alt == null) return false;
        jdbc.update("UPDATE messbedarf SET wortlaut=?, ort=?, groesse=?, frist=?, actor_sub=?, actor_name=?, "
                + "actor_rolle=?, actor_art=?, updated_at=now() WHERE id=?", wortlaut, ort, groesse, frist,
                wer.sub(), wer.name(), wer.rolle(), wer.art(), id);
        protokoll(id, "bearbeitet", alt, schnappschuss(id), wer);
        return true;
    }

    public boolean einloesen(UUID id, UUID messstelleId, ProtokollAkteur wer) {
        String alt = sperrenOffen(id);
        if (alt == null) return false;
        jdbc.update("UPDATE messbedarf SET zustand='eingeloest', messstelle_id=?, actor_sub=?, actor_name=?, "
                + "actor_rolle=?, actor_art=?, updated_at=now() WHERE id=?", messstelleId,
                wer.sub(), wer.name(), wer.rolle(), wer.art(), id);
        protokoll(id, "eingeloest", alt, schnappschuss(id), wer);
        return true;
    }

    public boolean verwerfen(UUID id, String begruendung, ProtokollAkteur wer) {
        String alt = sperrenOffen(id);
        if (alt == null) return false;
        jdbc.update("UPDATE messbedarf SET zustand='verworfen', begruendung=?, actor_sub=?, actor_name=?, "
                + "actor_rolle=?, actor_art=?, updated_at=now() WHERE id=?", begruendung,
                wer.sub(), wer.name(), wer.rolle(), wer.art(), id);
        protokoll(id, "verworfen", alt, schnappschuss(id), wer);
        return true;
    }

    public List<Aenderung> aenderungen(UUID id) {
        return jdbc.query("SELECT * FROM messbedarf_aenderung WHERE messbedarf_id=? ORDER BY created_at,id",
                (rs, n) -> new Aenderung(rs.getLong("id"), rs.getString("art"), rs.getString("alt"),
                        rs.getString("neu"), akteur(rs), instant(rs, "created_at")), id);
    }

    public Map<UUID, List<Planung>> planungenJeMessstelle() {
        return jdbc.query("""
                SELECT b.messstelle_id, e.id, e.kennzeichen, e.name
                  FROM messbedarf b JOIN energieeinsatz e
                    ON e.id=b.einsatz_id AND e.tenant_id=b.tenant_id
                 WHERE b.zustand='eingeloest' ORDER BY e.kennzeichen
                """, (rs, n) -> Map.entry(rs.getObject(1, UUID.class), new Planung(rs.getObject(2, UUID.class),
                        rs.getString(3), rs.getString(4)))).stream()
                .collect(Collectors.groupingBy(Map.Entry::getKey, Collectors.mapping(Map.Entry::getValue,
                        Collectors.toList())));
    }

    private String sperrenOffen(UUID id) {
        return jdbc.query("SELECT to_jsonb(b)::text FROM messbedarf b WHERE id=? AND zustand='offen' FOR UPDATE",
                (rs, n) -> rs.getString(1), id).stream().findFirst().orElse(null);
    }
    private String schnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT to_jsonb(b)::text FROM messbedarf b WHERE id=?", String.class, id);
    }
    private void protokoll(UUID id, String art, String alt, String neu, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO messbedarf_aenderung (tenant_id,messbedarf_id,art,alt,neu,actor_sub,actor_name,actor_rolle,actor_art) "
                + "VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?)", tenant(), id, art, alt, neu,
                wer.sub(), wer.name(), wer.rolle(), wer.art());
    }
    private static UUID tenant() { return Objects.requireNonNull(TenantContext.get(), "Mandant erforderlich"); }
    private static ProtokollAkteur akteur(ResultSet rs) throws SQLException {
        return new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                rs.getString("actor_rolle"), rs.getString("actor_art"));
    }
    private static Instant instant(ResultSet rs, String feld) throws SQLException {
        Timestamp t = rs.getTimestamp(feld); return t == null ? null : t.toInstant();
    }
}
