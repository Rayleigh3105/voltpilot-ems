package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * AP-16 IP-3: Datenhaltung unter Mandanten-RLS. Alle Änderungen samt Protokoll sind atomar.
 * Die Route (IP-4) prüft zusätzlich Recht und Standort-Sichtbarkeit; Verantwortlichkeit
 * erteilt kein Recht. Unternehmen wird über den unveränderten Prozess gelesen.
 */
@Repository
public class EnergieeinsatzRepository {
    public record Neu(UUID prozessId, String traeger, String name, String wortlaut, String verbraucherWortlaut,
            String verantwortlichSub, LocalDate gueltigAb) {}
    public record Verantwortlicher(String sub, String name, String konto) {}
    public record Zeile(UUID id, String kennzeichen, UUID prozessId, UUID unternehmenId, String traeger,
            String name, String wortlaut, String verbraucherWortlaut, Verantwortlicher verantwortlich,
            String verantwortlichZustand, Instant ohneKontoSeit, LocalDate gueltigAb, LocalDate gueltigBis,
            Instant beendetAm, String beendetGrund, ProtokollAkteur akteur, Instant angelegtAm) {}
    public record Einfluss(UUID bezugsgroesseId, String wortlaut, String art) {}
    public record EinflussZeile(UUID id, UUID bezugsgroesseId, String wortlaut, String art, int position,
            Instant angelegtAm, Instant aufgehobenAm) {}
    public record Aenderung(long id, String art, String alt, String neu, ProtokollAkteur akteur, Instant zeit) {}

    private final JdbcTemplate jdbc;

