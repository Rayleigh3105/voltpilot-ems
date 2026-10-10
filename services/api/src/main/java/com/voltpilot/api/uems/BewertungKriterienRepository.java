package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BewertungKriterienDto.Fassung;
import com.voltpilot.api.web.dto.BewertungKriterienDto.Kriterium;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Mandanten-RLS; alle Schreibwege unter der Unternehmenssperre des Dienstes. */
@Repository
public class BewertungKriterienRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final BewertungKriterienVertrag vertrag;
    public BewertungKriterienRepository(JdbcTemplate jdbc, ObjectMapper json, BewertungKriterienVertrag vertrag) {
        this.jdbc = jdbc; this.json = json; this.vertrag = vertrag;
    }
    public boolean vieraugen(UUID u) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT vieraugen_freigabe FROM unternehmen WHERE id = ?",Boolean.class,u));
    }
    public boolean standortSichtbar(UUID u) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM standort WHERE unternehmen_id = ?)",Boolean.class,u));
    }
    public List<Fassung> fassungen(UUID u) {
        return jdbc.query("SELECT * FROM bewertung_kriterien_fassung WHERE unternehmen_id = ? ORDER BY fassung DESC",(rs,n) -> {
            JsonNode werte;
            List<Kriterium> kriterien;
            try {
                werte = vertrag.ordnen(json.readTree(rs.getString("werte")));
                kriterien = json.readValue(rs.getString("kriterien"),json.getTypeFactory().constructCollectionType(List.class,Kriterium.class));
            }
            catch (JsonProcessingException e) { throw new IllegalStateException("Gespeicherte Kriterien sind ungültig",e); }
            return new Fassung(rs.getInt("fassung"),werte,kriterien,rs.getInt("fassung") == 1 ? "Vorgabe" : "Unternehmen",
                    rs.getObject("gueltig_ab",LocalDate.class),rs.getString("begruendung"),akteur(rs,"actor"),
                    rs.getBoolean("vieraugen"),rs.getString("freigabe_status"),
                    rs.getString("entscheidung_sub") == null ? null : akteur(rs,"entscheidung"),
                    instant(rs,"entschieden_am"),rs.getString("entscheidungs_begruendung"),
                    instant(rs,"created_at"),instant(rs,"aufgehoben_am"));
        },u);
    }
    public void anlegen(UUID u, int nummer, JsonNode werte, String grund, ProtokollAkteur wer, boolean vieraugen, LocalDate tag) {
        String kriterien;
        try { kriterien = json.writeValueAsString(vertrag.kriterien(werte)); }
        catch (JsonProcessingException e) { throw new IllegalStateException("Kriterien können nicht gespeichert werden",e); }
        jdbc.update("""
                INSERT INTO bewertung_kriterien_fassung(tenant_id,unternehmen_id,fassung,werte,kriterien,gueltig_ab,begruendung,
                    actor_sub,actor_name,actor_rolle,actor_art,vieraugen,freigabe_status)
                VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?,?)
                """,TenantContext.get(),u,nummer,werte.toString(),kriterien,vieraugen ? null : tag,grund,
                wer.sub(),wer.name(),wer.rolle(),wer.art(),vieraugen,vieraugen ? "beantragt" : "freigegeben");
    }
    public void aufheben(UUID u) {
        jdbc.update("UPDATE bewertung_kriterien_fassung SET aufgehoben_am = now() "
                + "WHERE unternehmen_id = ? AND freigabe_status = 'freigegeben' AND aufgehoben_am IS NULL",u);
    }
    public void entscheiden(UUID u, int nummer, boolean freigeben, String grund, ProtokollAkteur wer, LocalDate tag) {
        jdbc.update("""
                UPDATE bewertung_kriterien_fassung SET freigabe_status = ?, gueltig_ab = ?, entscheidung_sub = ?,
                    entscheidung_name = ?, entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = now(),
                    entscheidungs_begruendung = ? WHERE unternehmen_id = ? AND fassung = ? AND freigabe_status = 'beantragt'
                """,freigeben ? "freigegeben" : "abgelehnt",freigeben ? tag : null,wer.sub(),wer.name(),wer.rolle(),wer.art(),grund,u,nummer);
    }
    public String schnappschuss(UUID u, int nummer) {
        return jdbc.queryForObject("SELECT to_jsonb(k)::text FROM bewertung_kriterien_fassung k WHERE unternehmen_id = ? AND fassung = ?",
                String.class,u,nummer);
    }
    public void protokoll(UUID u, int nummer, String art, String alt, ProtokollAkteur wer) {
        jdbc.update("""
                INSERT INTO bewertung_aenderung(tenant_id,art,alt,neu,actor_sub,actor_name,actor_rolle,actor_art)
                VALUES (?,?,?::jsonb,?::jsonb,?,?,?,?)
                """,TenantContext.get(),art,alt,schnappschuss(u,nummer),wer.sub(),wer.name(),wer.rolle(),wer.art());
    }
    private static ProtokollAkteur akteur(ResultSet rs, String prefix) throws SQLException {
        return new ProtokollAkteur(rs.getString(prefix+"_sub"),rs.getString(prefix+"_name"),
                rs.getString(prefix+"_rolle"),rs.getString(prefix+"_art"));
    }
    private static Instant instant(ResultSet rs, String name) throws SQLException {
        var t = rs.getTimestamp(name); return t == null ? null : t.toInstant();
    }
}
