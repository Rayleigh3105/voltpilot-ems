package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto.Fassung;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** RLS-Repository der Einstufungs-Fassungen; Änderungen laufen unter einer Sperre des Einsatzes. */
@Repository
public class EnergieeinsatzEinstufungRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public EnergieeinsatzEinstufungRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public boolean vieraugen(UUID unternehmen) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT vieraugen_freigabe FROM unternehmen WHERE id = ?", Boolean.class, unternehmen));
    }

    public void sperren(UUID einsatz) {
        if (jdbc.queryForList("SELECT id FROM energieeinsatz WHERE id = ? FOR UPDATE", UUID.class, einsatz).isEmpty()) {
            throw EnergieeinsatzAbgelehnt.fehlt();
        }
    }

    public List<Fassung> fassungen(UUID einsatz) {
        return jdbc.query("SELECT * FROM energieeinsatz_einstufung WHERE einsatz_id = ? ORDER BY nummer DESC",
                this::fassung, einsatz);
    }

    public Optional<Fassung> beantragt(UUID einsatz) {
        return jdbc.query("SELECT * FROM energieeinsatz_einstufung WHERE einsatz_id = ? "
                + "AND freigabe_status = 'beantragt'", this::fassung, einsatz).stream().findFirst();
    }

    public int naechsteNummer(UUID einsatz) {
        return jdbc.queryForObject("SELECT coalesce(max(nummer), 0) + 1 FROM energieeinsatz_einstufung "
                + "WHERE einsatz_id = ?", Integer.class, einsatz);
    }

    public void vorherigeBeenden(UUID einsatz, LocalDate letzterTag) {
        jdbc.update("UPDATE energieeinsatz_einstufung SET gueltig_bis = ? WHERE einsatz_id = ? "
                + "AND freigabe_status = 'freigegeben' AND gueltig_bis IS NULL", letzterTag, einsatz);
    }

    public void anlegen(UUID einsatz, int nummer, String einstufung, String begruendung, List<String> grund,
            JsonNode herkunft, LocalDate tag, boolean rueckwirkend, ProtokollAkteur wer, boolean vieraugen) {
        jdbc.update("""
                INSERT INTO energieeinsatz_einstufung(tenant_id,einsatz_id,nummer,einstufung,begruendung,herkunft,
                    grund,vorgeschlagen_ab,gueltig_ab,rueckwirkend,actor_sub,actor_name,actor_rolle,actor_art,
                    vieraugen,freigabe_status)
                VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?,?,?)
                """, tenant(), einsatz, nummer, einstufung, begruendung, herkunft.toString(), json(grund), tag,
                vieraugen ? null : tag, rueckwirkend, wer.sub(), wer.name(), wer.rolle(), wer.art(), vieraugen,
                vieraugen ? "beantragt" : "freigegeben");
    }

    public void bestaetigen(UUID einsatz, int nummer, LocalDate tag, ProtokollAkteur wer) {
        jdbc.update("""
                UPDATE energieeinsatz_einstufung SET gueltig_ab = ?, rueckwirkend = false,
                    freigabe_status = 'freigegeben', entscheidung_sub = ?, entscheidung_name = ?,
                    entscheidung_rolle = ?, entscheidung_art = ?, entschieden_am = now()
                WHERE einsatz_id = ? AND nummer = ? AND freigabe_status = 'beantragt'
                """, tag, wer.sub(), wer.name(), wer.rolle(), wer.art(), einsatz, nummer);
    }

    public String schnappschuss(UUID einsatz, int nummer) {
        return jdbc.queryForObject("SELECT to_jsonb(e)::text FROM energieeinsatz_einstufung e "
                + "WHERE einsatz_id = ? AND nummer = ?", String.class, einsatz, nummer);
    }

    public void protokoll(UUID einsatz, int nummer, String art, String alt, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energieeinsatz_aenderung "
                + "(tenant_id,einsatz_id,art,alt,neu,actor_sub,actor_name,actor_rolle,actor_art) "
                + "VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?)", tenant(), einsatz, art, alt,
                schnappschuss(einsatz, nummer), wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    private Fassung fassung(ResultSet rs, int n) throws SQLException {
        try {
            ProtokollAkteur entschieden = rs.getString("entscheidung_sub") == null ? null
                    : akteur(rs, "entscheidung");
            return new Fassung(rs.getInt("nummer"), rs.getString("einstufung"), rs.getString("begruendung"),
                    json.readValue(rs.getString("grund"), new TypeReference<List<String>>() {}),
                    json.readTree(rs.getString("herkunft")), rs.getObject("vorgeschlagen_ab", LocalDate.class),
                    rs.getObject("gueltig_ab", LocalDate.class), rs.getObject("gueltig_bis", LocalDate.class),
                    rs.getBoolean("rueckwirkend"), akteur(rs, "actor"), rs.getBoolean("vieraugen"),
                    rs.getString("freigabe_status"), entschieden, instant(rs, "entschieden_am"),
                    instant(rs, "created_at"));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Gespeicherte Einstufung ist ungültig", e);
        }
    }

    private String json(Object wert) {
        try { return json.writeValueAsString(wert); }
        catch (JsonProcessingException e) { throw new IllegalStateException("Einstufung kann nicht gespeichert werden", e); }
    }

    private static ProtokollAkteur akteur(ResultSet rs, String prefix) throws SQLException {
        return new ProtokollAkteur(rs.getString(prefix + "_sub"), rs.getString(prefix + "_name"),
                rs.getString(prefix + "_rolle"), rs.getString(prefix + "_art"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        var t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static UUID tenant() {
        return Objects.requireNonNull(TenantContext.get(), "Mandant aus TenantContext erforderlich");
    }
}
