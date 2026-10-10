package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BewertungUmfangDto.*;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** AP-16 IP-5: Mandanten-RLS; Schreibtransaktion und Unternehmenssperre gehören dem Dienst. */
@Repository
public class BewertungUmfangRepository {
    public record Fassung(UUID id, int nummer, Speichern inhalt, ProtokollAkteur akteur,
            Instant createdAt, Instant aufgehobenAm) {}
    public record StandortZeile(UUID id, String name) {}
    private final JdbcTemplate jdbc;
    public BewertungUmfangRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<Fassung> fassungen(UUID unternehmen) {
        return jdbc.query("SELECT * FROM bewertung_umfang WHERE unternehmen_id = ? ORDER BY fassung DESC",
                (rs, n) -> new Fassung(rs.getObject("id", UUID.class), rs.getInt("fassung"),
                        new Speichern(rs.getObject("gueltig_ab", LocalDate.class), standortIds(rs.getObject("id", UUID.class)),
                                Arrays.asList((String[]) rs.getArray("traeger").getArray()),
                                ausschluesse(rs.getObject("id", UUID.class)), rs.getString("begruendung")),
                        new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"),
                                rs.getString("actor_rolle"), rs.getString("actor_art")),
                        instant(rs, "created_at"), instant(rs, "aufgehoben_am")), unternehmen);
    }
    public List<StandortZeile> standorte(UUID unternehmen) {
        return jdbc.query("SELECT id, name FROM standort WHERE unternehmen_id = ? ORDER BY name, id",
                (rs, n) -> new StandortZeile(rs.getObject("id", UUID.class), rs.getString("name")), unternehmen);
    }
    public List<Anlage> anlagen(UUID standort, LocalDate am) {
        return jdbc.query("""
                SELECT s.id, s.name FROM anlage_standort a
                JOIN site s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
                WHERE a.standort_id = ? AND a.aufgehoben_am IS NULL
                  AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> ?::date ORDER BY s.name, s.id
                """, (rs, n) -> new Anlage(rs.getObject("id", UUID.class), rs.getString("name")), standort, am);
    }
    public boolean verweisVorhanden(Ausschluss a, UUID unternehmen) {
        String sql = switch (a.art()) {
            case "standort" -> "SELECT EXISTS (SELECT 1 FROM standort WHERE id = ? AND unternehmen_id = ?)";
            case "prozess" -> "SELECT EXISTS (SELECT 1 FROM prozess WHERE id = ? AND unternehmen_id = ?)";
            case "anlage" -> "SELECT EXISTS (SELECT 1 FROM site s JOIN unternehmen u ON u.tenant_id = s.tenant_id WHERE s.id = ? AND u.id = ?)";
            default -> throw new IllegalArgumentException("Unbekannte Ausschlussart");
        };
        return Boolean.TRUE.equals(jdbc.queryForObject(sql, Boolean.class, a.verweis(), unternehmen));
    }
    public boolean anlageSichtbar(UUID id) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM site WHERE id = ?)", Boolean.class, id));
    }
    private List<UUID> standortIds(UUID id) {
        return jdbc.queryForList("SELECT standort_id FROM bewertung_umfang_standort WHERE umfang_id = ? ORDER BY standort_id", UUID.class, id);
    }
    private List<Ausschluss> ausschluesse(UUID id) {
        return jdbc.query("SELECT art, verweis, begruendung FROM bewertung_umfang_ausschluss WHERE umfang_id = ? ORDER BY art, verweis",
                (rs,n) -> new Ausschluss(rs.getString("art"), rs.getObject("verweis", UUID.class), rs.getString("begruendung")), id);
    }
    public UUID anlegen(UUID unternehmen, Fassung vorher, Speichern neu, ProtokollAkteur wer) {
        String alt = vorher == null ? null : schnappschuss(vorher.id());
        if (vorher != null) jdbc.update("UPDATE bewertung_umfang SET aufgehoben_am = now() WHERE id = ? AND aufgehoben_am IS NULL", vorher.id());
        UUID id = UUID.randomUUID();
        jdbc.update(con -> {
            var st = con.prepareStatement("""
                    INSERT INTO bewertung_umfang(id,tenant_id,unternehmen_id,fassung,gueltig_ab,traeger,begruendung,
                        actor_sub,actor_name,actor_rolle,actor_art) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    """);
            st.setObject(1,id); st.setObject(2,TenantContext.get()); st.setObject(3,unternehmen);
            st.setInt(4,vorher == null ? 1 : vorher.nummer()+1); st.setObject(5,neu.gueltigAb());
            st.setArray(6,con.createArrayOf("text",neu.traeger().toArray(String[]::new))); st.setString(7,neu.begruendung());
            st.setString(8,wer.sub()); st.setString(9,wer.name()); st.setString(10,wer.rolle()); st.setString(11,wer.art());
            return st;
        });
        for (UUID standort : neu.standortIds()) jdbc.update(
                "INSERT INTO bewertung_umfang_standort(tenant_id,umfang_id,standort_id) VALUES (?,?,?)",TenantContext.get(),id,standort);
        for (Ausschluss a : neu.ausschluesse()) jdbc.update(
                "INSERT INTO bewertung_umfang_ausschluss(tenant_id,umfang_id,art,verweis,begruendung) VALUES (?,?,?,?,?)",
                TenantContext.get(),id,a.art(),a.verweis(),a.begruendung());
        jdbc.update("""
                INSERT INTO bewertung_aenderung(tenant_id,art,alt,neu,actor_sub,actor_name,actor_rolle,actor_art)
                VALUES (?,?,?::jsonb,?::jsonb,?,?,?,?)
                """, TenantContext.get(),vorher == null ? "umfang_angelegt" : "umfang_geaendert",alt,schnappschuss(id),
                wer.sub(),wer.name(),wer.rolle(),wer.art());
        return id;
    }
    private String schnappschuss(UUID id) {
        return jdbc.queryForObject("""
                SELECT (to_jsonb(u) || jsonb_build_object(
                    'standort_ids', (SELECT coalesce(jsonb_agg(s.standort_id ORDER BY s.standort_id),'[]'::jsonb)
                                    FROM bewertung_umfang_standort s WHERE s.umfang_id=u.id),
                    'ausschluesse', (SELECT coalesce(jsonb_agg(jsonb_build_object('art',a.art,'verweis',a.verweis,
                                    'begruendung',a.begruendung) ORDER BY a.art,a.verweis),'[]'::jsonb)
                                    FROM bewertung_umfang_ausschluss a WHERE a.umfang_id=u.id)))::text
                FROM bewertung_umfang u WHERE u.id = ?
                """, String.class, id);
    }
    private static Instant instant(ResultSet rs,String name) throws SQLException {
        Timestamp t = rs.getTimestamp(name); return t == null ? null : t.toInstant();
    }
}