    public EnergieeinsatzRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String LESEN = """
            SELECT e.*, p.unternehmen_id, b.zustand AS verantwortlich_zustand,
                CASE WHEN b.zustand = 'entfernt' THEN
                    (SELECT max(z.created_at) FROM zugriff_protokoll z
                     WHERE z.tenant_id = e.tenant_id AND z.betroffener_sub = e.verantwortlich_sub
                       AND z.aktion = 'entfernen') END AS ohne_konto_seit
            FROM energieeinsatz e JOIN prozess p ON p.id = e.prozess_id AND p.tenant_id = e.tenant_id
            LEFT JOIN benutzer b ON b.tenant_id = e.tenant_id AND b.sub = e.verantwortlich_sub
            """;
    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getObject("prozess_id", UUID.class),
            rs.getObject("unternehmen_id", UUID.class), rs.getString("traeger"), rs.getString("name"),
            rs.getString("wortlaut"), rs.getString("verbraucher_wortlaut"),
            new Verantwortlicher(rs.getString("verantwortlich_sub"), rs.getString("verantwortlich_name"),
                    rs.getString("verantwortlich_konto")),
            rs.getString("verantwortlich_zustand"), instant(rs, "ohne_konto_seit"),
            rs.getObject("gueltig_ab", LocalDate.class), rs.getObject("gueltig_bis", LocalDate.class),
            instant(rs, "beendet_am"), rs.getString("beendet_grund"), akteur(rs), instant(rs, "created_at"));

    /** Einschließlich beendeter Einsätze: nichts verschwindet. */
    public List<Zeile> jeUnternehmen(UUID unternehmen) {
        return jdbc.query(LESEN + " WHERE p.unternehmen_id = ? ORDER BY e.created_at, e.kennzeichen", ZEILE, unternehmen);
    }

    public List<Zeile> jeProzess(UUID prozess) {
        return jdbc.query(LESEN + " WHERE e.prozess_id = ? ORDER BY e.created_at, e.kennzeichen", ZEILE, prozess);
    }

    public Optional<Zeile> finde(UUID id) {
        return jdbc.query(LESEN + " WHERE e.id = ?", ZEILE, id).stream().findFirst();
    }

    @Transactional
    public UUID anlegen(Neu neu, ProtokollAkteur wer) {
        Verantwortlicher v = verantwortlich(neu.verantwortlichSub());
        UUID id = jdbc.queryForObject("""
                INSERT INTO energieeinsatz (tenant_id, prozess_id, traeger, name, wortlaut, verbraucher_wortlaut,
                    verantwortlich_sub, verantwortlich_name, verantwortlich_konto, gueltig_ab,
                    actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id
                """, UUID.class, tenant(), neu.prozessId(), neu.traeger(), neu.name(), neu.wortlaut(),
                neu.verbraucherWortlaut(), v.sub(), v.name(), v.konto(), neu.gueltigAb(),
                wer.sub(), wer.name(), wer.rolle(), wer.art());
        protokoll(id, "angelegt", null, schnappschuss(id), wer);
        return id;
    }

    @Transactional
    public boolean bearbeiten(UUID id, String name, String wortlaut, String verbraucherWortlaut, ProtokollAkteur wer) {
        String alt = sperren(id);
        if (alt == null) return false;
        jdbc.update("UPDATE energieeinsatz SET name = ?, wortlaut = ?, verbraucher_wortlaut = ? WHERE id = ?",
                name, wortlaut, verbraucherWortlaut, id);
        protokoll(id, "bearbeitet", alt, schnappschuss(id), wer);
        return true;
    }

    @Transactional
    public boolean beenden(UUID id, LocalDate bis, String grund, ProtokollAkteur wer) {
        String alt = sperren(id);
        if (alt == null) return false;
        jdbc.update("UPDATE energieeinsatz SET gueltig_bis = ?, beendet_am = now(), beendet_grund = ? WHERE id = ?",
                bis, grund, id);
        protokoll(id, "beendet", alt, schnappschuss(id), wer);
        return true;
    }

    /** Name und Konto kommen aus dem Mandanten-Benutzerspiegel, nie aus Kundeneingaben. */
    @Transactional
    public boolean verantwortlichenSetzen(UUID id, String sub, ProtokollAkteur wer) {
        String alt = sperren(id);
        if (alt == null) return false;
        Verantwortlicher v = verantwortlich(sub);
        jdbc.update("UPDATE energieeinsatz SET verantwortlich_sub = ?, verantwortlich_name = ?, "
                + "verantwortlich_konto = ? WHERE id = ?", v.sub(), v.name(), v.konto(), id);
        protokoll(id, "verantwortlicher", alt, schnappschuss(id), wer);
        return true;
    }

    /** Ersetzt die aktuelle Liste ohne DELETE; die Vorgänger bleiben mit aufgehoben_am erhalten. */
    @Transactional
    public boolean einflussgroessenErsetzen(UUID id, List<Einfluss> einfluesse, ProtokollAkteur wer) {
        if (sperren(id) == null) return false;
        String alt = einflussSchnappschuss(id);
        jdbc.update("UPDATE energieeinsatz_einflussgroesse SET aufgehoben_am = now() "
                + "WHERE einsatz_id = ? AND aufgehoben_am IS NULL", id);
        for (int i = 0; i < einfluesse.size(); i++) {
            Einfluss e = einfluesse.get(i);
            jdbc.update("INSERT INTO energieeinsatz_einflussgroesse "
                    + "(tenant_id, einsatz_id, bezugsgroesse_id, wortlaut, art, position) VALUES (?,?,?,?,?,?)",
                    tenant(), id, e.bezugsgroesseId(), e.wortlaut(), e.art(), i);
        }
        protokoll(id, "einflussgroessen", alt, einflussSchnappschuss(id), wer);
        return true;
    }

    public List<EinflussZeile> einflussgroessen(UUID id, boolean mitGeschichte) {
        return jdbc.query("SELECT * FROM energieeinsatz_einflussgroesse WHERE einsatz_id = ? "
                + (mitGeschichte ? "" : "AND aufgehoben_am IS NULL ") + "ORDER BY created_at, position, id",
                (rs, n) -> new EinflussZeile(rs.getObject("id", UUID.class), rs.getObject("bezugsgroesse_id", UUID.class),
                        rs.getString("wortlaut"), rs.getString("art"), rs.getInt("position"),
                        instant(rs, "created_at"), instant(rs, "aufgehoben_am")), id);
    }

    public void protokoll(UUID id, String art, String alt, String neu, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energieeinsatz_aenderung "
                + "(tenant_id, einsatz_id, art, alt, neu, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?)", tenant(), id, art, alt, neu,
                wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    public List<Aenderung> aenderungen(UUID id) {
        return jdbc.query("SELECT * FROM energieeinsatz_aenderung WHERE einsatz_id = ? ORDER BY created_at, id",
                (rs, n) -> new Aenderung(rs.getLong("id"), rs.getString("art"), rs.getString("alt"),
                        rs.getString("neu"), akteur(rs), instant(rs, "created_at")), id);
    }

    /** Nur direkte, heute zugeordnete Messstellen, unter deren Standort-RLS. */
    public List<UUID> messstellen(UUID prozess, LocalDate tag) {
        return jdbc.queryForList("SELECT DISTINCT m.id FROM messstelle_prozess p "
                + "JOIN messstelle m ON m.id = p.messstelle_id AND m.tenant_id = p.tenant_id "
                + "WHERE p.prozess_id = ? AND p.gueltig_ab <= ? AND (p.gueltig_bis IS NULL OR p.gueltig_bis >= ?) "
                + "ORDER BY m.id", UUID.class, prozess, tag, tag);
    }

    public boolean verantwortlicherVorhanden(String sub) {
        return !jdbc.queryForList("SELECT sub FROM benutzer WHERE sub = ? AND konto = 'benutzer' "
                + "AND zustand <> 'entfernt' FOR SHARE", String.class, sub).isEmpty();
    }

    public boolean bezugsgroesseVorhanden(UUID id) {
        return !jdbc.queryForList("SELECT id FROM bezugsgroesse WHERE id = ? FOR KEY SHARE", UUID.class, id).isEmpty();
    }

    private Verantwortlicher verantwortlich(String sub) {
        if (sub == null) return new Verantwortlicher(null, null, null);
        return jdbc.queryForObject("SELECT sub, anzeigename, konto FROM benutzer "
                + "WHERE sub = ? AND konto = 'benutzer' AND zustand <> 'entfernt' FOR SHARE",
                (rs, n) -> new Verantwortlicher(rs.getString("sub"), rs.getString("anzeigename"), rs.getString("konto")), sub);
    }

    private String sperren(UUID id) {
        return jdbc.query("SELECT to_jsonb(e)::text FROM energieeinsatz e "
                + "WHERE id = ? AND gueltig_bis IS NULL FOR UPDATE",
                (rs, n) -> rs.getString(1), id).stream().findFirst().orElse(null);
    }

    private String schnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT to_jsonb(e)::text FROM energieeinsatz e WHERE id = ?", String.class, id);
    }

    private String einflussSchnappschuss(UUID id) {
        return jdbc.queryForObject("SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY position), '[]'::jsonb)::text "
                + "FROM energieeinsatz_einflussgroesse e WHERE einsatz_id = ? AND aufgehoben_am IS NULL", String.class, id);
    }

    private static UUID tenant() {
        return Objects.requireNonNull(TenantContext.get(), "Mandant aus TenantContext erforderlich");
    }

    private static ProtokollAkteur akteur(ResultSet rs) throws SQLException {
        return new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                rs.getString("actor_rolle"), rs.getString("actor_art"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
