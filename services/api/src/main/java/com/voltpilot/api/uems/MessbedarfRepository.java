package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * P1: RLS-Repository für Messbedarf und sein append-only Änderungsprotokoll. Der strukturierte Ort ist genau einer von
 * {@code standort_id} oder {@code ort_id} (Gebäude/Bereich); seinen Standort heute löst {@link #standorteDerOrte} auf.
 */
@Repository
public class MessbedarfRepository {
    public record Zeile(UUID id, String kennzeichen, UUID einsatzId, String wortlaut, String ort,
            String groesse, LocalDate frist, String zustand, UUID messstelleId, String messstelleKennzeichen,
            String messstelleName, String begruendung, ProtokollAkteur akteur, Instant createdAt, Instant updatedAt,
            UUID standortId, String standortKurzzeichen, String standortName,
            UUID ortId, String ortArt, String ortKurzzeichen, String ortName, String messgroesse, String richtung) {}
    /** Was Erfassen und Bearbeiten schreiben; höchstens einer von {@code standortId} und {@code ortId}. */
    public record Felder(String wortlaut, String ort, String groesse, LocalDate frist,
            UUID standortId, UUID ortId, String messgroesse, String richtung) {}
    /** Ein wählbarer Ort: {@code art} ist {@code standort}, {@code gebaeude} oder {@code bereich}. */
    public record OrtRef(UUID id, String art, String kurzzeichen) {}
    /** Der Standort, an dem ein Gebäude oder Bereich an einem Tag hängt. */
    public record StandortRef(UUID id, String name) {}
    public record Aenderung(long id, String art, String alt, String neu, ProtokollAkteur akteur, Instant zeit) {}
    public record Planung(UUID einsatzId, String einsatzKennzeichen, String einsatzName) {}

    private static final String LESEN = """
            SELECT b.*, m.kennzeichen AS messstelle_kennzeichen, m.name AS messstelle_name,
                   s.kurzzeichen AS standort_kurzzeichen, s.name AS standort_name,
                   o.art AS ort_art, o.kurzzeichen AS ort_kurzzeichen, o.name AS ort_name
              FROM messbedarf b
              LEFT JOIN messstelle m ON m.id = b.messstelle_id AND m.tenant_id = b.tenant_id
              LEFT JOIN standort s ON s.id = b.standort_id AND s.tenant_id = b.tenant_id
              LEFT JOIN ort o ON o.id = b.ort_id AND o.tenant_id = b.tenant_id
            """;
    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getObject("einsatz_id", UUID.class),
            rs.getString("wortlaut"), rs.getString("ort"), rs.getString("groesse"),
            rs.getObject("frist", LocalDate.class), rs.getString("zustand"),
            rs.getObject("messstelle_id", UUID.class), rs.getString("messstelle_kennzeichen"),
            rs.getString("messstelle_name"), rs.getString("begruendung"), akteur(rs),
            instant(rs, "created_at"), instant(rs, "updated_at"),
            rs.getObject("standort_id", UUID.class), rs.getString("standort_kurzzeichen"), rs.getString("standort_name"),
            rs.getObject("ort_id", UUID.class), rs.getString("ort_art"), rs.getString("ort_kurzzeichen"),
            rs.getString("ort_name"), rs.getString("messgroesse"), rs.getString("richtung"));

    private final JdbcTemplate jdbc;
    public MessbedarfRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<Zeile> jeEinsatz(UUID einsatzId) {
        return jdbc.query(LESEN + " WHERE b.einsatz_id = ? ORDER BY b.created_at, b.kennzeichen", ZEILE, einsatzId);
    }
    public Optional<Zeile> finde(UUID id) {
        return jdbc.query(LESEN + " WHERE b.id = ?", ZEILE, id).stream().findFirst();
    }
    public List<Zeile> alle() {
        return jdbc.query(LESEN + " ORDER BY b.created_at, b.kennzeichen", ZEILE);
    }
    public List<Zeile> offene() {
        return jdbc.query(LESEN + " WHERE b.zustand = 'offen' ORDER BY b.created_at, b.kennzeichen", ZEILE);
    }

    public UUID anlegen(UUID einsatzId, Felder f, ProtokollAkteur wer) {
        UUID id = jdbc.queryForObject("""
                INSERT INTO messbedarf (tenant_id, einsatz_id, wortlaut, ort, groesse, frist,
                    standort_id, ort_id, messgroesse, richtung, actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), einsatzId, f.wortlaut(), f.ort(), f.groesse(), f.frist(),
                f.standortId(), f.ortId(), f.messgroesse(), f.richtung(),
                wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll(id, "erfasst", null, schnappschuss(id), wer);
        return id;
    }

    public boolean bearbeiten(UUID id, Felder f, ProtokollAkteur wer) {
        String alt = sperrenOffen(id);
        if (alt == null) return false;
        jdbc.update("UPDATE messbedarf SET wortlaut=?, ort=?, groesse=?, frist=?, standort_id=?, ort_id=?, "
                + "messgroesse=?, richtung=?, actor_sub=?, actor_name=?, actor_rolle=?, actor_art=?, updated_at=now() "
                + "WHERE id=?", f.wortlaut(), f.ort(), f.groesse(), f.frist(), f.standortId(), f.ortId(),
                f.messgroesse(), f.richtung(), wer.sub(), wer.name(), wer.rolle(), wer.art(), id);
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

    /** Ein Standort, Gebäude oder Bereich des Mandanten (RLS); leer, wenn es ihn hier nicht gibt. */
    public Optional<OrtRef> ortRef(UUID id) {
        return jdbc.query("""
                SELECT id, 'standort' AS art, kurzzeichen FROM standort WHERE id = ?
                UNION ALL SELECT id, art, kurzzeichen FROM ort WHERE id = ?
                """, (rs, n) -> new OrtRef(rs.getObject("id", UUID.class), rs.getString("art"),
                        rs.getString("kurzzeichen")), id, id).stream().findFirst();
    }

    /** Gibt es den Standort hier (RLS)? */
    public boolean standortSichtbar(UUID id) {
        return !jdbc.queryForList("SELECT 1 FROM standort WHERE id = ?", Integer.class, id).isEmpty();
    }

    /**
     * Der Standort je Gebäude/Bereich an einem Tag: die Kette seiner wirksamen Zuordnungen hinauf (Tage einschließlich,
     * wie {@code KennzahlRepository.standortVonOrt}). Ein Ort ohne Standort an dem Tag fehlt in der Antwort.
     */
    public Map<UUID, StandortRef> standorteDerOrte(Collection<UUID> orte, LocalDate tag) {
        if (orte.isEmpty()) return Map.of();
        String liste = orte.stream().map(UUID::toString).collect(Collectors.joining(",", "{", "}"));
        Map<UUID, StandortRef> aus = new HashMap<>();
        jdbc.query("""
                WITH RECURSIVE kette (start, eltern_standort_id, eltern_ort_id, tiefe) AS (
                    SELECT z.ort_id, z.eltern_standort_id, z.eltern_ort_id, 0 FROM ort_zuordnung z
                     WHERE z.ort_id = ANY (CAST(? AS uuid[])) AND z.aufgehoben_am IS NULL
                       AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> CAST(? AS date)
                    UNION ALL
                    SELECT k.start, z.eltern_standort_id, z.eltern_ort_id, k.tiefe + 1 FROM ort_zuordnung z
                      JOIN kette k ON z.ort_id = k.eltern_ort_id
                     WHERE z.aufgehoben_am IS NULL AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> CAST(? AS date)
                       AND k.tiefe < 8)
                SELECT DISTINCT ON (k.start) k.start, s.id, s.name
                  FROM kette k JOIN standort s ON s.id = k.eltern_standort_id
                 ORDER BY k.start, k.tiefe
                """, rs -> {
                    aus.put(rs.getObject(1, UUID.class), new StandortRef(rs.getObject(2, UUID.class), rs.getString(3)));
                }, liste, tag.toString(), tag.toString());
        return aus;
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
